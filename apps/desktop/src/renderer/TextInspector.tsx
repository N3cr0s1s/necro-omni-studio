import { type ReactNode } from 'react';
import {
  type TextAnimation,
  type TextClip,
  type TextContent,
  type TimelineDocument,
  type Track,
  clipId,
  frameIndex,
  locateClip,
  spanFromBounds,
  staticNumber,
} from '@nos/core';
import {
  DEFAULT_REST,
  SLIDE_DIRECTIONS,
  TEXT_PRESETS,
  createKeyframeIdFactory,
  generatePreset,
  mergeGeneratedKeyframes,
} from '@nos/text';
import { Mono, SectionCaption } from '@nos/ui';
import { token } from '@nos/ui';

/**
 * Text clip properties (spec §6.5).
 *
 * Font, size, colour, outline, shadow — the fields that decide what the rasterizer produces — plus the
 * in and out animation presets.
 *
 * The rule the presets follow, and the reason they are worth having: **a preset generates keyframes**.
 * It does not hide a curve behind a name. What "slide in" produces appears in the keyframe lane as
 * ordinary markers the user can drag, retime or delete, so there is no animation in this application
 * that cannot be edited. A preset that stayed opaque would be a second, invisible animation system.
 */

export interface TextInspectorProps {
  readonly document: TimelineDocument;
  readonly clip?: string | undefined;
  readonly onChange: (label: string, next: TimelineDocument) => void;
}

/** A new title, styled to be legible on any footage without further work. */
export const DEFAULT_TEXT: TextContent = {
  text: 'Title',
  font: 'system-ui, sans-serif',
  size: 72,
  weight: 700,
  color: { r: 1, g: 1, b: 1, a: 1 },
  align: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  // A soft shadow rather than none: white text over a bright shot is unreadable, and a title that
  // disappears on some footage is worse than one that is slightly heavier than necessary.
  shadow: { color: { r: 0, g: 0, b: 0, a: 0.65 }, blur: 12, offsetX: 0, offsetY: 2 },
};

/** Frames a new title occupies: three seconds at 30 fps, the length of a readable lower third. */
export const DEFAULT_TEXT_FRAMES = 90;

export function createTextClip(id: string, start: number, frames = DEFAULT_TEXT_FRAMES): TextClip {
  return {
    kind: 'text',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(start + frames)),
    label: DEFAULT_TEXT.text,
    enabled: true,
    effects: [],
    content: DEFAULT_TEXT,
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
  };
}

