import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type VideoClip,
  FRAME_RATES,
  allClips,
  assetPath,
  clipId,
  createDocument,
  createDocumentStore,
  effectId,
  effectInstanceId,
  frameIndex,
  jobRunId,
  loadDocument,
  projectId,
  saveDocument,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { addClipToTrack, moveClip, replaceTrack, splitClip } from '@nos/editing';
import {
  createGeneratorRegistry,
  createJobQueue,
  createMockBackend,
  createGpuSemaphore,
  buildSelection,
  acceptSelection,
  parseManifestFile,
  placeholderLength,
} from '@nos/generators';
import { buildRenderPlan } from '@nos/compositor';
import { buildMixPlan, isSilent } from '@nos/audio';
import { frameCountFor, resolveExportRange } from '@nos/export';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';

/**
 * The end-to-end smoke test.
 *
 * Everything the spec calls a first-class operation, in one pass and in the order a user would do it:
 * open a project, discover a generator from the shipped library, run it, pick a variant, land it on the
 * timeline, edit around it, render a frame, mix the audio, plan an export, save and reload.
 *
 * No GPU, no ComfyUI, no ffmpeg — the mock backend exists precisely so this is possible, and the value of
 * the test is that it crosses **package boundaries**. Each package's own tests prove it behaves; only this
 * one proves the seams line up: that a backend output becomes a clip the compositor will draw, that the
 * clip the editing layer moved is the clip the mix plan hears, and that the whole thing survives a round
 * trip through the project file.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const libraryDir = `${repoRoot}/generators`;

const graphs = new Map<string, unknown>(
  readdirSync(libraryDir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.manifest.json'))
    .map((name) => [name, JSON.parse(readFileSync(`${libraryDir}/${name}`, 'utf8'))]),
);

const manifests = readdirSync(libraryDir)
  .filter((name) => name.endsWith('.manifest.json'))
  .map((name) => {
    const parsed = parseManifestFile(JSON.parse(readFileSync(`${libraryDir}/${name}`, 'utf8')));
    if (!parsed.ok) throw new Error(`${name} did not parse`);
    return parsed.value;
  });

const nodeClassesOf = (graph: unknown): ReadonlySet<string> =>
  new Set(
    Object.values(graph as Record<string, { class_type?: string }>)
      .map((node) => node?.class_type)
      .filter((nodeClass): nodeClass is string => typeof nodeClass === 'string'),
  );

const registry = createGeneratorRegistry(manifests, {
  graphs,
  installedNodeClasses: new Set(manifests.flatMap((m) => [...nodeClassesOf(graphs.get(m.graph ?? ''))])),
  backends: new Set(['comfyui']),
});

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function newProject(): TimelineDocument {
  return createDocument({
    id: projectId('smoke'),
    sequenceId: sequenceId('seq'),
    name: 'Smoke',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
}

function videoClip(id: string, start: number, end: number, asset = 'media/shot.mp4'): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(asset), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  };
}

function place(document: TimelineDocument, track: keyof typeof TRACKS, clip: Clip): TimelineDocument {
  const existing = document.sequence.tracks.find((entry) => entry.id === TRACKS[track]);
  if (existing === undefined) throw new Error(`no ${track} track`);
  return replaceTrack(document, addClipToTrack(existing, clip));
}

describe('a project passes through every subsystem', () => {
  it('runs a generator from the shipped library and lands its output on the timeline', async () => {
    // 1. The library is discovered, not hard-coded. This is the framework's whole claim.
    const record = registry.find(manifests.find((m) => m.id === 'stable_audio_3')!.id);
    expect(record?.status).toBe('available');
    const manifest = record!.manifest;

    // 2. The placeholder is sized from the manifest before the job runs, so the cut is already correct
    //    while the generator works.
    const length = placeholderLength({
      manifest,
      params: { duration_s: 4 },
      frameRate: FRAME_RATES.WEB_30,
    });
    expect(length).toEqual({ frames: 120, known: true });

    // 3. The run goes through the real queue, the real GPU semaphore and a backend that is a shipped
    //    artifact rather than a fixture.
    //
    //    Three outputs from one submit, because this manifest declares `batch`: the graph produces all
    //    three candidates in a single run, which is what the queue plans and what a real ComfyUI run of
    //    this graph returns.
    const backend = createMockBackend({
      outputs: [1, 2, 3].map((index) => ({
        key: 'output',
        type: 'audio' as const,
        path: assetPath(`generated/bed_000${index}.flac`),
      })),
    });
    const queue = createJobQueue({
      backend,
      gpu: createGpuSemaphore(),
      patcher: { patch: () => ({ graph: {}, assets: [] }) },
      nextSeed: (() => {
        let seed = 1000;
        return () => (seed += 1);
      })(),
    });

    const group = queue.enqueue({
      manifest,
      params: { duration_s: 4 },
      target: { kind: 'timeline', track: TRACKS.audio, at: frameIndex(90) },
      variantCount: 3,
    });
    await queue.drain();

    const snapshot = queue.getSnapshot();
    const jobGroup = snapshot.groups.find((entry) => entry.id === group)!;
    expect(jobGroup.status).toBe('complete');

    // 4. The variants are picked in place. Partial results would already be selectable here.
    const selection = buildSelection({
      group: jobGroup,
      runs: snapshot.runs.filter((run) => run.group === group),
      manifest,
    });
    expect(selection.readyCount).toBe(3);

    const outcome = acceptSelection(selection);
    expect(outcome?.kind).toBe('accept');
    if (outcome?.kind !== 'accept') throw new Error('expected an acceptance');

    // 5. The accepted output becomes a clip carrying its provenance — which is what colours it as
    //    generated and what makes the result reproducible later.
    const generated: AudioClip = {
      kind: 'audio',
      id: clipId('gen1'),
      span: spanFromBounds(frameIndex(90), frameIndex(90 + length.frames)),
      label: 'Warehouse drone',
      enabled: true,
      effects: [],
      source: { asset: outcome.output.path, sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
      speed: { factor: 1, preservePitch: true },
      gain: staticNumber(1),
      pan: staticNumber(0),
      provenance: {
        generator: manifest.id,
        run: jobRunId(outcome.run),
        seed: outcome.seed,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    };

    const document = place(place(newProject(), 'video', videoClip('v1', 0, 300)), 'audio', generated);

    // 6. The compositor draws the video, and the mixer hears the generated audio. Different subsystems,
    //    same document, no translation layer between them.
    const effects = createEffectRegistry(BUILTIN_EFFECTS);
    const plan = buildRenderPlan({ document, frame: frameIndex(120), effects });
    expect(plan.items).toHaveLength(1);

    const mix = buildMixPlan({ document, span: spanFromBounds(frameIndex(90), frameIndex(150)) });
    expect(isSilent(mix)).toBe(false);
    expect(mix.sources.some((source) => source.clip === 'gen1')).toBe(true);

    // 7. The export planner sees the same range the document reports — one definition, so "export the
    //    work range" and "loop the work range" cannot disagree.
    const range = resolveExportRange(document);
    expect(frameCountFor(range)).toBe(300);

    // 8. And the whole thing survives a round trip through the project file, provenance included.
    const reloaded = loadDocument(saveDocument(document));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;

    const restored = allClips(reloaded.value.document).find((clip) => clip.id === 'gen1');
    expect(restored?.provenance?.seed).toBe(outcome.seed);
  });

  it('keeps a generated clip intact through an edit and an undo', () => {
    // The seam between the generator framework and the editing layer: a generated clip is an ordinary
    // clip, so every operation applies to it and undo restores it exactly.
    const generated = {
      ...videoClip('gen1', 100, 220, 'generated/take.mp4'),
      provenance: {
        generator: manifests[0]!.id,
        run: jobRunId('r1'),
        seed: 4471,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    };

    const store = createDocumentStore(place(newProject(), 'video', generated));

    store.commit('split', (document) => {
      const result = splitClip(document, clipId('gen1'), frameIndex(160), clipId('gen1b'));
      // Surfaced rather than swallowed: a silently rejected edit would make the assertions below fail
      // with no clue which operation refused.
      if (!result.ok) throw new Error(`split rejected: ${JSON.stringify(result.error)}`);
      return result.value;
    });

    const afterSplit = store.getDocument().sequence.tracks[0]!.clips;
    expect(afterSplit).toHaveLength(2);
    // Both halves keep the provenance: a split does not make half a clip stop being generated.
    expect(afterSplit.every((clip) => clip.provenance?.seed === 4471)).toBe(true);

    store.undo();
    expect(store.getDocument().sequence.tracks[0]!.clips).toHaveLength(1);
  });

  it('rejects an edit that would collide, rather than displacing a neighbour', () => {
    // The rule the whole editing layer is built on, checked here because it is the one a user meets
    // first and the one whose violation is hardest to notice.
    const document = place(
      place(newProject(), 'video', videoClip('a', 0, 100)),
      'video',
      videoClip('b', 100, 200),
    );
    const result = moveClip(document, clipId('b'), TRACKS.video, frameIndex(50));

    expect(result.ok).toBe(false);
  });

  it('reports every unrunnable generator with a reason rather than dropping it', () => {
    // The spec's rule, checked against a backend that has nothing installed: five manifests in, five
    // records out, each explaining itself.
    const empty = createGeneratorRegistry(manifests, {
      graphs,
      installedNodeClasses: new Set(),
      backends: new Set(['comfyui']),
    });

    expect(empty.all()).toHaveLength(manifests.length);
    expect(empty.available()).toHaveLength(0);
    for (const record of empty.problems()) {
      expect(record.reasons.length, record.manifest.id).toBeGreaterThan(0);
    }
  });

  it('keeps usable variants when one of three fails', async () => {
    // `partial` is a first-class outcome. Reporting it as a failure would throw away two good results.
    //
    // The `batch` block is stripped: a batched manifest asks for three variants in **one** submit, so
    // there is no second submit to fail. Sequential is the mode where a single variant can fail on its
    // own, which is the case worth testing.
    const batched = manifests.find((entry) => entry.defaultVariants > 1)!;
    const { batch: _dropped, ...manifest } = batched;
    const queue = createJobQueue({
      backend: createMockBackend({ failSubmitOn: [2] }),
      gpu: createGpuSemaphore(),
      patcher: { patch: () => ({ graph: {}, assets: [] }) },
      nextSeed: (() => {
        let seed = 0;
        return () => (seed += 7);
      })(),
    });

    const group = queue.enqueue({
      manifest,
      params: {},
      target: { kind: 'media-browser' },
      variantCount: 3,
    });
    await queue.drain();

    const snapshot = queue.getSnapshot();
    const jobGroup = snapshot.groups.find((entry) => entry.id === group)!;
    expect(jobGroup.status).toBe('partial');

    const selection = buildSelection({
      group: jobGroup,
      runs: snapshot.runs.filter((run) => run.group === group),
      manifest,
    });
    expect(selection.readyCount).toBe(2);
    expect(acceptSelection(selection)).toBeDefined();
  });

  it('renders a masked effect stack without the compositor knowing what made the mask', () => {
    // The single seam between segmentation and effects: a declared `mask` sampler slot. The plan carries
    // the mask id and nothing else — no SAM-specific anything anywhere in the render path.
    const masked: VideoClip = {
      ...videoClip('v1', 0, 100),
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('background_blur'),
          enabled: true,
          params: { radius: staticNumber(12) },
          mask: 'm1' as never,
        },
      ],
    };

    const document = place(newProject(), 'video', masked);
    const plan = buildRenderPlan({
      document,
      frame: frameIndex(10),
      effects: createEffectRegistry(BUILTIN_EFFECTS),
    });

    const item = plan.items[0];
    expect(item?.kind).toBe('layer');
    if (item?.kind !== 'layer') return;
    expect(item.layer.passes[0]?.mask).toBe('m1');
  });
});
