import { type Brand, unsafeBrand } from '../lang/brand.js';

/**
 * Identity for every entity in the document graph.
 *
 * The document is a graph of ids pointing at each other; a `TrackId` accepted where a
 * `ClipId` belongs would typecheck under structural typing and fail at runtime as a
 * missing lookup. Each id therefore gets its own brand, and ids are only minted by the
 * factories here or by the deserializer.
 */
export type ProjectId = Brand<string, 'ProjectId'>;
export type SequenceId = Brand<string, 'SequenceId'>;
export type TrackId = Brand<string, 'TrackId'>;
export type ClipId = Brand<string, 'ClipId'>;
export type TransitionId = Brand<string, 'TransitionId'>;
export type EffectInstanceId = Brand<string, 'EffectInstanceId'>;
export type KeyframeId = Brand<string, 'KeyframeId'>;
export type MaskId = Brand<string, 'MaskId'>;
/** A beat on the story board, per issue #33. Its own brand: a beat is not a clip and not a marker. */
export type StoryBeatId = Brand<string, 'StoryBeatId'>;

/**
 * A path relative to the project folder, using `/` separators on every platform.
 *
 * The spec fixes asset identity as the project-relative path — zipping the folder must
 * move the whole project, which absolute paths would break. Platform separators are
 * normalized on the way in so a project authored on Windows opens on Linux.
 */
export type AssetPath = Brand<string, 'AssetPath'>;

/** Content hash of an asset's bytes. Cache keys derive from this, never from the path. */
export type ContentHash = Brand<string, 'ContentHash'>;

/** Registry identity of a generator, effect or transition, as declared in its manifest. */
export type GeneratorId = Brand<string, 'GeneratorId'>;
export type PresetId = Brand<string, 'PresetId'>;
export type EffectId = Brand<string, 'EffectId'>;

/** Job queue identity: a group is one user request, a run is one variant of it. */
export type JobGroupId = Brand<string, 'JobGroupId'>;
export type JobRunId = Brand<string, 'JobRunId'>;

export class IdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdError';
  }
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new IdError(`${label} must not be empty`);
  }
  return trimmed;
}

export const projectId = (value: string): ProjectId =>
  unsafeBrand<ProjectId>(requireNonEmpty(value, 'ProjectId'));
export const sequenceId = (value: string): SequenceId =>
  unsafeBrand<SequenceId>(requireNonEmpty(value, 'SequenceId'));
export const trackId = (value: string): TrackId => unsafeBrand<TrackId>(requireNonEmpty(value, 'TrackId'));
export const clipId = (value: string): ClipId => unsafeBrand<ClipId>(requireNonEmpty(value, 'ClipId'));
export const transitionId = (value: string): TransitionId =>
  unsafeBrand<TransitionId>(requireNonEmpty(value, 'TransitionId'));
export const effectInstanceId = (value: string): EffectInstanceId =>
  unsafeBrand<EffectInstanceId>(requireNonEmpty(value, 'EffectInstanceId'));
export const keyframeId = (value: string): KeyframeId =>
  unsafeBrand<KeyframeId>(requireNonEmpty(value, 'KeyframeId'));
export const maskId = (value: string): MaskId => unsafeBrand<MaskId>(requireNonEmpty(value, 'MaskId'));
export const storyBeatId = (value: string): StoryBeatId =>
  unsafeBrand<StoryBeatId>(requireNonEmpty(value, 'StoryBeatId'));
export const contentHash = (value: string): ContentHash =>
  unsafeBrand<ContentHash>(requireNonEmpty(value, 'ContentHash'));
export const generatorId = (value: string): GeneratorId =>
  unsafeBrand<GeneratorId>(requireNonEmpty(value, 'GeneratorId'));
export const presetId = (value: string): PresetId =>
  unsafeBrand<PresetId>(requireNonEmpty(value, 'PresetId'));
export const effectId = (value: string): EffectId =>
  unsafeBrand<EffectId>(requireNonEmpty(value, 'EffectId'));
export const jobGroupId = (value: string): JobGroupId =>
  unsafeBrand<JobGroupId>(requireNonEmpty(value, 'JobGroupId'));
export const jobRunId = (value: string): JobRunId =>
  unsafeBrand<JobRunId>(requireNonEmpty(value, 'JobRunId'));

/**
 * Normalizes and validates a project-relative asset path.
 *
 * Rejects absolute paths and any `..` segment: an asset reference that can point
 * outside the project folder breaks the "zip the folder to move the project" guarantee
 * and is a path-traversal hazard once the sidecar starts reading these.
 */
export function assetPath(value: string): AssetPath {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const trimmed = requireNonEmpty(normalized, 'AssetPath');

  if (trimmed.startsWith('/') || /^[a-zA-Z]:\//.test(trimmed)) {
    throw new IdError(`AssetPath must be project-relative, received ${JSON.stringify(value)}`);
  }
  const segments = trimmed.split('/');
  if (segments.includes('..')) {
    throw new IdError(`AssetPath must not escape the project folder: ${JSON.stringify(value)}`);
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw new IdError(`AssetPath must not contain empty segments: ${JSON.stringify(value)}`);
  }
  return unsafeBrand<AssetPath>(trimmed);
}

/** The reserved top-level folders of a project, as fixed by the spec. */
export const PROJECT_FOLDERS = {
  media: 'media',
  generated: 'generated',
  masks: 'masks',
  effects: 'effects',
  generators: 'generators',
  notes: 'notes',
  renders: 'renders',
  cache: 'cache',
} as const;

export type ProjectFolder = (typeof PROJECT_FOLDERS)[keyof typeof PROJECT_FOLDERS];

/** The folder an asset lives under, or `undefined` for a path at the project root. */
export function assetFolder(path: AssetPath): ProjectFolder | undefined {
  const head = path.split('/')[0];
  const known = Object.values(PROJECT_FOLDERS) as readonly string[];
  return head !== undefined && known.includes(head) ? (head as ProjectFolder) : undefined;
}

/**
 * Whether an asset is derived and therefore safe to delete.
 *
 * Only `cache/` qualifies: the spec is explicit that `generated/` has no retention
 * policy and is cleaned by hand, because a rejected variant the user might still want
 * is indistinguishable from garbage to the application.
 */
export function isDerivedAsset(path: AssetPath): boolean {
  return assetFolder(path) === PROJECT_FOLDERS.cache;
}

/**
 * Monotonic id source.
 *
 * Sequential rather than random so a document round-trips byte-identically in tests and
 * diffs of `project.json` stay readable. Uniqueness only has to hold within one
 * document, which a per-document counter guarantees. The prefix records what kind of
 * entity it is, which makes a mis-wired id obvious in a debugger.
 */
export interface IdFactory {
  next(prefix: string): string;
}

export function createIdFactory(seed = 0): IdFactory {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const current = (counters.get(prefix) ?? seed) + 1;
      counters.set(prefix, current);
      return `${prefix}_${String(current).padStart(4, '0')}`;
    },
  };
}
