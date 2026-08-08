import type { ReactNode } from 'react';
import { DatabaseIcon, RotateCcwIcon, SparklesIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { provenanceRows } from '@nos/generators';
import { AssetDetail, MediaPreview, NoteView } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { cn } from '@nos/ui/lib/utils';
import type { AssetDetail as AssetDetailValue } from './use-asset-detail.js';
import { type CacheStats, formatCacheSize } from './use-cache-stats.js';

/**
 * The browser's footer: what the selected file is, and what the cache costs.
 *
 * Two things a user needs at different moments, in one place because they answer the same underlying
 * question — *is this project going to play back, and what is it costing me?* The asset half appears
 * with a selection; the cache half is always there, because a disposable folder quietly growing to
 * tens of gigabytes is exactly the kind of thing nobody goes looking for.
 */

export interface BrowserDetailProps {
  readonly asset: AssetDetailValue | undefined;
  readonly cache: CacheStats;
  /**
   * Opens a link from a note somewhere that is not this window.
   *
   * Absent leaves them inert, which is the safe default: this renderer *is* the application, so
   * following a link in place would replace the editor with a web page and lose unsaved work — in a
   * window with no back button.
   */
  readonly onOpenLink?: ((href: string) => void) | undefined;
  /**
   * Loads a generated file's settings back into the generator panel.
   *
   * Absent leaves the provenance read-only, which is what it was: the record names the generator, the
   * preset, the seed and every parameter *precisely* so a result can be reproduced, and none of it
   * could be fed back. `reproduce` keeps the seed for the same file again; without it only the seed
   * moves, which is how a variation is asked for.
   */
  readonly onRecall?: ((asset: AssetDetailValue, reproduce: boolean) => void) | undefined;
}

/**
 * What made the selected file.
 *
 * Shown only when there is a record, and it is the answer to the question a folder full of
 * `ad0eb912-5bf6-4d40…` cannot answer: which generator, when, and with what prompt. The prompt gets
 * room and wraps; everything else is a tight label/value pair, because a result is recognised by its
 * prompt long before it is recognised by its step count.
 */
function Provenance({
  asset,
  onRecall,
}: {
  readonly asset: AssetDetailValue;
  readonly onRecall: BrowserDetailProps['onRecall'];
}): ReactNode {
  const record = asset.provenance;
  if (record === undefined) return null;

  return (
    <>
      <Separator />
      {/* Bounded and scrollable: a manifest may declare twenty parameters, and a panel that grew with
          the generator would push the cache line — which is always relevant — off the screen. */}
      <ScrollArea className="max-h-42">
        <div className="flex flex-col gap-2 font-mono text-xs">
          {provenanceRows(record).map((row) => (
            <div
              key={`${row.label}:${row.value}`}
              className={cn('flex gap-2', row.long === true ? 'flex-col items-start' : 'items-baseline')}
            >
              <span className="text-muted-foreground">{row.label}</span>
              <span
                className={cn(
                  row.long === true ? 'break-words whitespace-pre-wrap text-chart-4' : 'truncate',
                )}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>

      {onRecall !== undefined && (
        <div className="flex gap-2">
          {/* Two buttons rather than one with a modifier: they answer different questions, and which
              one a user wants is the whole decision. "Again" is the rarer of the two — a take is
              usually recalled to make another like it, not to make it twice. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRecall(asset, false)}
            title="Load these settings into the generator, leaving the seed free so the result varies"
          >
            <SparklesIcon />
            Make another
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={record.seed === undefined}
            onClick={() => onRecall(asset, true)}
            title={
              record.seed === undefined
                ? 'This generator recorded no seed, so the run cannot be reproduced exactly'
                : `Reproduce this exact file, pinned to seed ${record.seed}`
            }
          >
            <RotateCcwIcon />
            Again
          </Button>
        </div>
      )}
    </>
  );
}

export function BrowserDetail({ asset, cache, onOpenLink, onRecall }: BrowserDetailProps): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {asset === undefined ? (
        <p className="font-mono text-xs text-muted-foreground">select a file to see what it is</p>
      ) : (
        <>
          {/* First, because it answers "what is this?" faster than any of the lines under it — and for
              a folder of generated files whose names are job ids, it is the only thing that does. */}
          <MediaPreview url={asset.url} assetType={asset.assetType} name={asset.name} />
          <AssetDetail
            name={asset.name}
            isGenerated={asset.isGenerated}
            {...(asset.summary !== undefined ? { summary: asset.summary } : {})}
            {...(asset.hash !== undefined ? { hash: asset.hash } : {})}
            {...(asset.hasProxy !== undefined ? { hasProxy: asset.hasProxy } : {})}
            {...(asset.hasFilmstrip !== undefined ? { hasFilmstrip: asset.hasFilmstrip } : {})}
          />
        </>
      )}

      {asset?.note !== undefined && (
        <>
          <Separator />
          {/* Bounded like the provenance block, and for the same reason: a note is prose of any
              length, and one that grew with the file would push the cache line — which is always
              relevant — off the screen. */}
          <ScrollArea className="max-h-64">
            <NoteView blocks={asset.note} {...(onOpenLink !== undefined ? { onOpenLink } : {})} />
          </ScrollArea>
        </>
      )}

      {asset?.provenance !== undefined && <Provenance asset={asset} onRecall={onRecall} />}

      <Separator />
      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <DatabaseIcon className="size-3.5" />
        <span>
          {formatCacheSize(cache.sizeBytes)} · {cache.fileCount} {cache.fileCount === 1 ? 'file' : 'files'}
        </span>
        {cache.error !== undefined && (
          <span className="ml-auto flex items-center gap-1 text-destructive">
            <TriangleAlertIcon className="size-3.5" />
            {cache.error}
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          className={cn(cache.error === undefined && 'ml-auto')}
          onClick={() => void cache.clear()}
          disabled={cache.clearing || cache.fileCount === 0}
          // The reassurance belongs on the control, where the hesitation is. Everything under
          // `cache/` is regenerable — that is what makes the folder disposable and `generated/` not.
          title="Delete every derived proxy, filmstrip and waveform. They are rebuilt on demand."
        >
          <Trash2Icon />
          {cache.clearing ? 'clearing…' : 'Clear'}
        </Button>
      </div>
    </div>
  );
}
