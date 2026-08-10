import type { ReactNode } from 'react';
import { type FrameIndex, type FrameRate, type Marker, formatFrames } from '@nos/core';
import type { MarkerChange } from '@nos/editing';
import { MapPinIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@nos/ui/components/ui/button';
import { EditableName } from '@nos/ui';

/**
 * Every marker at once, and a way to reach each one.
 *
 * Markers have carried a label and a colour since the document model was written, and the ruler draws
 * them — but a ruler shows the stretch of sequence that happens to be on screen, and the only way
 * through them was `Alt`+arrow, one at a time and blind. On a twenty-minute cut that is the wrong
 * shape of tool entirely: the question is "where did I note the thing about the interview", and the
 * answer was to step through every flag until one of them said so.
 *
 * A list is the answer, and it is a *reading* surface first — timecode, name, colour — with the two
 * edits that belong to a list rather than to a flag: renaming, and removing. Placing one stays on the
 * ruler where the playhead is, because a marker is put down at a moment rather than chosen from a
 * menu.
 */

export interface MarkerListProps {
  readonly markers: readonly Marker[];
  readonly frameRate: FrameRate;
  /** Where the playhead is, so the marker it is sitting on can be marked as current. */
  readonly playhead: FrameIndex;
  readonly onSeek: (frame: FrameIndex) => void;
  readonly onEdit: (frame: FrameIndex, change: MarkerChange) => void;
  readonly onRemove: (frame: FrameIndex) => void;
}

export function MarkerList({
  markers,
  frameRate,
  playhead,
  onSeek,
  onEdit,
  onRemove,
}: MarkerListProps): ReactNode {
  if (markers.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="font-mono text-xs text-muted-foreground">no markers</p>
        {/* Says how to make one rather than only that there are none. An empty state that does not
            name the way out is a dead end with a label. */}
        <p className="text-xs text-muted-foreground">
          Press <kbd className="font-mono">M</kbd> to mark the playhead.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {markers.map((marker) => (
        <div
          key={marker.frame}
          className="group flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
        >
          {/*
            The colour, as the ruler draws it. A swatch rather than a tinted row: the colours are the
            user's own coding — a scene, a note, a problem — and a whole row in one of them would make
            the list harder to read than the ruler it is meant to replace.
          */}
          <MapPinIcon
            className="size-3.5 shrink-0"
            style={marker.color === undefined ? undefined : { color: marker.color }}
          />

          {/*
            The timecode is the button. It is what identifies a marker — two can share a name, none
            can share a frame — and making the identifier the way there means the row needs no
            separate "go" control competing with the name field beside it.
          */}
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 shrink-0 px-1 font-mono tabular-nums ${
              marker.frame === playhead ? 'text-foreground' : 'text-muted-foreground'
            }`}
            onClick={() => onSeek(marker.frame)}
            title="Go to this marker"
          >
            {formatFrames(marker.frame, frameRate)}
          </Button>

          <EditableName
            value={marker.label}
            title="Double-click to rename"
            onCommit={(label) => onEdit(marker.frame, { label })}
            className="min-w-0 flex-1 truncate"
          />

          {/*
            Shown on hover, and on focus so it is reachable without a pointer. A row of delete buttons
            is a list that looks like it is mostly about deleting.
          */}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(marker.frame)}
            aria-label={`Remove marker ${marker.label}`}
            title="Remove this marker"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
