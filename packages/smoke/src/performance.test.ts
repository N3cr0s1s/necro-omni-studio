import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Track,
  type VideoClip,
  type TimelineDocument,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  createDocumentStore,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { moveClip, splitClip, trimClipEnd } from '@nos/editing';
import { buildRenderPlan } from '@nos/compositor';
import { buildMixPlan } from '@nos/audio';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';

/**
 * The timeline interaction budget.
 *
 * The spec fixes a 16 ms frame budget for timeline interaction, and the thing that budget is really about
 * is a *drag*: every mouse move rebuilds a plan, so anything on that path which is accidentally quadratic
 * turns a large project into an unusable one. These guards are deliberately loose — they are there to
 * catch an order-of-magnitude regression, not to police microseconds — and each states the property that
 * makes the operation cheap, so a failure points at the cause rather than at the clock.
 *
 * A wall-clock assertion in a test suite is a compromise: it is noisy on a loaded machine. The thresholds
 * are therefore set roughly ten times above what the operations actually cost, and the structural
 * assertions beside them (untouched tracks kept by reference, plan size proportional to visible clips)
 * are what would fail *first* on a real regression.
 */

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };
const effects = createEffectRegistry(BUILTIN_EFFECTS);

/** A budget generous enough to survive a loaded CI machine, tight enough to catch a quadratic path. */
const BUDGET_MS = 16;

function videoClipAt(index: number): VideoClip {
  const { span, source } = placement(index);
  return {
    kind: 'video',
    id: clipId(`v${index}`),
    span,
    label: `V${index}`,
    enabled: true,
    effects: [],
    source,
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

function audioClipAt(index: number): AudioClip {
  const { span, source } = placement(index);
  return {
    kind: 'audio',
    id: clipId(`a${index}`),
    span,
    label: `A${index}`,
    enabled: true,
    effects: [],
    source,
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  };
}

function placement(index: number) {
  const start = index * 30;
  const span = spanFromBounds(frameIndex(start), frameIndex(start + 25));
  const source = {
    asset: assetPath(`media/shot_${index}.mp4`),
    sourceIn: frameIndex(0),
    sourceRate: FRAME_RATES.WEB_30,
  };

  return { span, source };
}

/** A project of the size the budget is written for: 1000 video clips and 1000 audio clips. */
function largeProject(count = 1000): TimelineDocument {
  const base = createDocument({
    id: projectId('perf'),
    sequenceId: sequenceId('seq'),
    name: 'Perf',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });

  const withClips = base.sequence.tracks.map((track): Track => {
    if (track.kind === 'video') {
      return { ...track, clips: Array.from({ length: count }, (_unused, index) => videoClipAt(index)) };
    }
    if (track.kind === 'audio') {
      return { ...track, clips: Array.from({ length: count }, (_unused, index) => audioClipAt(index)) };
    }
    return track;
  });

  return { ...base, sequence: { ...base.sequence, tracks: withClips } };
}

const document = largeProject();

/** Median of several runs: a single measurement on a loaded machine is mostly noise. */
function medianMs(iterations: number, body: () => void): number {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    body();
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
}

describe('render planning', () => {
  it('builds a frame plan within the interaction budget on a 2000-clip project', () => {
    const elapsed = medianMs(20, () => {
      buildRenderPlan({ document, frame: frameIndex(15_000), effects });
    });
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('plans only what the frame shows, not the whole timeline', () => {
    // The property that makes the budget hold. A plan proportional to the *document* rather than to the
    // frame would still pass a timing check on a small project and fall over on a real one.
    const plan = buildRenderPlan({ document, frame: frameIndex(15_000), effects });
    expect(plan.items.length).toBeLessThanOrEqual(2);
  });

  it('costs the same at the end of the timeline as at the start', () => {
    // A linear scan per frame would make the last clip cost a thousand times the first — the classic
    // shape of a timeline that feels fine while you are building it and unusable once it is finished.
    const first = medianMs(20, () => buildRenderPlan({ document, frame: frameIndex(10), effects }));
    const last = medianMs(20, () => buildRenderPlan({ document, frame: frameIndex(29_990), effects }));

    // Generous: the point is to catch a thousand-fold difference, not a two-fold one.
    expect(last).toBeLessThan(Math.max(first * 20, BUDGET_MS));
  });
});

describe('mix planning', () => {
  it('builds a block plan within the budget', () => {
    const elapsed = medianMs(20, () => {
      buildMixPlan({ document, span: spanFromBounds(frameIndex(15_000), frameIndex(15_060)) });
    });
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('plans only the sources the block can hear', () => {
    const plan = buildMixPlan({ document, span: spanFromBounds(frameIndex(15_000), frameIndex(15_060)) });
    expect(plan.sources.length).toBeLessThanOrEqual(3);
  });
});

describe('editing', () => {
  it('moves a clip within the budget', () => {
    // One mouse-move of a drag. Anything quadratic here is felt immediately.
    const elapsed = medianMs(20, () => {
      moveClip(document, clipId('v500'), TRACKS.video, frameIndex(15_001));
    });
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('rebuilds only the path to the changed clip', () => {
    // This is *why* an edit is cheap, and it is what makes snapshot undo cost pointers rather than a
    // copy of the project. A structural assertion outlives any timing threshold.
    const result = splitClip(document, clipId('v500'), frameIndex(15_010), clipId('v500b'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = document.sequence.tracks;
    const after = result.value.sequence.tracks;
    const untouched = after.filter((track, index) => track === before[index]);

    // The audio and text tracks are untouched, so they must be the *same objects*.
    expect(untouched.length).toBe(before.length - 1);
  });

  it('keeps untouched clips by reference inside the changed track', () => {
    // A delta, not an absolute frame: the operation moves the out-point by that many frames.
    const result = trimClipEnd(document, clipId('v500'), -5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = document.sequence.tracks[0]!.clips;
    const after = result.value.sequence.tracks[0]!.clips;
    const shared = after.filter((clip, index) => clip === before[index]).length;

    // 999 of 1000 unchanged. A copy-everything implementation would share none.
    expect(shared).toBeGreaterThan(before.length - 5);
  });

  it('records an undo step without copying the document', () => {
    const store = createDocumentStore(document);
    const elapsed = medianMs(10, () => {
      store.commit('trim', (current) => {
        const result = trimClipEnd(current, clipId('v500'), -1);
        return result.ok ? result.value : current;
      });
    });
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('undoes within the budget', () => {
    const store = createDocumentStore(document);
    store.commit('trim', (current) => {
      const result = trimClipEnd(current, clipId('v500'), -5);
      return result.ok ? result.value : current;
    });

    const started = performance.now();
    store.undo();
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('the guard itself', () => {
  it('measures a project big enough for the guard to mean something', () => {
    // If this shrinks, every threshold above silently stops testing anything.
    const clips = document.sequence.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    expect(clips).toBe(2000);
  });
});
