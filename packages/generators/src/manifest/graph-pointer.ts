import type { GraphPointer } from '../contracts/manifest.js';

/**
 * Graph pointer resolution.
 *
 * A pointer like `/52:31/inputs/value` addresses a literal input inside a backend graph. The spec requires
 * that manifest loading validate every pointer and, on failure, **name the broken one** — the justification
 * being that "where is my tool" debugging otherwise costs hours.
 *
 * This layer is deliberately ignorant of what a graph *means*. It walks JSON by segments and reports
 * whether a path exists. Interpreting node classes and input semantics is the backend's job, which is what
 * lets a second backend arrive without touching the manifest layer.
 */

export type PointerSegment = string;

export interface PointerResolution {
  readonly pointer: GraphPointer;
  readonly exists: boolean;
  /** The value found, when it exists. */
  readonly value?: unknown;
  /**
   * The deepest segment that did resolve, when it does not.
   *
   * Reported so an error can say "`/52:31/inputs` exists but has no `value`" rather than only that the
   * whole pointer failed — which is the difference between a two-second fix and a hunt through the graph.
   */
  readonly resolvedPrefix?: string;
  readonly failedSegment?: string;
}

export class PointerSyntaxError extends Error {
  constructor(pointer: string, reason: string) {
    super(`invalid graph pointer ${JSON.stringify(pointer)}: ${reason}`);
    this.name = 'PointerSyntaxError';
  }
}

/**
 * Splits a pointer into segments.
 *
 * JSON Pointer escaping is honoured (`~1` for `/`, `~0` for `~`) so a node whose id contains a slash is
 * addressable. Node ids in the supplied graphs contain colons (`52:31`), which need no escaping and are
 * left alone.
 */
export function parsePointer(pointer: GraphPointer): readonly PointerSegment[] {
  if (pointer === '') throw new PointerSyntaxError(pointer, 'a pointer must not be empty');
  if (!pointer.startsWith('/')) {
    throw new PointerSyntaxError(pointer, 'a pointer must start with "/"');
  }

  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Resolves a pointer against a parsed graph.
 *
 * Never throws for a missing path — a broken pointer is an expected condition when a graph is edited
 * outside the app, and it must produce a reportable result rather than an exception that stops the whole
 * registry from loading.
 */
export function resolvePointer(graph: unknown, pointer: GraphPointer): PointerResolution {
  let segments: readonly PointerSegment[];
  try {
    segments = parsePointer(pointer);
  } catch {
    return { pointer, exists: false, failedSegment: pointer };
  }

  let current: unknown = graph;
  const walked: string[] = [];

  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return {
        pointer,
        exists: false,
        resolvedPrefix: `/${walked.join('/')}`,
        failedSegment: segment,
      };
    }

    const container = current as Record<string, unknown>;
    // `in` rather than an undefined check: a graph input legitimately holding `null` or `undefined` still
    // exists, and reporting it as missing would send the user looking for a node that is right there.
    if (!(segment in container)) {
      return {
        pointer,
        exists: false,
        resolvedPrefix: walked.length === 0 ? '/' : `/${walked.join('/')}`,
        failedSegment: segment,
      };
    }

    current = container[segment];
    walked.push(segment);
  }

  return { pointer, exists: true, value: current };
}

/** A readable explanation of a failed resolution, for the registry's status reason. */
export function describeResolution(resolution: PointerResolution): string {
  if (resolution.exists) return `${resolution.pointer} resolves`;
  if (resolution.resolvedPrefix === undefined) {
    return `${resolution.pointer} is not a valid pointer`;
  }
  return `${resolution.pointer} does not resolve: ${resolution.resolvedPrefix} has no "${resolution.failedSegment}"`;
}

/**
 * Writes a value at a pointer, returning a new graph.
 *
 * Immutable: patching must not mutate the loaded graph, because the same parsed graph is reused for every
 * run of a generator. A mutating patch would make the second run inherit the first run's parameters, which
 * is the kind of bug that only appears once someone renders twice.
 */
export function patchPointer(graph: unknown, pointer: GraphPointer, value: unknown): unknown {
  const segments = parsePointer(pointer);
  return patchSegments(graph, segments, value);
}

function patchSegments(target: unknown, segments: readonly PointerSegment[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;

  const container =
    target !== null && typeof target === 'object' ? { ...(target as Record<string, unknown>) } : {};
  container[head] = patchSegments(container[head], rest, value);
  return container;
}

/**
 * Substitutes `{key}` placeholders in an `also` template.
 *
 * The spec's example is an fps value appearing inside a length-calculation expression as well as as a
 * literal. An unknown placeholder is left verbatim rather than replaced with an empty string: an
 * expression with a visible `{typo}` in it fails loudly at the backend, where a silently emptied one
 * produces a subtly wrong result nobody traces back to the manifest.
 */
export function applyTemplate(
  template: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/** Every pointer a manifest declares, including `also` targets and batch. */
export function collectPointers(manifest: {
  readonly params: readonly {
    readonly bind: GraphPointer | null;
    readonly also?: readonly { readonly pointer: GraphPointer }[];
  }[];
  readonly batch?: { readonly bind: GraphPointer };
}): readonly GraphPointer[] {
  const pointers: GraphPointer[] = [];
  for (const param of manifest.params ?? []) {
    if (param.bind !== null) pointers.push(param.bind);
    for (const also of param.also ?? []) pointers.push(also.pointer);
  }
  if (manifest.batch !== undefined) pointers.push(manifest.batch.bind);
  return pointers;
}

/**
 * Node ids present in a graph.
 *
 * A ComfyUI prompt graph is a flat object keyed by node id, so the top-level keys are the node set. Used to
 * validate that every declared output names a node that exists.
 */
export function graphNodeIds(graph: unknown): readonly string[] {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) return [];
  return Object.keys(graph as Record<string, unknown>);
}

/** Node classes a graph uses, for checking a manifest's `requires` against what is installed. */
export function graphNodeClasses(graph: unknown): readonly string[] {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) return [];
  const classes = new Set<string>();
  for (const node of Object.values(graph as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') continue;
    const classType = (node as { class_type?: unknown }).class_type;
    if (typeof classType === 'string') classes.add(classType);
  }
  return [...classes];
}
