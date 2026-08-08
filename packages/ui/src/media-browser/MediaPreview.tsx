import { type ReactNode, type RefObject, useState } from 'react';
import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import type { AssetType } from '@nos/media';
import { AspectRatio } from '@nos/ui/components/ui/aspect-ratio';
import { Skeleton } from '@nos/ui/components/ui/skeleton';
import { cn } from '@nos/ui/lib/utils';
import { TransportBar } from './TransportBar.js';
import { useMediaTransport } from './use-media-transport.js';

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
 * about material that is usually not on the timeline at all. A `<video>` element decodes and seeks it
 * for free, which is the whole of what is wanted here.
 *
 * Its `controls` attribute is a different matter and is not used. Chromium's bar is fixed chrome: it
 * ignores the theme, matches nothing else on the panel, and sizes itself — so the one place a user goes
 * to hear a take looked like a different program. `TransportBar` draws that from the same primitives as
 * everything else, and `useMediaTransport` keeps the element the source of truth behind it.
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

  if (assetType === 'image') {
    return (
      <Frame className={className}>
        <img
          src={url}
          alt={name}
          onError={() => setFailed(url)}
          className="size-full object-contain"
          draggable={false}
        />
      </Frame>
    );
  }

  return <Playable url={url} assetType={assetType} name={name} onFail={setFailed} className={className} />;
}

/**
 * A file with a transport.
 *
 * Its own component because the transport is a hook, and a hook cannot live behind the early returns
 * above — a selection moving from a picture to a sound would change how many hooks this render calls.
 */
function Playable({
  url,
  assetType,
  name,
  onFail,
  className,
}: {
  readonly url: string;
  readonly assetType: AssetType;
  readonly name: string;
  readonly onFail: (url: string) => void;
  readonly className?: string | undefined;
}): ReactNode {
  const transport = useMediaTransport(url);

  // An `<audio>` and a `<video>` are both media elements, but their ref types are siblings rather than
  // one being the other — so the shared ref is narrowed at the element instead of the hook being
  // written twice.
  const audioRef = transport.ref as RefObject<HTMLAudioElement | null>;
  const videoRef = transport.ref as RefObject<HTMLVideoElement | null>;

  if (assetType === 'audio') {
    // No frame: sound has no picture, and boxing the bar in a 16:9 rectangle would reserve the height
    // of one for it. The element itself draws nothing without `controls`.
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <audio
          ref={audioRef}
          // `metadata`, not `auto`: a browser full of music beds would otherwise start downloading
          // every one the moment a row is selected.
          preload="metadata"
          src={url}
          aria-label={name}
          onError={() => onFail(url)}
        />
        <TransportBar state={transport.state} controls={transport.controls} label={name} />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Frame>
        <video
          ref={videoRef}
          preload="metadata"
          src={url}
          aria-label={name}
          onError={() => onFail(url)}
          className="size-full object-contain"
        />
      </Frame>
      <TransportBar state={transport.state} controls={transport.controls} label={name} />
    </div>
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
