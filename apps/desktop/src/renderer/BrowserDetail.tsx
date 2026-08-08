import type { ReactNode } from 'react';
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
