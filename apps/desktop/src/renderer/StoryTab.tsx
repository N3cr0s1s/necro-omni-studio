import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { ImageIcon, PaperclipIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  type AssetPath,
  type FrameIndex,
  type StoryBeatId,
  type TimelineDocument,
  FRAME_RATES,
  STORY_ACCENTS,
  accentOf,
  beatsInOrder,
  frameIndex,
  nextBeatStart,
} from '@nos/core';
import {
  DEFAULT_BEAT_SECONDS,
  addBeat,
  attachReference,
  detachReference,
  editBeat,
  moveBeat,
  removeBeat,
} from '@nos/editing';
import { StoryBoard, accentSpineClass, createViewport, defaultBoardZoom } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@nos/ui/components/ui/empty';
import { Input } from '@nos/ui/components/ui/input';
import { Label } from '@nos/ui/components/ui/label';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { Textarea } from '@nos/ui/components/ui/textarea';
import { cn } from '@nos/ui/lib/utils';
import { useElementWidth } from './use-element-width.js';

/**
 * The story board tab, per issue #33.
 *
 * A plan on the same clock as the cut: what should happen, when, in prose, pointing at material
 * already in the project. Nothing here is composited or exported.
 *
 * ## Why the board and the editor are one screen
 *
 * A beat is a *span* and a *paragraph*, and the two are decided together — you shorten a beat because
 * the note you just wrote turned out to be one shot rather than two. Putting the prose behind a dialog
 * would mean closing it every time to see where the beat sits, which is the arrangement the effect
 * editor was moved out of in #31.
 *
 * ## Why references are attached from the browser's selection
 *
 * The media browser is already the way this application answers "which file"; a second picker here
 * would be a second file tree to keep in step with the first, and would still be worse at it — no
 * preview, no watcher, no thumbnails. Selecting the file and attaching it is one gesture more, and it
 * is the gesture the user is already making to look at the file they mean.
 */

export interface StoryTabProps {
  readonly document: TimelineDocument | undefined;
  /** Where the sequence is parked, drawn across the board and where a new beat lands. */
  readonly playhead: FrameIndex;
  readonly onChangeDocument: (label: string, next: TimelineDocument) => void;
  readonly onSeek: (frame: FrameIndex) => void;
  /** What the media browser has selected — what "attach" attaches. */
  readonly attachable?: AssetPath;
  readonly onOpenAsset?: (asset: AssetPath) => void;
}

