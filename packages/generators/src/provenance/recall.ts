import { type GeneratorManifest, seedParam } from '../contracts/manifest.js';
import type { AssetProvenance } from './asset-provenance.js';

/**
 * Turning a record of what was generated back into a request to generate it.
 *
 * The provenance contract exists so a result is **reproducible** — it records the generator, the
 * preset, the seed and every parameter verbatim, for exactly this purpose. Until this, all of that
 * could only be read: a seed you cannot feed back is a receipt, not a tool.
 *
 * Two uses, and the difference between them is one field. Recalled **with** the seed the run is
 * reproducible: the same graph, the same numbers, the same noise, so the same file. Recalled
 * **without** it, every setting that made a take good is kept and only the seed moves — which is how
 * a variation is asked for, and the far more common of the two.
 *
 * A pure function over the record and the manifest, so what happens when the two disagree is decided
 * once and testable without a panel.
 */

export interface RecalledRun {
  readonly generator: GeneratorManifest['id'];
  /** Only when the manifest still declares it — a preset removed since is dropped rather than sent. */
  readonly preset?: AssetProvenance['preset'];
  /** Parameters the manifest still declares, in the values the run used. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly lockedSeed?: number;
  /**
   * What was in the record but could not be used, named.
   *
   * A manifest is a file a user edits; parameters get renamed and presets get deleted, and a recall
   * that silently dropped three of them would set up a run that is not the one on screen. Saying so
   * is the difference between "this is that take" and "this is some of that take".
   */
  readonly dropped: readonly string[];
}

export interface RecallOptions {
  readonly provenance: AssetProvenance;
  /** The manifest as it is *now*, which is not necessarily the one the run used. */
  readonly manifest: GeneratorManifest;
  /** Keeps the seed, so the run reproduces rather than varies. Defaults to varying. */
  readonly reproduce?: boolean;
}

export function recallRun(options: RecallOptions): RecalledRun {
  const { provenance, manifest } = options;

  const declared = new Set(manifest.params.map((param) => param.key));
  const params: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(provenance.params)) {
    if (declared.has(key)) params[key] = value;
    else dropped.push(key);
  }

  /*
   * Reproducing writes the seed into the parameters as well as pinning it.
   *
   * The record keeps the seed in its own field rather than among the parameters, so recalling one
   * without this left the lock engaged and the seed *field* showing its default — the run would have
   * used the right number while the panel said `0`. A control that disagrees with what will happen is
   * worse than one that is missing.
   */
  const seedKey = seedParam(manifest)?.key;
  if (options.reproduce === true && provenance.seed !== undefined && seedKey !== undefined) {
    params[seedKey] = provenance.seed;
  }

  // A preset the manifest no longer declares would pin parameters that no longer exist, and the panel
  // would show a preset selected that it cannot describe.
  const keepPreset =
    provenance.preset !== undefined && manifest.presets.some((entry) => entry.id === provenance.preset);
  if (provenance.preset !== undefined && !keepPreset) dropped.push(`preset ${provenance.preset}`);

  return {
    generator: manifest.id,
    ...(keepPreset ? { preset: provenance.preset } : {}),
    params,
    ...(options.reproduce === true && provenance.seed !== undefined ? { lockedSeed: provenance.seed } : {}),
    dropped,
  };
}

/** Whether a record can be recalled at all: the generator it names has to still be installed. */
export function isRecallable(provenance: AssetProvenance, manifests: readonly GeneratorManifest[]): boolean {
  return manifests.some((manifest) => manifest.id === provenance.generator);
}
