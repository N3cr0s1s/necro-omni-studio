import { type ReactNode, useState } from 'react';
import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import type { AssetType } from '@nos/media';
import { AspectRatio } from '@nos/ui/components/ui/aspect-ratio';
import { Skeleton } from '@nos/ui/components/ui/skeleton';
import { cn } from '@nos/ui/lib/utils';

/**
 * The selected file, played.
 *
 * The browser could say a file was 1920×1080 at 29.97 and could not show it. For a folder of
 * `ad0eb912-5bf6-4d40…` that a generator produced, the metadata is the least useful thing about a
 * file — the only way to tell two takes apart is to look at them, and the only way to tell two music
 * beds apart is to hear them.
 *
 * ## Why the browser's own element and not the compositor
 *
 * The preview above the timeline renders the *edit*: the composite at the playhead, through the
 * effect stack, at project resolution. This answers a different question — "what is this file?" —
 * about material that is usually not on the timeline at all. A `<video>` element also gives seeking
 * and playback for free, which is the whole of what is wanted here and would otherwise mean a second
 * transport.
 */

export interface MediaPreviewProps {
  /** Absent while the sidecar is starting, which is a state worth saying rather than a broken image. */
  readonly url: string | undefined;
  readonly assetType: AssetType | undefined;
  /** Shown as the accessible name, since the file's own name is the only thing identifying it. */
  readonly name: string;
  readonly className?: string | undefined;
}

export function MediaPreview({ url, assetType, name, className }: MediaPreviewProps): ReactNode {
  // Keyed by URL so switching files clears a previous failure: a broken take must not make the next
  // one look broken too.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const broken = failed !== undefined && failed === url;

  if (assetType === undefined || !PLAYABLE.has(assetType)) return null;

  if (url === undefined) {
    return (
      <Frame className={className}>
        <Skeleton className="size-full" />
      </Frame>
    );
  }

  if (broken) {
    return (
      <Frame className={className}>
        <p className="flex items-center gap-1.5 p-2 text-center font-mono text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          this file could not be played
        </p>
      </Frame>
    );
  }

  if (assetType === 'audio') {
    // No frame: an audio element is a strip of controls, and boxing it in a 16:9 rectangle would
    // reserve the height of a picture for something that has none.
    return (
      <audio
        // `metadata`, not `auto`: a browser full of music beds would otherwise start downloading every
        // one the moment a row is selected.
        preload="metadata"
        controls
        src={url}
        aria-label={`Play ${name}`}
        onError={() => setFailed(url)}
        className={cn('h-8 w-full', className)}
      />
    );
  }

  return (
    <Frame className={className}>
      {assetType === 'image' ? (
        <img
          src={url}
          alt={name}
          onError={() => setFailed(url)}
          className="size-full object-contain"
          draggable={false}
        />
      ) : (
        <video
          preload="metadata"
          controls
          src={url}
          aria-label={`Play ${name}`}
          onError={() => setFailed(url)}
          className="size-full object-contain"
        />
      )}
    </Frame>
  );
}

/** The types there is something to show for. A mask is a file, but not one a user reads by looking. */
const PLAYABLE: ReadonlySet<AssetType> = new Set<AssetType>(['video', 'image', 'audio']);

/**
 * A fixed box for the picture.
 *
 * 16:9 regardless of the file's own shape, with the content letterboxed inside it. A box that took
 * each file's aspect would change height as the selection moved through a folder, so everything below
 * it — the metadata, the provenance, the cache line — would jump with every arrow key.
 */
function Frame({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <AspectRatio ratio={16 / 9} className={cn('overflow-hidden rounded-md border bg-black', className)}>
      <div className="flex size-full items-center justify-center">{children}</div>
    </AspectRatio>
  );
}

/** Whether anything would be shown, so a caller can leave the space out entirely. */
export function hasPreview(assetType: AssetType | undefined): boolean {
  return assetType !== undefined && PLAYABLE.has(assetType);
}

/** Exported for a caller that wants the same "nothing to show" glyph elsewhere. */
export const UNKNOWN_PREVIEW_ICON = FileQuestionIcon;