export function StoryTab({
  document,
  playhead,
  onChangeDocument,
  onSeek,
  attachable,
  onOpenAsset,
}: StoryTabProps): ReactNode {
  const [selected, setSelected] = useState<StoryBeatId>();
  /*
   * Undefined until someone zooms, so the board follows the project's frame rate rather than a number
   * chosen once against one of them. The timeline's default draws a two-second beat fifteen pixels
   * wide at 30 fps — narrower than a beat can be grabbed at, let alone read.
   */
  const [zoom, setZoom] = useState<number>();
  const { ref: boardRef, width: boardWidth } = useElementWidth({ minimum: 400 });

  const beats = document?.story ?? [];
  const beat = beats.find((entry) => entry.id === selected);

  // A board with no project still has to render; the rate only scales the ruler's labels.
  const frameRate = document?.frameRate ?? FRAME_RATES.WEB_30;

  const viewport = useMemo(
    () =>
      createViewport({
        framesPerPixel: zoom ?? defaultBoardZoom(frameRate, DEFAULT_BEAT_SECONDS),
        widthPx: Math.max(1, boardWidth),
        frameRate,
      }),
    [zoom, boardWidth, frameRate],
  );

  /** Every change goes through the store, which is what puts the plan under undo with the cut. */
  const change = useCallback(
    (label: string, next: (current: TimelineDocument) => TimelineDocument) => {
      if (document === undefined) return;
      onChangeDocument(label, next(document));
    },
    [document, onChangeDocument],
  );

  const add = useCallback(
    (at: FrameIndex) => {
      if (document === undefined) return;
      // After what is already planned rather than on top of it: the playhead does not move on its
      // own, so without this a second press of the button buries the beat the first one made.
      const next = addBeat(document, frameIndex(nextBeatStart(document.story, at as number)));
      onChangeDocument('add beat', next);
      // Selected immediately: a beat is added in order to write it, and a board that made you find
      // the block you just created would be asking for a step it already knows the answer to.
      setSelected(next.story[next.story.length - 1]?.id);
    },
    [document, onChangeDocument],
  );

  if (document === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImageIcon />
            </EmptyMedia>
            <EmptyTitle>No project open</EmptyTitle>
            <EmptyDescription>
              The board is part of the project, so it travels with it. Open a project to plan one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 flex-none items-center gap-2 border-b px-4">
        <span className="text-[10px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
          Story
        </span>
        <span className="text-sm text-muted-foreground">
          {beats.length === 0
            ? 'nothing planned yet'
            : `${beats.length} beat${beats.length === 1 ? '' : 's'}`}
        </span>

        <Button size="sm" className="ml-auto" onClick={() => add(playhead)}>
          <PlusIcon />
          Add beat
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={beat === undefined}
          onClick={() => {
            if (beat === undefined) return;
            change('remove beat', (current) => removeBeat(current, beat.id));
            setSelected(undefined);
          }}
        >
          <Trash2Icon />
          Delete
        </Button>
        <Separator orientation="vertical" className="h-4" />
        {/* Zoom by the same steps the timeline uses, so the two scales stay comparable by eye. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setZoom((current) =>
              Math.max(1 / 16, (current ?? defaultBoardZoom(frameRate, DEFAULT_BEAT_SECONDS)) / 2),
            )
          }
        >
          Zoom in
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setZoom((current) =>
              Math.min(256, (current ?? defaultBoardZoom(frameRate, DEFAULT_BEAT_SECONDS)) * 2),
            )
          }
        >
          Zoom out
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* A plain scroller, not a ScrollArea: the board scrolls in both directions and the styled
            one only ever draws a vertical bar, so a plan wider than the window would have had no way
            to reach its end. */}
        <div ref={boardRef} className="min-w-0 flex-1 overflow-auto p-2">
          {beats.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              A beat says when something should happen and what it is, in prose — the text a prompt is later
              written from. Add one, or double-click the board where it belongs.
            </p>
          ) : undefined}
          <StoryBoard
            beats={beats}
            viewport={viewport}
            playhead={playhead}
            {...(selected !== undefined ? { selected } : {})}
            onSelect={setSelected}
            onSeek={onSeek}
            onAddAt={add}
            onMove={(id, to) => change('move beat', (current) => moveBeat(current, id, to))}
            onResize={(id, end) => {
              const moving = beats.find((entry) => entry.id === id);
              if (moving === undefined) return;
              change('resize beat', (current) =>
                editBeat(current, id, { span: { start: moving.span.start, end } }),
              );
            }}
          />
        </div>

        <aside className="flex w-80 flex-none flex-col border-l" aria-label="Beat">
          {beat === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">Select a beat to write it.</p>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-4 p-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="beat-title">Title</Label>
                  <Input
                    id="beat-title"
                    value={beat.title}
                    placeholder="Wide shot of the dunes"
                    onChange={(event) =>
                      change('rename beat', (current) =>
                        editBeat(current, beat.id, { title: event.target.value }),
                      )
                    }
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Accent</Label>
                  <div className="flex gap-1.5">
                    {STORY_ACCENTS.map((accent) => (
                      <button
                        key={accent}
                        type="button"
                        aria-label={`Accent ${accent}`}
                        aria-pressed={accentOf(beat) === accent}
                        onClick={() =>
                          change('recolour beat', (current) => editBeat(current, beat.id, { accent }))
                        }
                        className={cn(
                          'size-6 rounded-md border',
                          accentSpineClass(accent),
                          accentOf(beat) === accent &&
                            'ring-2 ring-ring ring-offset-1 ring-offset-background',
                        )}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="beat-notes">Notes</Label>
                  <Textarea
                    id="beat-notes"
                    rows={10}
                    value={beat.notes}
                    placeholder={'# The dune\n\nSlow push in. Late light, long shadows.'}
                    onChange={(event) =>
                      change('write beat', (current) =>
                        editBeat(current, beat.id, { notes: event.target.value }),
                      )
                    }
                    className="min-h-40 font-mono text-xs"
                  />
                  {/* Markdown, because this is the text a prompt is written from — a form with fields
                      for camera, subject and mood would decide in advance what a shot is about. */}
                  <p className="text-xs text-muted-foreground">Markdown.</p>
                </div>

                <Separator />

                <div className="flex flex-col gap-1.5">
                  <Label>References</Label>
                  {beat.references.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Nothing attached. What it should look and sound like, pointed at rather than described.
                    </p>
                  )}
                  <ul className="flex flex-col gap-1">
                    {beat.references.map((reference) => (
                      <li key={reference.asset} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onOpenAsset?.(reference.asset)}
                          title={reference.asset}
                          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-muted-foreground hover:text-foreground"
                        >
                          {reference.asset}
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Detach ${reference.asset}`}
                          onClick={() =>
                            change('detach reference', (current) =>
                              detachReference(current, beat.id, reference.asset),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </li>
                    ))}
                  </ul>

                  {/* Named, not "attach selection": a button that does not say what it will attach is
                      one you have to press to find out. */}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={attachable === undefined}
                    onClick={() => {
                      if (attachable === undefined) return;
                      change('attach reference', (current) => attachReference(current, beat.id, attachable));
                    }}
                  >
                    <PaperclipIcon />
                    <span className="truncate">
                      {attachable === undefined ? 'Select a file to attach' : `Attach ${attachable}`}
                    </span>
                  </Button>
                </div>

                <Separator />

                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                  <dt>from</dt>
                  <dd>{beat.span.start}</dd>
                  <dt>through</dt>
                  <dd>{(beat.span.start as number) + (beat.span.duration as number)}</dd>
                </dl>
              </div>
            </ScrollArea>
          )}
        </aside>
      </div>

      {/* The order they happen in, which is the reading a board arranged by time cannot give: beats
          that overlap sit on different rows, and a plan is still read top to bottom. */}
      {beats.length > 0 && (
        <footer className="flex h-9 flex-none items-center gap-3 overflow-x-auto border-t px-4">
          {beatsInOrder(beats).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setSelected(entry.id);
                onSeek(frameIndex(entry.span.start as number));
              }}
              className={cn(
                'flex flex-none items-center gap-1.5 text-xs whitespace-nowrap',
                entry.id === selected ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className={cn('size-2 rounded-full', accentSpineClass(accentOf(entry)))} />
              {entry.title === '' ? 'Untitled beat' : entry.title}
            </button>
          ))}
        </footer>
      )}
    </div>
  );
}
