import { type ReactNode } from 'react';
import {
  type TextAnimation,
  type TextClip,
  type TextContent,
  type TimelineDocument,
  clipId,
  frameIndex,
  locateClip,
  ok,
  spanFromBounds,
  staticNumber,
} from '@nos/core';
import { updateClip } from '@nos/editing';
import {
  DEFAULT_REST,
  SLIDE_DIRECTIONS,
  TEXT_PRESETS,
  createKeyframeIdFactory,
  generatePreset,
  mergeGeneratedKeyframes,
} from '@nos/text';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  PaintBucketIcon,
  SquareIcon,
  TypeIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NumberField } from '@nos/ui';
import { Field, FieldTitle } from '@nos/ui/components/ui/field';
import { Input } from '@nos/ui/components/ui/input';
import { Separator } from '@nos/ui/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@nos/ui/components/ui/toggle-group';
import { Switch } from '@nos/ui/components/ui/switch';
import { NativeSelect, NativeSelectOption } from '@nos/ui/components/ui/native-select';
import { Textarea } from '@nos/ui/components/ui/textarea';

/**
 * Text clip properties (spec §6.5).
 *
 * Font, size, colour, line height, letter spacing, outline and shadow — every field the rasterizer
 * reads — plus the in and out animation presets.
 *
 * All of it, now. Until this the panel offered five of the eleven, and its own comment claimed
 * otherwise: outline and shadow had been rasterized since M7 with no control anywhere, which meant the
 * outline path had never once run. They are the two fields that make a title legible over footage the
 * editor does not control, so their absence was not cosmetic.
 *
 * The rule the presets follow, and the reason they are worth having: **a preset generates keyframes**.
 * It does not hide a curve behind a name. What "slide in" produces appears in the keyframe lane as
 * ordinary markers the user can drag, retime or delete, so there is no animation in this application
 * that cannot be edited. A preset that stayed opaque would be a second, invisible animation system.
 */

/**
 * A change to a text clip's content.
 *
 * Widened from `Partial<TextContent>` so that `outline` and `shadow` can be *cleared*: under
 * `exactOptionalPropertyTypes` a `Partial` refuses an explicit `undefined`, which is exactly the value
 * that means "no outline" here.
 */
type ContentPatch = Partial<Omit<TextContent, 'outline' | 'shadow'>> & {
  readonly outline?: TextContent['outline'] | undefined;
  readonly shadow?: TextContent['shadow'] | undefined;
};

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

/**
 * What turning an outline on gives you.
 *
 * Black at 2 px, because an outline exists to separate a title from whatever is behind it and a thin
 * dark edge does that on almost any footage. A user who wants something else changes two fields; one
 * who wanted the default gets a legible title from one click.
 */
const DEFAULT_OUTLINE: NonNullable<TextContent['outline']> = {
  width: 2,
  color: { r: 0, g: 0, b: 0, a: 1 },
};

