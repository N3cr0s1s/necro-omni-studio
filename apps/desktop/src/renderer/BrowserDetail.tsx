import type { ReactNode } from 'react';
import { provenanceRows } from '@nos/generators';
import { AssetDetail, Button, Mono } from '@nos/ui';
import { token } from '@nos/ui';
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
}

/**
 * What made the selected file.
 *
 * Shown only when there is a record, and it is the answer to the question a folder full of
 * `ad0eb912-5bf6-4d40…` cannot answer: which generator, when, and with what prompt. The prompt gets
 * room and wraps; everything else is a tight label/value pair, because a result is recognised by its
 * prompt long before it is recognised by its step count.
 */
function Provenance({ asset }: { readonly asset: AssetDetailValue }): ReactNode {
  const record = asset.provenance;
  if (record === undefined) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: token.space2,
        paddingTop: token.space3,
        borderTop: `1px solid ${token.borderSubtle}`,
        // Bounded and scrollable: a manifest may declare twenty parameters, and a panel that grew
        // with the generator would push the cache line — which is always relevant — off the screen.
        maxHeight: 168,
        overflowY: 'auto',
      }}
    >
      {provenanceRows(record).map((row) => (
        <div
          key={`${row.label}:${row.value}`}
          style={{
            display: 'flex',
            gap: token.space2,
            alignItems: row.long === true ? 'flex-start' : 'baseline',
            flexDirection: row.long === true ? 'column' : 'row',
          }}
        >
          <Mono tone={token.textFaint}>{row.label}</Mono>
          <Mono
            tone={row.long === true ? token.generatedText : token.textDim}
            style={
              row.long === true
                ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            }
          >
            {row.value}
          </Mono>
        </div>
      ))}
    </div>
  );
}

export function BrowserDetail({ asset, cache }: BrowserDetailProps): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space3 }}>
      {asset === undefined ? (
        <Mono tone={token.textGhost}>select a file to see what it is</Mono>
      ) : (
        <AssetDetail
          name={asset.name}
          isGenerated={asset.isGenerated}
          {...(asset.summary !== undefined ? { summary: asset.summary } : {})}
          {...(asset.hash !== undefined ? { hash: asset.hash } : {})}
          {...(asset.hasProxy !== undefined ? { hasProxy: asset.hasProxy } : {})}
          {...(asset.hasFilmstrip !== undefined ? { hasFilmstrip: asset.hasFilmstrip } : {})}
        />
      )}

      {asset?.provenance !== undefined && <Provenance asset={asset} />}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.space3,
          borderTop: `1px solid ${token.borderSubtle}`,
          paddingTop: token.space3,
        }}
      >
        <Mono tone={token.textFaint}>cache</Mono>
        <Mono tone={token.textDim}>
          {formatCacheSize(cache.sizeBytes)} · {cache.fileCount} {cache.fileCount === 1 ? 'file' : 'files'}
        </Mono>
        <div style={{ flex: 1 }} />
        {cache.error !== undefined && <Mono tone={token.danger}>{cache.error}</Mono>}
        <Button
          onClick={() => void cache.clear()}
          disabled={cache.clearing || cache.fileCount === 0}
          // The reassurance belongs on the control, where the hesitation is. Everything under
          // `cache/` is regenerable — that is what makes the folder disposable and `generated/` not.
          title="Delete every derived proxy, filmstrip and waveform. They are rebuilt on demand."
        >
          {cache.clearing ? 'clearing…' : 'Clear'}
        </Button>
      </div>
    </div>
  );
}
