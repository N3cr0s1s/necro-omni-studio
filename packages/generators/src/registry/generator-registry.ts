import type { GeneratorId, PresetId } from '@nos/core';
import type { GeneratorEntry, GeneratorManifest, ManifestStatus, SurfaceId } from '../contracts/manifest.js';
import { entriesFor, isUnbound, manifestLabel } from '../contracts/manifest.js';
import {
  type PointerResolution,
  collectPointers,
  describeResolution,
  graphNodeIds,
  resolvePointer,
} from '../manifest/graph-pointer.js';

/**
 * The generator registry.
 *
 * The spec is unusually specific here, and for a stated reason: a generator that cannot run must appear in
 * the UI **greyed out with a concrete reason**, never vanish. Silently missing tools turn "where is my
 * generator" into hours of debugging. So validation produces a *status with a reason*, and nothing is ever
 * dropped.
 *
 * Three statuses, matching the spec:
 *
 * - `available` — every pointer resolves, every required node class is installed, every output node exists.
 * - `unavailable` — something is wrong, and `reasons` says exactly what.
 * - `unbound` — the manifest is a contract written before its graph exists. Deliberately distinct from
 *   `unavailable`: nothing is broken, the work simply has not been done, and the UI says so differently.
 */

export interface ValidationContext {
  /** Parsed graph JSON, keyed by the manifest's `graph` filename. */
  readonly graphs: ReadonlyMap<string, unknown>;
  /**
   * Node classes the backend reports as installed, from `capabilities()`.
   *
   * `undefined` means the backend has not been reached yet. Requirements are then *not* checked rather
   * than assumed missing — marking every generator unavailable because the backend is still starting would
   * be worse than briefly optimistic.
   */
  readonly installedNodeClasses?: ReadonlySet<string>;
  /** Backends that exist. A manifest naming an unknown one is unavailable. */
  readonly backends: ReadonlySet<string>;
}

export type UnavailableReason =
  | { readonly kind: 'graph-missing'; readonly graph: string }
  | { readonly kind: 'pointer-unresolved'; readonly detail: string }
  | { readonly kind: 'node-class-missing'; readonly nodeClass: string }
  | { readonly kind: 'output-node-missing'; readonly output: string; readonly node: string }
  | { readonly kind: 'unknown-backend'; readonly backend: string };

export interface RegistryRecord {
  readonly manifest: GeneratorManifest;
  readonly status: ManifestStatus;
  /** Empty when available. Every problem, not just the first. */
  readonly reasons: readonly UnavailableReason[];
  /** UI entries this manifest contributes, one per preset. */
  readonly entries: readonly GeneratorEntry[];
}

export interface GeneratorRegistry {
  all(): readonly RegistryRecord[];
  available(): readonly RegistryRecord[];
  find(id: GeneratorId): RegistryRecord | undefined;
  /** Entries whose manifest declares a surface, for building a context menu. */
  entriesForSurface(surface: SurfaceId): readonly GeneratorEntry[];
  /** Records that cannot run, for a diagnostics panel. */
  problems(): readonly RegistryRecord[];
  manifestFor(id: GeneratorId): GeneratorManifest | undefined;
  presetFor(id: GeneratorId, preset: PresetId): GeneratorManifest['presets'][number] | undefined;
}

/**
 * Validates one manifest against a backend and its graph.
 *
 * Every problem is collected rather than stopping at the first. A manifest with three broken pointers
 * should report three, or fixing them becomes three reload cycles.
 */
