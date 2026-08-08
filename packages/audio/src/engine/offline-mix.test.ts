import { describe, expect, it, vi } from 'vitest';
import type { AssetPath, ClipId, FrameSpan, TrackId } from '@nos/core';
import type { AudioBufferProvider } from '../contracts/audio-engine.js';
import type { MixPlan, MixSource } from '../contracts/mix-plan.js';
import { type OfflineContextLike, createOfflineMixRenderer, hasAnySource } from './offline-mix.js';

/**
 * Rendering the mix for an export.
 *
 * The arithmetic here is the whole risk. Every value handed to `start` is a number that sounds
 * plausible when wrong: a clip that begins a second late, reads from the wrong place in its file, or
 * stops halfway is not obviously broken to anyone who did not already know what it should sound like.
 */

/** Records what was scheduled, so the numbers can be asserted without an audio device. */
function stubContext(): {
  readonly context: OfflineContextLike;
  readonly started: { at: number; offset: number; duration: number }[];
  readonly gains: { value: number; ramps: { value: number; at: number }[] }[];
  readonly pans: number[];
} {
  const started: { at: number; offset: number; duration: number }[] = [];
  const gains: { value: number; ramps: { value: number; at: number }[] }[] = [];
  const pans: number[] = [];

  const context: OfflineContextLike = {
    destination: {} as AudioNode,
    sampleRate: 48_000,
    createBufferSource: () =>
      ({
        buffer: null,
        playbackRate: { value: 1 },
        connect: () => undefined,
        start: (at: number, offset: number, duration: number) => started.push({ at, offset, duration }),
      }) as unknown as AudioBufferSourceNode,
    createGain: () => {
      const record = { value: 1, ramps: [] as { value: number; at: number }[] };
      gains.push(record);
      return {
        gain: {
          get value() {
            return record.value;
          },
          set value(next: number) {
            record.value = next;
          },
          setValueAtTime: (value: number, at: number) => record.ramps.push({ value, at }),
          linearRampToValueAtTime: (value: number, at: number) => record.ramps.push({ value, at }),
        },
        connect: () => undefined,
      } as unknown as GainNode;
    },
    createStereoPanner: () => {
      const index = pans.push(0) - 1;
      return {
        pan: {
          get value() {
            return pans[index] ?? 0;
          },
          set value(next: number) {
            pans[index] = next;
          },
        },
        connect: () => undefined,
      } as unknown as StereoPannerNode;
    },
    startRendering: () => Promise.resolve({} as AudioBuffer),
  };

  return { context, started, gains, pans };
}

function buffers(resident: readonly string[]): AudioBufferProvider {
  return {
    peek: (asset) => (resident.includes(asset) ? ({} as AudioBuffer) : undefined),
    load: () => Promise.resolve({ ok: true, value: {} as AudioBuffer }) as never,
    prefetch: () => undefined,
  };
}

function source(overrides: Partial<MixSource> = {}): MixSource {
  return {
    clip: 'c1' as ClipId,
    track: 'A1' as TrackId,
    asset: 'media/tone.wav' as AssetPath,
    startSeconds: 0,
    durationSeconds: 2,
    offsetSeconds: 0,
    gain: 1,
    pan: 0,
    speed: 1,
    preservePitch: true,
    gainAutomation: [],
    ...overrides,
  };
}

function plan(sources: readonly MixSource[], startSeconds = 0, endSeconds = 4): MixPlan {
  return { span: {} as FrameSpan, startSeconds, endSeconds, sources };
}

const render = async (
  context: ReturnType<typeof stubContext>,
  plans: readonly MixPlan[],
  resident: readonly string[] = ['media/tone.wav'],
): Promise<void> => {
  const renderer = createOfflineMixRenderer({
    buffers: buffers(resident),
    createContext: () => context.context,
  });
  await renderer.render(plans, 48_000, 2);
};

