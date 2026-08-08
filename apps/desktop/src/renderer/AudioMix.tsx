import type { ReactNode } from 'react';
import {
  type AnimatableNumber,
  type AudioClip,
  type Clip,
  type TimelineDocument,
  animatedNumber,
  evaluateAt,
  frameIndex,
  isAnimated,
  keyframeId,
  locateClip,
  staticNumber,
} from '@nos/core';
import { GAIN_FLOOR_DB, dbToGain, formatDb, gainToDb } from '@nos/audio';
import { Button, Mono, SectionCaption } from '@nos/ui';
import { token } from '@nos/ui';

/**
 * Level and pan for an audio clip.
 *
 * The document has carried `gain` and `pan` as animatable parameters since the model was written, the
 * mix graph samples both and the export honours them — and nothing could set either. An audio clip's
 * inspector was empty, which made every audio decision unreachable from the application.
 *
 * Gain is stored linear and shown in **decibels**, because that is the unit the work is done in: "6 dB
 * down" is a thing an editor means, "0.5 gain" is not. The conversion lives at this boundary and
 * nowhere else — the mix plan, the export and the meters all read the linear value.
 */

/**
 * The slider's range.
 *
 * The bottom is the mix graph's own floor, where gain reaches exactly zero, so the control can reach
 * silence rather than approaching it. The top is deliberately modest: 12 dB is enough to lift quiet
 * material, and a range that reached +40 would spend most of its travel in values that only clip.
 */
export const GAIN_RANGE_DB = { min: GAIN_FLOOR_DB, max: 12 } as const;

/** How close to centre still counts as centred, in pan units. */
const PAN_DETENT = 0.02;

export interface AudioMixProps {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  /** The frame the values are shown at, so an animated parameter reads as what is heard now. */
  readonly playhead: number;
  readonly onChange: (label: string, next: TimelineDocument) => void;
}

/**
 * Describes a pan position the way a mixer does.
 *
 * `L`/`R` with a percentage rather than a signed number: a fader marked `−0.35` tells the user the
 * value, `L35` tells them what they will hear.
 */
export function describePan(pan: number): string {
  const clamped = Math.min(1, Math.max(-1, pan));
  if (Math.abs(clamped) <= PAN_DETENT) return 'C';
  const amount = Math.round(Math.abs(clamped) * 100);
  return `${clamped < 0 ? 'L' : 'R'}${amount}`;
}

/** Snaps a pan value to dead centre near the middle, where a fader is hard to place by hand. */
export function snapPan(pan: number): number {
  return Math.abs(pan) <= PAN_DETENT ? 0 : Math.min(1, Math.max(-1, pan));
}

export function clampGainDb(db: number): number {
  if (!Number.isFinite(db)) return GAIN_RANGE_DB.min;
  return Math.min(GAIN_RANGE_DB.max, Math.max(GAIN_RANGE_DB.min, db));
}

