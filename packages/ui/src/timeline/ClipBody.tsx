import type { ReactNode } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  LinkIcon,
  SparklesIcon,
  SquareDashedIcon,
  UnplugIcon,
} from 'lucide-react';
import { type Clip, type ClipId, hasAnimation, isGenerated, linkedPartner, passCount } from '@nos/core';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { type MenuBinding, ActionMenu } from '../menus/ActionMenu.js';
import { cn } from '@nos/ui/lib/utils';
import type { ClipStrip } from './clip-strip.js';
import { type SpanGeometry } from './viewport.js';

/**
 * A clip drawn on a track.
 *
 * The visual language is the mockups' rule expressed in the theme's own vocabulary: each media kind
 * gets one of the categorical `chart` roles, and **anything a generator produced takes the generated
 * role** regardless of its media type. That last rule is the one worth guarding — it is how a user
 * tells at a glance which material is synthetic, and it must hold on the timeline, in the browser and
 * in the inspector alike, which is why the role is the same one `assetGlyph` uses.
 */

export interface ClipBodyProps {
  readonly clip: Clip;
  readonly geometry: SpanGeometry;
  readonly heightPx: number;
  readonly selected: boolean;
  /** Filmstrip or waveform image and its placement, once derived. Absent means not ready yet. */
  readonly strip?: ClipStrip;
  /**
   * The clip's file is not in the project folder.
   *
   * Drawn rather than left to the empty picture it produces: a clip whose media has gone renders as
   * nothing, and a black frame with no explanation reads as a bug in the editor rather than as a file
   * the user moved. The fact belongs to the folder, so it is passed in — a document cannot know it.
   */
  readonly offline?: boolean;
  readonly onPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  /**
   * Whether each edge is a cut shared with a neighbour, so shift-dragging it rolls rather than trims.
   *
   * Passed in rather than worked out here: whether two clips are flush is a question about the
   * document, and this component is given a clip and a rectangle.
   */
  readonly rollableStart?: boolean | undefined;
  readonly rollableEnd?: boolean | undefined;
  readonly onTrimStart?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimEnd?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  /** Above the spec's 8-pass budget, the clip carries a warning badge. */
  readonly passWarningThreshold?: number;
  /** Whether this clip's parameter lanes are showing beneath its track. */
  readonly expanded?: boolean;
  /** Opens or closes the clip. Absent leaves the disclosure off entirely. */
  readonly onToggleExpand?: (clip: ClipId) => void;
  /** The right-click menu for this clip. Absent leaves the clip without one. */
  readonly menu?: MenuBinding<ClipId>;
  /**
   * A right-click, reported before the menu opens.
   *
   * Separate from `menu` because it is not about the menu's contents: it exists so the lane can select
   * the clip first. Acting on something other than what was clicked is the one behaviour a context menu
   * must never have.
   */
  readonly onContextMenu?: (clip: ClipId) => void;
}

/**
 * Fill and border for a clip, by media kind and provenance.
 *
 * Returned as complete Tailwind classes, never as colour values: these are theme roles, so they follow
 * the palette and dark mode without this file knowing either exists. The opacities are what separate
 * "a filled clip" from "a solid block" — the strip behind the label has to stay visible through it.
 */