describe('placing a source in the rendered range', () => {
  it('starts it where it sits on the timeline', async () => {
    const stub = stubContext();
    await render(stub, [plan([source({ startSeconds: 1.5 })])]);
    expect(stub.started[0]?.at).toBeCloseTo(1.5);
  });

  it('makes the range´s own start time zero, for an export of a sub-range', async () => {
    // Exporting frames 300–600 renders a context whose time zero is frame 300. A source at 12 s on a
    // timeline whose export begins at 10 s belongs 2 s into the file, not 12.
    const stub = stubContext();
    await render(stub, [plan([source({ startSeconds: 12 })], 10, 14)]);
    expect(stub.started[0]?.at).toBeCloseTo(2);
  });

  it('reads from where the plan says, which is what makes a straddling clip line up', async () => {
    // A bed starting before the exported range is scheduled at the range start, reading from however
    // far into the file the range begins. Ignoring the offset restarts the music from the top.
    const stub = stubContext();
    await render(stub, [plan([source({ startSeconds: 10, offsetSeconds: 10 })], 10, 14)]);
    expect(stub.started[0]?.at).toBeCloseTo(0);
    expect(stub.started[0]?.offset).toBeCloseTo(10);
  });

  it('never schedules before zero, which a context rejects', async () => {
    const stub = stubContext();
    await render(stub, [plan([source({ startSeconds: 1 })], 5, 9)]);
    expect(stub.started[0]?.at).toBe(0);
  });
});

describe('how much of the source is read', () => {
  it('reads its timeline duration at ordinary speed', async () => {
    const stub = stubContext();
    await render(stub, [plan([source({ durationSeconds: 2 })])]);
    expect(stub.started[0]?.duration).toBeCloseTo(2);
  });

  it('reads twice as much material at double speed', async () => {
    // `start` measures its duration in *source* time, so a retimed clip that ignored the factor would
    // be truncated to half its length — audible as a clip that stops early for no reason.
    const stub = stubContext();
    await render(stub, [plan([source({ durationSeconds: 2, speed: 2 })])]);
    expect(stub.started[0]?.duration).toBeCloseTo(4);
  });
});

describe('level and position', () => {
  it('applies a constant gain directly', async () => {
    const stub = stubContext();
    await render(stub, [plan([source({ gain: 0.25 })])]);
    expect(stub.gains[0]?.value).toBeCloseTo(0.25);
  });

  it('applies the pan', async () => {
    const stub = stubContext();
    await render(stub, [plan([source({ pan: -0.5 })])]);
    expect(stub.pans[0]).toBeCloseTo(-0.5);
  });

  it('schedules automation as ramps, in time order, relative to the range', async () => {
    // A fade rendered as a staircase and auditioned as a ramp is the divergence the shared plan exists
    // to prevent, and it is audible.
    const stub = stubContext();
    await render(stub, [
      plan(
        [
          source({
            gainAutomation: [
              { atSeconds: 12, gain: 1 },
              { atSeconds: 10, gain: 0 },
            ],
          }),
        ],
        10,
        14,
      ),
    ]);
    expect(stub.gains[0]?.ramps).toEqual([
      { value: 0, at: 0 },
      { value: 1, at: 2 },
    ]);
  });
});

describe('what cannot be rendered', () => {
  it('skips a source whose file will not decode rather than failing the export', async () => {
    // One bad file out of forty should cost that clip. An export that refuses outright leaves the user
    // with nothing at all — the same rule the compositor follows for an undecoded frame.
    const stub = stubContext();
    await render(stub, [plan([source(), source({ asset: 'media/broken.wav' as AssetPath })])]);
    expect(stub.started).toHaveLength(1);
  });

  it('renders a range with no sources at all rather than throwing', async () => {
    const created = vi.fn((_channels: number, _frames: number, _rate: number) => stubContext().context);
    const renderer = createOfflineMixRenderer({ buffers: buffers([]), createContext: created });
    await renderer.render([plan([])], 48_000, 2);
    // At least one frame: a context of length zero is rejected outright, and an export of a silent
    // range is a legitimate thing to ask for.
    expect(created.mock.calls[0]?.[1]).toBeGreaterThan(0);
  });
});

describe('knowing whether there is anything to render', () => {
  it('is false for plans with no sources and true once there is one', () => {
    expect(hasAnySource([plan([])])).toBe(false);
    expect(hasAnySource([plan([]), plan([source()])])).toBe(true);
  });
});