export function TextInspector({ document, clip, onChange }: TextInspectorProps): ReactNode {
  const located = clip === undefined ? undefined : locateClip(document, clip as never);
  if (located === undefined || located.clip.kind !== 'text') return null;

  const text = located.clip;

  const write = (label: string, next: TextClip): void => {
    onChange(label, replaceClip(document, next));
  };

  const setContent = (patch: Partial<TextContent>): void => {
    const content = { ...text.content, ...patch };
    // The label follows the text, because a timeline of clips all labelled "Title" is unreadable and
    // nobody renames them by hand.
    write('edit text', { ...text, content, label: content.text.slice(0, 40) || 'Title' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
      <SectionCaption>Text</SectionCaption>

      <textarea
        aria-label="Text"
        rows={3}
        value={text.content.text}
        onChange={(event) => setContent({ text: event.target.value })}
        style={{
          background: token.surface1,
          border: `1px solid ${token.borderControl}`,
          borderRadius: token.radiusControl,
          color: token.textBright,
          font: `400 12px ${token.fontUi}`,
          padding: token.space3,
          resize: 'vertical',
        }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Size">
          <input
            type="number"
            aria-label="Size"
            min={8}
            max={400}
            value={text.content.size}
            onChange={(event) => setContent({ size: Number(event.target.value) })}
            style={inputStyle}
          />
        </Field>
        <Field label="Weight">
          <select
            aria-label="Weight"
            value={text.content.weight}
            onChange={(event) => setContent({ weight: Number(event.target.value) })}
            style={inputStyle}
          >
            {[400, 500, 600, 700, 800].map((weight) => (
              <option key={weight} value={weight}>
                {weight}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Align">
          <select
            aria-label="Align"
            value={text.content.align}
            onChange={(event) => setContent({ align: event.target.value as TextContent['align'] })}
            style={inputStyle}
          >
            {['left', 'center', 'right'].map((align) => (
              <option key={align} value={align}>
                {align}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Colour">
          <input
            type="color"
            aria-label="Colour"
            value={toHex(text.content.color)}
            onChange={(event) => setContent({ color: fromHex(event.target.value) })}
            style={{ ...inputStyle, padding: 2 }}
          />
        </Field>
      </div>

      <AnimationRow
        caption="Animate in"
        animation={text.animateIn}
        onChange={(animation) => write('set text animation', applyPreset(text, 'in', animation))}
      />
      <AnimationRow
        caption="Animate out"
        animation={text.animateOut}
        onChange={(animation) => write('set text animation', applyPreset(text, 'out', animation))}
      />

      <Mono tone={token.textGhost}>
        a preset writes keyframes — they appear in the lane below and can be edited like any others
      </Mono>
    </div>
  );
}

function AnimationRow({
  caption,
  animation,
  onChange,
}: {
  readonly caption: string;
  readonly animation: TextAnimation | undefined;
  readonly onChange: (animation: TextAnimation) => void;
}): ReactNode {
  const current: TextAnimation = animation ?? {
    preset: 'none',
    durationFrames: 12,
    direction: 'up',
    ease: 'ease-out',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <SectionCaption>{caption}</SectionCaption>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          aria-label={caption}
          value={current.preset}
          onChange={(event) =>
            onChange({ ...current, preset: event.target.value as TextAnimation['preset'] })
          }
          style={{ ...inputStyle, flex: 1 }}
        >
          {TEXT_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>

        {current.preset === 'slide' && (
          <select
            aria-label={`${caption} direction`}
            value={current.direction ?? 'up'}
            onChange={(event) =>
              onChange({
                ...current,
                direction: event.target.value as NonNullable<TextAnimation['direction']>,
              })
            }
            style={{ ...inputStyle, width: 84 }}
          >
            {SLIDE_DIRECTIONS.map((direction) => (
              <option key={direction} value={direction}>
                {direction}
              </option>
            ))}
          </select>
        )}

        <input
          type="number"
          aria-label={`${caption} frames`}
          min={0}
          max={240}
          value={current.durationFrames}
          onChange={(event) => onChange({ ...current, durationFrames: Number(event.target.value) })}
          style={{ ...inputStyle, width: 64 }}
        />
      </div>
    </div>
  );
}

/**
 * Applies a preset by generating its keyframes into the clip.
 *
 * Merged per channel rather than replaced wholesale, and only on the channels the preset actually
 * touches: applying "slide in" must not silently discard a fade the user authored by hand, and it must
 * not pin a channel it never animates.
 *
 * `reveal` is its own channel rather than a transform, because typewriter changes the *number of visible
 * glyphs* — the renderer clips the quad against the cached advance list, which no transform can express.
 */
function applyPreset(clip: TextClip, phase: 'in' | 'out', animation: TextAnimation): TextClip {
  const nextId = createKeyframeIdFactory(`${clip.id}_${phase}`);
  const curves = generatePreset({
    animation,
    phase,
    clipDurationFrames: clip.span.duration,
    rest: DEFAULT_REST,
    nextId,
  });

  let transform = clip.transform;
  let reveal = clip.reveal;

  for (const curve of curves) {
    if (curve.channel === 'reveal') {
      reveal = mergeGeneratedKeyframes(reveal ?? staticNumber(1), curve.keyframes);
      continue;
    }
    transform = {
      ...transform,
      [curve.channel]: mergeGeneratedKeyframes(transform[curve.channel], curve.keyframes),
    };
  }

  return {
    ...clip,
    transform,
    ...(reveal !== undefined ? { reveal } : {}),
    ...(phase === 'in' ? { animateIn: animation } : { animateOut: animation }),
  };
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ font: token.textLabel, color: token.textSoft }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = {
  height: token.controlHeight,
  background: token.surface1,
  border: `1px solid ${token.borderControl}`,
  borderRadius: token.radiusControl,
  color: token.textBright,
  font: `400 11.5px ${token.fontUi}`,
  padding: `0 ${token.space2}`,
  minWidth: 0,
} as const;

/** `#rrggbb` from the normalized channels a shader uniform wants. Alpha is not editable here. */
function toHex(color: TextContent['color']): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function fromHex(hex: string): TextContent['color'] {
  const value = hex.replace('#', '');
  const part = (start: number): number => parseInt(value.slice(start, start + 2), 16) / 255;
  return { r: part(0), g: part(2), b: part(4), a: 1 };
}

function replaceClip(document: TimelineDocument, clip: TextClip): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track) =>
        track.kind !== 'text'
          ? track
          : ({
              ...track,
              clips: track.clips.map((entry) => (entry.id === clip.id ? clip : entry)),
            } as Track),
      ),
    },
  };
}
