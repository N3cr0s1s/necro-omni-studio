import type { AssetPath, GeneratorId, JobRunId, PresetId, Result } from '@nos/core';
import { err, ok } from '@nos/core';

/**
 * What made a generated file.
 *
 * Generated output arrives named after a job id — `ad0eb912-5bf6-4d40…` — which is exactly as much
 * use as no name at all. The clip that used it carries provenance, but the *file* did not, so a
 * result you liked was untraceable the moment it was not on the timeline: you could not tell which
 * generator made it, when, or with what prompt, and therefore could not make another like it.
 *
 * Recorded as a sidecar file beside the output rather than in a project-wide index, and that choice
 * is the spec's model rather than convenience. A project *is* a folder: copy a generated file
 * somewhere else and its provenance goes with it; delete it and nothing is left dangling; open the
 * folder in any text editor and the record is readable. An index would be a second source of truth
 * about files the user can move, and it would be wrong within a day.
 *
 * The parameters are stored whole. Which of them mattered is a judgement this layer cannot make —
 * a prompt obviously matters, and so does a step count nobody looked at when the result was good.
 */

/** Suffix that makes a file a provenance record. Deliberately visible, deliberately JSON. */
export const PROVENANCE_SUFFIX = '.nos.json';

export interface AssetProvenance {
  /** The generated file this describes, project-relative. */
  readonly asset: AssetPath;
  readonly generator: GeneratorId;
  /** The manifest's display name at the time, so a renamed or removed generator still reads. */
  readonly generatorName: string;
  readonly backend: string;
  readonly preset?: PresetId;
  readonly run: JobRunId;
  readonly seed?: number;
  /** ISO-8601. Display only, never used for ordering or invalidation. */
  readonly createdAt: string;
  /** Everything the run was given, verbatim. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/** Where the record for a generated file lives. */
export function provenancePath(asset: AssetPath | string): string {
  return `${asset}${PROVENANCE_SUFFIX}`;
}

export function isProvenanceRecord(path: string): boolean {
  return path.endsWith(PROVENANCE_SUFFIX);
}

/** The file a record describes, for the reverse lookup a browser needs. */
export function assetForProvenance(path: string): string | undefined {
  return isProvenanceRecord(path) ? path.slice(0, -PROVENANCE_SUFFIX.length) : undefined;
}

/**
 * Written with indentation.
 *
 * These sit in the user's own project folder next to files they will open by hand, and a minified
 * blob there reads as something the application would rather you did not look at.
 */
export function serializeProvenance(record: AssetProvenance): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export type ProvenanceError =
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'incomplete'; readonly missing: readonly string[] };

/**
 * Reads a record back, tolerantly.
 *
 * A record written by an older version, or edited by hand, must not take the browser down with it —
 * the file it describes is still perfectly usable, and the worst acceptable outcome is that the
 * panel says nothing rather than that the panel breaks. Unknown fields survive round-tripping
 * because they are simply not looked at.
 */
export function parseProvenance(text: string): Result<AssetProvenance, ProvenanceError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err({ kind: 'unreadable', detail: cause instanceof Error ? cause.message : String(cause) });
  }

  if (parsed === null || typeof parsed !== 'object') {
    return err({ kind: 'unreadable', detail: 'not an object' });
  }

  const record = parsed as Record<string, unknown>;
  const missing = ['asset', 'generator', 'run', 'createdAt'].filter(
    (field) => typeof record[field] !== 'string' || record[field] === '',
  );
  if (missing.length > 0) return err({ kind: 'incomplete', missing });

  return ok({
    asset: record['asset'] as AssetPath,
    generator: record['generator'] as GeneratorId,
    generatorName:
      typeof record['generatorName'] === 'string' ? record['generatorName'] : String(record['generator']),
    backend: typeof record['backend'] === 'string' ? record['backend'] : 'unknown',
    ...(typeof record['preset'] === 'string' ? { preset: record['preset'] as PresetId } : {}),
    run: record['run'] as JobRunId,
    ...(typeof record['seed'] === 'number' ? { seed: record['seed'] } : {}),
    createdAt: record['createdAt'] as string,
    params: normalizeParams(record['params']),
  });
}

function normalizeParams(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (value === null || typeof value !== 'object') return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );
  return Object.fromEntries(entries) as Record<string, string | number | boolean>;
}

/**
 * The record as rows for a detail panel, most-identifying first.
 *
 * A list of label/value pairs rather than formatted text, so the panel decides how it looks and this
 * decides only what is worth showing and in what order. The prompt leads when there is one: it is
 * what a user recognises a result by, long before they recognise a seed.
 */
export interface ProvenanceRow {
  readonly label: string;
  readonly value: string;
  /** True for a value worth room to breathe — a prompt rather than a step count. */
  readonly long?: boolean;
}

/** Parameter keys that carry a prompt, in the order they are looked for. */
const PROMPT_KEYS = ['prompt', 'positive_prompt', 'description', 'text'];

export function provenanceRows(record: AssetProvenance): readonly ProvenanceRow[] {
  const rows: ProvenanceRow[] = [{ label: 'generator', value: record.generatorName }];

  const promptKey = PROMPT_KEYS.find(
    (key) => typeof record.params[key] === 'string' && record.params[key] !== '',
  );
  if (promptKey !== undefined) {
    rows.push({ label: 'prompt', value: String(record.params[promptKey]), long: true });
  }

  rows.push({ label: 'made', value: record.createdAt });
  if (record.seed !== undefined) rows.push({ label: 'seed', value: String(record.seed) });
  if (record.preset !== undefined) rows.push({ label: 'preset', value: record.preset });

  // Everything else, so nothing is silently dropped: which parameter mattered is not knowable here,
  // and a panel that showed a chosen few would be hiding the one the user is looking for.
  for (const [key, value] of Object.entries(record.params)) {
    if (key === promptKey) continue;
    rows.push({ label: key, value: String(value) });
  }

  rows.push({ label: 'run', value: record.run });
  return rows;
}