function clipPalette(clip: Clip): string {
  if (isGenerated(clip)) return 'bg-chart-4/25 border-chart-4/60';

  switch (clip.kind) {
    case 'video':
    case 'image':
      return 'bg-chart-1/25 border-chart-1/60';
    case 'audio':
      return 'bg-chart-2/25 border-chart-2/60';
    case 'text':
      return 'bg-chart-5/25 border-chart-5/60';
    default: {
      const unreachable: never = clip;
      throw new Error(`Unhandled clip kind ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Trim handles need enough width to grab; below this a clip is body-only. */
const TRIM_HANDLE_PX = 6;
const MIN_HANDLE_CLIP_WIDTH_PX = 24;

/**
 * Below this lane height a clip is a bar and nothing else.
 *
 * The same rule as the width one above, in the other axis: a label clipped to three pixels of its
 * ascenders is not a smaller label, it is noise over the one thing that says which clip this is. A
 * collapsed track is read for *where the material is*, not for what it says.
 */
const MIN_LABEL_TRACK_HEIGHT_PX = 34;

export function ClipBody({
  clip,
  geometry,
  heightPx,
  selected,
  strip,
  offline,
  onPointerDown,
  rollableStart,
  rollableEnd,
  onTrimStart,
  onTrimEnd,
  passWarningThreshold = 8,
  expanded = false,
  onToggleExpand,
  menu,
  onContextMenu,
}: ClipBodyProps): ReactNode {
  const passes = passCount(clip);
  const compact = heightPx < MIN_LABEL_TRACK_HEIGHT_PX;
  // Handles are hidden in a compact lane too: a 10 px bar cannot be trimmed with any precision, and
  // the grab zones would sit exactly where the user is aiming to click the clip itself.
  const showHandles = geometry.widthPx >= MIN_HANDLE_CLIP_WIDTH_PX && !compact;
  const Disclosure = expanded ? ChevronDownIcon : ChevronRightIcon;
  // Less inset when there is less to inset. The default six pixels top and bottom is most of a
  // collapsed lane, and would leave the bar too thin to see the colour that says what kind it is.
  const inset = compact ? 2 : 6;

  return (
    <ActionMenu
      items={menu === undefined ? [] : menu.items(clip.id)}
      onChoose={(action) => menu?.onChoose(clip.id, action)}
    >
      <div
        role="button"
        aria-label={clipAccessibleLabel(clip, offline === true)}
        aria-pressed={selected}
        tabIndex={0}
        data-clip-id={clip.id}
        data-generated={isGenerated(clip) ? 'true' : 'false'}
        className={cn(
          // No transition: this element moves under the pointer during a drag, and any easing would
          // fight the gesture and blow the 16 ms interaction budget.
          'absolute cursor-grab overflow-hidden rounded-md border px-1.5 py-1 select-none',
          selected ? 'border-2 border-primary bg-primary/25 ring-1 ring-primary/25' : clipPalette(clip),
          !clip.enabled && 'opacity-40',
        )}
        style={{
          left: geometry.leftPx,
          width: geometry.widthPx,
          top: inset,
          height: Math.max(0, heightPx - inset * 2),
        }}
        onPointerDown={(event) => onPointerDown?.(clip.id, event)}
        onContextMenu={() => onContextMenu?.(clip.id)}
      >
        {/* First, so everything else paints over it: an audio strip fills the clip, and a waveform
            drawn on top of the label would hide the one thing that names the clip. */}
        {strip !== undefined && <StripLayer clip={clip} strip={strip} />}

        {!compact && (
          <div className="relative flex min-w-0 items-center gap-1">
            {offline === true && (
              // Before the generated mark, because "this cannot be drawn" outranks "a generator made
              // it": one is a property of the take, the other is why nothing appears.
              <UnplugIcon aria-hidden="true" className="size-2.5 flex-none text-destructive" />
            )}
            {isGenerated(clip) && (
              <SparklesIcon aria-hidden="true" className="size-2.5 flex-none text-chart-4" />
            )}
            <span className="truncate text-[11px] font-medium">{clip.label}</span>

            {/* The spec's §6.1: a clip can be opened to show its parameter lanes. Offered only when
              there is something to show — an empty disclosure punishes the user for using it. */}
            {onToggleExpand !== undefined && hasAnimation(clip) && (
              <Button
                variant="ghost"
                size="icon-xs"
                data-clip-disclosure={clip.id}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} ${clip.label} keyframe lanes`}
                title={expanded ? 'Hide the parameter lanes' : 'Show the parameter lanes'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExpand(clip.id);
                }}
                className="size-3.5"
              >
                <Disclosure className="size-2.5" />
              </Button>
            )}

            {passes > 0 && (
              <Badge
                variant={passes > passWarningThreshold ? 'destructive' : 'secondary'}
                className="h-3.5 flex-none px-1 font-mono text-[8.5px]"
              >
                fx {passes}
              </Badge>
            )}
            {clip.effects.some((effect) => effect.mask !== undefined) && (
              <Badge
                variant="secondary"
                className="h-3.5 flex-none gap-0.5 px-1 font-mono text-[8.5px] text-chart-4"
              >
                <SquareDashedIcon className="size-2" />
                mask
              </Badge>
            )}

            {/* A link is the reason two clips move as one, so it has to be visible: a user whose sound
              follows their picture without knowing why cannot tell a feature from a fault. */}
            {linkedPartner(clip) !== undefined && (
              <LinkIcon
                data-clip-linked="true"
                aria-hidden="true"
                className="size-2.5 flex-none text-muted-foreground"
              />
            )}
          </div>
        )}

        {!compact && clip.provenance?.seed !== undefined && geometry.widthPx > 90 && (
          <div className="absolute bottom-1 left-1.5 font-mono text-[9px] text-chart-4">
            seed {clip.provenance.seed}
          </div>
        )}

        {showHandles && (
          <>
            <TrimHandle
              side="start"
              rollable={rollableStart}
              onPointerDown={(event) => onTrimStart?.(clip.id, event)}
            />
            <TrimHandle
              side="end"
              rollable={rollableEnd}
              onPointerDown={(event) => onTrimEnd?.(clip.id, event)}
            />
          </>
        )}
      </div>
    </ActionMenu>
  );
}