export function validateManifest(manifest: GeneratorManifest, context: ValidationContext): RegistryRecord {
  const entries = entriesFor(manifest);

  // An unbound manifest is checked no further: its pointers are `null` by design, and reporting them as
  // broken would bury the one fact that matters — the graph has not been connected yet.
  if (isUnbound(manifest)) {
    return { manifest, status: 'unbound', reasons: [], entries };
  }

  const reasons: UnavailableReason[] = [];

  if (!context.backends.has(manifest.backend)) {
    reasons.push({ kind: 'unknown-backend', backend: manifest.backend });
  }

  const graphName = manifest.graph;
  const graph = graphName === null ? undefined : context.graphs.get(graphName);

  if (graphName !== null && graph === undefined) {
    reasons.push({ kind: 'graph-missing', graph: graphName });
  }

  if (graph !== undefined) {
    for (const pointer of collectPointers(manifest)) {
      const resolution: PointerResolution = resolvePointer(graph, pointer);
      if (!resolution.exists) {
        // The message names the pointer *and* how far it got, which is the difference between a
        // two-second fix and a hunt through the graph.
        reasons.push({ kind: 'pointer-unresolved', detail: describeResolution(resolution) });
      }
    }

    const nodeIds = new Set(graphNodeIds(graph));
    for (const output of manifest.outputs ?? []) {
      if (output.node !== null && !nodeIds.has(output.node)) {
        reasons.push({ kind: 'output-node-missing', output: output.key, node: output.node });
      }
    }
  }

  // Only checked once the backend has actually reported. Assuming absence while it starts would grey out
  // every generator on launch.
  if (context.installedNodeClasses !== undefined) {
    for (const nodeClass of manifest.requires ?? []) {
      if (!context.installedNodeClasses.has(nodeClass)) {
        reasons.push({ kind: 'node-class-missing', nodeClass });
      }
    }
  }

  return {
    manifest,
    status: reasons.length === 0 ? 'available' : 'unavailable',
    reasons,
    entries,
  };
}

export function createGeneratorRegistry(
  manifests: readonly GeneratorManifest[],
  context: ValidationContext,
): GeneratorRegistry {
  const records = manifests.map((manifest) => validateManifest(manifest, context));
  const byId = new Map<string, RegistryRecord>();
  // Later wins on a duplicate id, so a project-local generator shadows one from the global library — the
  // precedence the spec gives project generators.
  for (const record of records) byId.set(record.manifest.id, record);

  return {
    all: () => records,
    available: () => records.filter((record) => record.status === 'available'),
    problems: () => records.filter((record) => record.status !== 'available'),
    find: (id) => byId.get(id),
    manifestFor: (id) => byId.get(id)?.manifest,

    entriesForSurface(surface: SurfaceId): readonly GeneratorEntry[] {
      // Unavailable entries are included on purpose. The UI shows them greyed with their reason; filtering
      // them out here is exactly the disappearing-tool behaviour the spec forbids.
      return records.flatMap((record) =>
        record.entries.filter((entry) => (entry.surfaces ?? []).includes(surface)),
      );
    },

    presetFor(id, preset) {
      return byId.get(id)?.manifest.presets.find((candidate) => candidate.id === preset);
    },
  };
}

/** A one-line reason, for a tooltip on a greyed entry. */
export function describeReason(reason: UnavailableReason): string {
  switch (reason.kind) {
    case 'graph-missing':
      return `the graph file "${reason.graph}" was not found`;
    case 'pointer-unresolved':
      return reason.detail;
    case 'node-class-missing':
      return `the node class "${reason.nodeClass}" is not installed on the backend`;
    case 'output-node-missing':
      return `output "${reason.output}" names node "${reason.node}", which the graph does not contain`;
    case 'unknown-backend':
      return `the backend "${reason.backend}" is not configured`;
    default: {
      const unreachable: never = reason;
      throw new Error(`Unhandled reason ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The full explanation for a record, as the UI shows it on a greyed entry.
 *
 * An unbound manifest gets its own wording, because "not yet connected" and "broken" call for different
 * user responses — one is a to-do, the other is a bug.
 */
export function describeRecord(record: RegistryRecord): string {
  if (record.status === 'available') return `${manifestLabel(record.manifest)} is ready`;
  if (record.status === 'unbound') {
    return `${manifestLabel(record.manifest)}: the graph is not connected yet`;
  }
  return `${manifestLabel(record.manifest)}: ${record.reasons.map(describeReason).join('; ')}`;
}

/** Whether an entry can be run, for enabling a menu item. */
export function isEntryRunnable(registry: GeneratorRegistry, entry: GeneratorEntry): boolean {
  return registry.find(entry.generator)?.status === 'available';
}