/** The same shadow a new title already carries, so turning it back on restores what was there. */
const DEFAULT_SHADOW: NonNullable<TextContent['shadow']> = {
  color: { r: 0, g: 0, b: 0, a: 0.65 },
  blur: 12,
  offsetX: 0,
  offsetY: 2,
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

/**
 * The three alignments and the glyph each is universally drawn with.
 *
 * A table rather than a switch in the markup so the order is declared once and the control is a map
 * over it — adding a fourth alignment, if the model ever grows one, is a line here.
 */
const ALIGNMENTS = [
  { value: 'left', Icon: AlignLeftIcon },
  { value: 'center', Icon: AlignCenterIcon },
  { value: 'right', Icon: AlignRightIcon },
] as const;

export function TextInspector({ document, clip, onChange }: TextInspectorProps): ReactNode {
  const located = clip === undefined ? undefined : locateClip(document, clip as never);
  if (located === undefined || located.clip.kind !== 'text') return null;

  const text = located.clip;

  const write = (label: string, next: TextClip): void => {
    onChange(label, replaceClip(document, next));
  };

  const setContent = (patch: ContentPatch): void => {
    // An explicit `undefined` in the patch means *remove*, not "hold a key whose value is undefined".
    // The two are the same to the rasterizer, which checks `!== undefined` — but not to the
    // serializer, and a `project.json` carrying `"outline": null` would read back as a value rather
    // than as an absence. So the two optional fields are rebuilt rather than spread.
    const { outline: _outline, shadow: _shadow, ...rest } = { ...text.content, ...patch };
    const outline = 'outline' in patch ? patch.outline : text.content.outline;
    const shadow = 'shadow' in patch ? patch.shadow : text.content.shadow;

    const content: TextContent = {
      ...rest,
      ...(outline !== undefined ? { outline } : {}),
      ...(shadow !== undefined ? { shadow } : {}),
    };
    // The label follows the text, because a timeline of clips all labelled "Title" is unreadable and
    // nobody renames them by hand.
    write('edit text', { ...text, content, label: content.text.slice(0, 40) || 'Title' });
  };

  return (
    <div className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center gap-2">
        <TypeIcon className="size-3.5 text-chart-5" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Text</span>
      </div>

      <Textarea
        aria-label="Text"
        rows={3}
        value={text.content.text}
        onChange={(event) => setContent({ text: event.target.value })}
      />

      <div className="grid grid-cols-2 gap-2">
        <Labelled label="Size">
          <Input
            type="number"
            aria-label="Size"
            min={8}
            max={400}
            value={text.content.size}
            onChange={(event) => setContent({ size: Number(event.target.value) })}
            className="font-mono tabular-nums"
          />
        </Labelled>
        <Labelled label="Weight">
          <NativeSelect
            aria-label="Weight"
            className="w-full"
            value={text.content.weight}
            onChange={(event) => setContent({ weight: Number(event.target.value) })}
          >
            {[400, 500, 600, 700, 800].map((weight) => (
              <NativeSelectOption key={weight} value={weight}>
                {weight}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Labelled>
        <Labelled label="Align">
          {/*
           * Icons rather than a dropdown, which is the one place in this panel where a picture is
           * genuinely clearer than the word: alignment has a universal glyph, the three options are
           * mutually exclusive, and a dropdown costs three interactions to say what one click says.
           * `type="single"` keeps exactly one selected, which is what the model allows.
           */}
          <ToggleGroup
            aria-label="Align"
            variant="outline"
            size="sm"
            multiple={false}
            className="w-full"
            value={[text.content.align]}
            onValueChange={(next) => {
              // Base UI reports an empty array when the pressed item is toggled off. Alignment has no
              // "none", so the current value stands rather than being cleared.
              const picked = next[0];
              if (picked === undefined) return;
              setContent({ align: picked as TextContent['align'] });
            }}
          >
            {ALIGNMENTS.map(({ value, Icon }) => (
              <ToggleGroupItem key={value} value={value} aria-label={value} className="flex-1">
                <Icon />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Labelled>
        <Labelled label="Colour">
          <Input
            type="color"
            aria-label="Colour"
            value={toHex(text.content.color)}
            onChange={(event) => setContent({ color: fromHex(event.target.value) })}
            className="p-0.5"
          />
        </Labelled>
      </div>

      <Labelled label="Font">
        {/*
          A typed family rather than a list. The fonts on this machine are not enumerable without a
          permission prompt, and a hardcoded menu would offer families the system may not have —
          which fails silently, because canvas substitutes rather than refusing. A CSS family list
          with a generic at the end is the honest control: `Inter, sans-serif` degrades on purpose.
        */}
        <Input
          aria-label="Font"
          value={text.content.font}
          placeholder="system-ui, sans-serif"
          onChange={(event) => setContent({ font: event.target.value })}
        />
      </Labelled>

      <div className="grid grid-cols-2 gap-2">
        <Labelled label="Line height">
          <NumberField
            aria-label="Line height"
            step={0.05}
            value={text.content.lineHeight}
            onCommit={(lineHeight) => setContent({ lineHeight })}
            className="font-mono tabular-nums"
          />
        </Labelled>
        <Labelled label="Letter spacing">
          <NumberField
            aria-label="Letter spacing"
            step={0.5}
            value={text.content.letterSpacing}
            onCommit={(letterSpacing) => setContent({ letterSpacing })}
            className="font-mono tabular-nums"
          />
        </Labelled>
      </div>

      {/*
        Outline and shadow are what make a title legible over footage the editor does not control, and
        the rasterizer has drawn both since M7 — including the subtlety that a shadow is drawn with the
        outline rather than twice. Neither had a control, so the outline path had never run at all.
      */}
      <OptionalSection
        label="Outline"
        icon={SquareIcon}
        enabled={text.content.outline !== undefined}
        onToggle={(on) => setContent({ outline: on ? DEFAULT_OUTLINE : undefined })}
      >
        {text.content.outline !== undefined && (
          <div className="grid grid-cols-2 gap-2">
            <Labelled label="Width">
              <NumberField
                aria-label="Outline width"
                min={0}
                step={0.5}
                value={text.content.outline.width}
                onCommit={(width) =>
                  setContent({ outline: { ...text.content.outline!, width: Math.max(0, width) } })
                }
                className="font-mono tabular-nums"
              />
            </Labelled>
            <Labelled label="Colour">
              <Input
                type="color"
                aria-label="Outline colour"
                value={toHex(text.content.outline.color)}
                onChange={(event) =>
                  setContent({ outline: { ...text.content.outline!, color: fromHex(event.target.value) } })
                }
                className="p-0.5"
              />
            </Labelled>
          </div>
        )}
      </OptionalSection>

      <OptionalSection
        label="Shadow"
        icon={PaintBucketIcon}
        enabled={text.content.shadow !== undefined}
        onToggle={(on) => setContent({ shadow: on ? DEFAULT_SHADOW : undefined })}
      >
        {text.content.shadow !== undefined && (
          <div className="grid grid-cols-2 gap-2">
            <Labelled label="Blur">
              <NumberField
                aria-label="Shadow blur"
                min={0}
                step={1}
                value={text.content.shadow.blur}
                onCommit={(blur) =>
                  setContent({ shadow: { ...text.content.shadow!, blur: Math.max(0, blur) } })
                }
                className="font-mono tabular-nums"
              />
            </Labelled>
            <Labelled label="Colour">
              <Input
                type="color"
                aria-label="Shadow colour"
                value={toHex(text.content.shadow.color)}
                onChange={(event) =>
                  setContent({ shadow: { ...text.content.shadow!, color: fromHex(event.target.value) } })
                }
                className="p-0.5"
              />
            </Labelled>
            <Labelled label="Offset x">
              <NumberField
                aria-label="Shadow offset x"
                step={1}
                value={text.content.shadow.offsetX}
                onCommit={(offsetX) => setContent({ shadow: { ...text.content.shadow!, offsetX } })}
                className="font-mono tabular-nums"
              />
            </Labelled>
            <Labelled label="Offset y">
              <NumberField
                aria-label="Shadow offset y"
                step={1}
                value={text.content.shadow.offsetY}
                onCommit={(offsetY) => setContent({ shadow: { ...text.content.shadow!, offsetY } })}
                className="font-mono tabular-nums"
              />
            </Labelled>
          </div>
        )}
      </OptionalSection>

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

      <p className="font-mono text-xs text-muted-foreground">
        a preset writes keyframes — they appear in the lane below and can be edited like any others
      </p>
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
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {/* In and out are the same control twice; the arrow is what tells them apart at a glance. */}
        {caption === 'Animate in' ? (
          <ArrowUpFromLineIcon className="size-3.5 text-muted-foreground" />
        ) : (
          <ArrowDownToLineIcon className="size-3.5 text-muted-foreground" />
        )}
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{caption}</span>
      </div>
      <div className="flex gap-2">
        <NativeSelect
          aria-label={caption}
          className="flex-1"
          value={current.preset}
          onChange={(event) =>
            onChange({ ...current, preset: event.target.value as TextAnimation['preset'] })
          }
        >
          {TEXT_PRESETS.map((preset) => (
            <NativeSelectOption key={preset} value={preset}>
              {preset}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        {current.preset === 'slide' && (
          <NativeSelect
            aria-label={`${caption} direction`}
            className="w-21"
            value={current.direction ?? 'up'}
            onChange={(event) =>
              onChange({
                ...current,
                direction: event.target.value as NonNullable<TextAnimation['direction']>,
              })
            }
          >
            {SLIDE_DIRECTIONS.map((direction) => (
              <NativeSelectOption key={direction} value={direction}>
                {direction}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}

        <Input
          type="number"
          aria-label={`${caption} frames`}
          min={0}
          max={240}
          value={current.durationFrames}
          onChange={(event) => onChange({ ...current, durationFrames: Number(event.target.value) })}
          className="w-16 font-mono tabular-nums"
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

/**
 * A group of fields that only exists when it is switched on.
 *
 * A switch rather than a checkbox beside a heading, because absence is the meaningful state here:
 * `outline: undefined` is what the rasterizer reads as "no outline", and the alternative — an outline
 * of width zero — would keep a colour the user set and quietly cost a stroke pass.
 */
function OptionalSection({
  label,
  icon: Icon,
  enabled,
  onToggle,
  children,
}: {
  readonly label: string;
  /** Marks the section at a glance, so a panel of five headings is scanned rather than read. */
  readonly icon: LucideIcon;
  readonly enabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <Separator />
      <div className="flex items-center gap-2">
        {/* Muted, not coloured: a heading glyph is a landmark, and the panel's colour already means
            something specific elsewhere. */}
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        <Switch aria-label={label} checked={enabled} onCheckedChange={onToggle} className="ml-auto" />
      </div>
      {children}
    </div>
  );
}

/**
 * A caption above a control that already carries its own `aria-label`.
 *
 * Plumbing: the registry's `Field` with `FieldTitle` rather than `FieldLabel`, because every control in
 * this panel already names itself with `aria-label` — a second `<label>` would give each one two
 * accessible names, and an unassociated one would give the caption no meaning at all.
 */
function Labelled({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <Field className="gap-1">
      <FieldTitle className="text-xs">{label}</FieldTitle>
      {children}
    </Field>
  );
}

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

/**
 * Writes a title back into the document.
 *
 * Through `@nos/editing`'s own `updateClip`, for the two reasons the keyframe lanes' copy of this was
 * changed: it rebuilds only the track the clip is on rather than every text track, and it **checks the
 * lock**, which this did not — so a locked track protected its titles from every gesture on the
 * timeline and from none of the fields in this panel.
 */
function replaceClip(document: TimelineDocument, clip: TextClip): TimelineDocument {
  const updated = updateClip(document, clip.id, () => ok(clip));
  return updated.ok ? updated.value : document;
}
