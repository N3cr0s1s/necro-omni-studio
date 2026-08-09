import { type ReactNode, useState } from 'react';
import { FileQuestionIcon, MusicIcon, TypeIcon, VideoIcon } from 'lucide-react';
import { cn } from '@nos/ui/lib/utils';

/**
 * A reference, shown rather than named — issue #33.
 *
 * The board is a *mood* board. A list of paths says which files were chosen and nothing about what
 * they look like, which is the entire reason for attaching them: a beat's references are what it
 * should look and sound like, pointed at instead of described. `media/shot_04.png` is a filename; the
 * frame is the reference.
 *
 * ## What is drawn for what
 *
 * Images and video draw themselves — a video's first frame is a poster, which is what a `<video>`
 * element gives for free without decoding the whole file. Audio and text have no frame to show, so
 * they get a glyph and their name: a grey rectangle would say "this failed to load" about a file that
 * is perfectly fine.
 *
 * ## Why a failure falls back rather than showing a broken image
 *
 * The sidecar serves these, and it may not be up yet — that is an ordinary state during startup, not
 * an error. A broken-image glyph reads as "this file is gone", which sends someone looking for a
 * problem that does not exist.
 */

/** What a reference is, as far as drawing it is concerned. */
export type ReferenceKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';

export interface ReferenceThumbProps {
  readonly asset: string;
  readonly kind: ReferenceKind;
  /** Where the file can be fetched. Absent while the sidecar is starting, which is not a failure. */
  readonly src?: string | undefined;
  /** Why it is attached — shown as the title, because a note is the point of attaching that one. */
  readonly note?: string | undefined;
  readonly className?: string;
  /**
   * Whether to write the filename across the bottom.
   *
   * Worth it at the inspector's size, where six frames from one shoot are six near-identical
   * thumbnails and the name is what tells them apart. Not worth it on a beat block, where the thumb
   * is a quarter of the size and the name renders as two characters and an ellipsis — which is noise
   * standing where a bit more of the picture could be. The name is still on the element for a
   * pointer and for a screen reader.
   */
  readonly showName?: boolean;
  readonly onOpen?: (asset: string) => void;
}

export function ReferenceThumb({
  asset,
  kind,
  src,
  note,
  className,
  showName = true,
  onOpen,
}: ReferenceThumbProps): ReactNode {
  const [failed, setFailed] = useState(false);
  const showable = (kind === 'image' || kind === 'video') && src !== undefined && !failed;

  return (
    <button
      type="button"
      title={note === undefined ? asset : `${asset} — ${note}`}
      aria-label={note === undefined ? asset : `${asset}, ${note}`}
      onClick={() => onOpen?.(asset)}
      className={cn(
        'bg-muted relative flex size-14 flex-none items-center justify-center overflow-hidden rounded-md border',
        onOpen !== undefined && 'hover:ring-ring cursor-pointer hover:ring-2',
        className,
      )}
    >
      {showable && kind === 'image' && (
        <img src={src} alt="" onError={() => setFailed(true)} className="size-full object-cover" />
      )}

      {showable && kind === 'video' && (
        // Muted and never played: this is a poster, and a wall of autoplaying clips is a board nobody
        // can read. `preload="metadata"` is what makes the first frame appear without fetching the file.
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}

      {!showable && <KindGlyph kind={kind} />}

      {showName && (
        <span className="bg-background/80 text-muted-foreground absolute inset-x-0 bottom-0 truncate px-1 text-[9px] leading-tight">
          {baseName(asset)}
        </span>
      )}
    </button>
  );
}

function KindGlyph({ kind }: { readonly kind: ReferenceKind }): ReactNode {
  const className = 'size-5 text-muted-foreground';
  switch (kind) {
    case 'audio':
      return <MusicIcon className={className} />;
    case 'text':
      return <TypeIcon className={className} />;
    case 'video':
      return <VideoIcon className={className} />;
    case 'image':
      // Reached only when the file could not be drawn, which the glyph should not claim is a mystery.
      return <FileQuestionIcon className={className} />;
    default:
      return <FileQuestionIcon className={className} />;
  }
}

/** The last path segment, on either separator — these come from the project tree. */
export function baseName(asset: string): string {
  const parts = asset.split(/[\\/]/u);
  return parts[parts.length - 1] ?? asset;
}