export function AudioMix({ document, clip, playhead, onChange }: AudioMixProps): ReactNode {
  if (clip.kind !== 'audio') return null;
  const audio = clip;

  // Sampled at the playhead. For a constant that is the value itself; for an animated one it is what
  // is being heard, which is the only number worth showing beside a transport.
  const gain = evaluateAt(audio.gain, frameIndex(Math.max(0, playhead - audio.span.start)));
  const pan = evaluateAt(audio.pan, frameIndex(Math.max(0, playhead - audio.span.start)));

  const write = (label: string, channel: 'gain' | 'pan', value: AnimatableNumber): void => {
    onChange(label, replaceAudioChannel(document, audio, channel, value));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionCaption>Audio</SectionCaption>

      <Channel
        label="gain"
        readout={formatDb(gain)}
        animated={isAnimated(audio.gain)}
        onToggleAnimation={() =>
          write(
            isAnimated(audio.gain) ? 'un-animate gain' : 'animate gain',
            'gain',
            toggleAnimation(audio.gain, gain, `${audio.id}_gain`),
          )
        }
      >
        <input
          type="range"
          aria-label="Gain in decibels"
          min={GAIN_RANGE_DB.min}
          max={GAIN_RANGE_DB.max}
          step={0.5}
          disabled={isAnimated(audio.gain)}
          value={clampGainDb(gainToDb(gain))}
          onChange={(event) =>
            write('set gain', 'gain', staticNumber(dbToGain(clampGainDb(Number(event.target.value)))))
          }
          style={{ width: '100%' }}
        />
      </Channel>

      <Channel
        label="pan"
        readout={describePan(pan)}
        animated={isAnimated(audio.pan)}
        onToggleAnimation={() =>
          write(
            isAnimated(audio.pan) ? 'un-animate pan' : 'animate pan',
            'pan',
            toggleAnimation(audio.pan, pan, `${audio.id}_pan`),
          )
        }
      >
        <input
          type="range"
          aria-label="Pan"
          min={-1}
          max={1}
          step={0.01}
          disabled={isAnimated(audio.pan)}
          value={pan}
          onChange={(event) => write('set pan', 'pan', staticNumber(snapPan(Number(event.target.value))))}
          style={{ width: '100%' }}
        />
      </Channel>

      {/* Unity is a position a fader has to be able to return to exactly. Dragging back to 0.0 dB by
          hand is a coin flip, and being 0.5 dB off is inaudible until it is summed with everything
          else. */}
      <div style={{ display: 'flex', gap: 6 }}>
        <Button
          disabled={isAnimated(audio.gain)}
          onClick={() => write('reset gain', 'gain', staticNumber(1))}
          title="Return the level to unity"
        >
          0 dB
        </Button>
        <Button
          disabled={isAnimated(audio.pan)}
          onClick={() => write('centre pan', 'pan', staticNumber(0))}
          title="Return the pan to centre"
        >
          centre
        </Button>
      </div>
    </div>
  );
}

function Channel({
  label,
  readout,
  animated,
  onToggleAnimation,
  children,
}: {
  readonly label: string;
  readonly readout: string;
  readonly animated: boolean;
  readonly onToggleAnimation: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: token.textLabel, color: token.textSoft }}>{label}</span>
        <div style={{ flex: 1 }} />
        <Mono tone={animated ? token.accent : token.textBright}>{readout}</Mono>
        {/* Animating is an explicit act, as it is for effect parameters: a value that silently became
            keyframed on first edit would surprise anyone who only meant to change it once. */}
        <Button
          onClick={onToggleAnimation}
          title={animated ? 'Return this to a constant value' : 'Animate this with keyframes'}
        >
          {animated ? 'un-animate' : 'animate'}
        </Button>
      </div>
      {children}
      {animated && (
        <Mono tone={token.textGhost}>edited in the keyframe lane, so one value cannot win over another</Mono>
      )}
    </div>
  );
}

/**
 * Turns a parameter into its animated form and back.
 *
 * Un-animating keeps the value *at the playhead* rather than the first keyframe's: the number the user
 * is looking at when they press the button is the one they mean to keep.
 */
function toggleAnimation(current: AnimatableNumber, valueNow: number, idPrefix: string): AnimatableNumber {
  if (isAnimated(current)) return staticNumber(valueNow);
  return animatedNumber([
    { id: keyframeId(`${idPrefix}_0`), frame: frameIndex(0), value: valueNow, ease: 'linear' },
  ]);
}

/**
 * Writes one channel back into the document.
 *
 * Exported because the keyframe lanes write the same two channels, and two copies of "find the clip,
 * replace one field" would drift the moment either grew a rule.
 */
export function replaceAudioChannel(
  document: TimelineDocument,
  clip: AudioClip,
  channel: 'gain' | 'pan',
  value: AnimatableNumber,
): TimelineDocument {
  const located = locateClip(document, clip.id);
  if (located === undefined) return document;

  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track) =>
        track.id !== located.track.id
          ? track
          : ({
              ...track,
              clips: (track.clips as readonly Clip[]).map((entry) =>
                entry.id === clip.id ? { ...entry, [channel]: value } : entry,
              ),
            } as (typeof document.sequence.tracks)[number]),
      ),
    },
  };
}