/**
 * The filmstrip or waveform behind a clip's label.
 *
 * An `<img>` inside a clipping box rather than a background image, because the placement is a
 * fraction of the clip's width and CSS background percentages resolve against the *difference*
 * between the image and its box, not against the box. Percentage `width` and `left` on a child do
 * resolve against the box, which is exactly the arithmetic `ClipStrip` describes.
 *
 * Audio fills the clip and video sits along the bottom: a waveform is the clip's whole content,
 * where a filmstrip is a band under a label that still has to be readable.
 */
function StripLayer({ clip, strip }: { readonly clip: Clip; readonly strip: ClipStrip }): ReactNode {
  const audio = clip.kind === 'audio';

  return (
    <div
      aria-hidden="true"
      data-strip-kind={audio ? 'waveform' : 'filmstrip'}
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden',
        audio ? 'h-full' : 'h-8',
      )}
    >
      <img
        src={strip.url}
        alt=""
        draggable={false}
        className="absolute top-0 h-full max-w-none opacity-85"
        style={{ width: `${strip.widths * 100}%`, left: `${-strip.offset * 100}%` }}
      />
    </div>
  );
}

/**
 * A grab area at a clip edge.
 *
 * Rendered inside the clip rather than as a sibling so it moves with the clip automatically, and
 * `pointerdown` stops propagating so grabbing the edge trims instead of starting a move.
 */
function TrimHandle({
  side,
  rollable,
  onPointerDown,
}: {
  readonly side: 'start' | 'end';
  /** True when this edge is a cut shared with a neighbour, so shift-dragging it rolls. */
  readonly rollable?: boolean | undefined;
  readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  return (
    <div
      data-trim-handle={side}
      data-rollable={rollable === true ? '' : undefined}
      // A title rather than a visible mark: the affordance is one held key on a handle that is already
      // there, and a badge on every flush cut would clutter a busy sequence to teach one shortcut.
      title={rollable === true ? `Drag to trim, or hold Shift to roll the cut` : 'Drag to trim'}
      aria-hidden="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(event);
      }}
      className={cn(
        'absolute inset-y-0 cursor-ew-resize bg-transparent',
        side === 'start' ? 'left-0' : 'right-0',
      )}
      style={{ width: TRIM_HANDLE_PX }}
    />
  );
}

/**
 * Accessible name for a clip.
 *
 * Includes provenance and effect count because those are conveyed visually by colour and a badge,
 * neither of which reaches a screen reader.
 */
export function clipAccessibleLabel(clip: Clip, offline = false): string {
  const parts = [clip.label || clip.kind];
  // First among the notes, and said in words: the icon that carries it visually reaches no screen
  // reader, and it is the difference between a clip that will render and one that cannot.
  if (offline) parts.push('media missing');
  if (isGenerated(clip)) parts.push('generated');
  const passes = passCount(clip);
  if (passes > 0) parts.push(`${passes} effect${passes === 1 ? '' : 's'}`);
  if (!clip.enabled) parts.push('disabled');
  return parts.join(', ');
}
