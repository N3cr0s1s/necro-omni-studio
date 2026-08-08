import type { ReactNode } from 'react';
import { assetGlyph, folderGlyph } from '../semantics/glyphs.js';
import { cn } from '@nos/ui/lib/utils';

/**
 * The mark beside a row in the browser.
 *
 * A coloured square told the user there were four kinds of thing without saying which was which:
 * every row looked the same until you had learned the palette, and nothing in the window taught it.
 * A glyph names the kind at a glance and keeps the colour, so the two reinforce each other rather
 * than the colour carrying the meaning alone — which also makes the browser readable to someone who
 * cannot separate the hues.
 *
 * The glyph and its colour both come from `semantics/glyphs`, so the browser, the timeline and the
 * inspector cannot disagree about what a mask or a generated asset looks like.
 */

export interface AssetIconProps {
  /** Absent for a directory. */
  readonly assetType?: Parameters<typeof assetGlyph>[0];
  readonly isDirectory?: boolean;
  /** The folder's own name, so the reserved project folders keep their established meanings. */
  readonly name?: string;
  readonly open?: boolean;
  readonly className?: string | undefined;
}

export function AssetIcon({
  assetType,
  isDirectory = false,
  name = '',
  open = false,
  className,
}: AssetIconProps): ReactNode {
  const glyph = isDirectory ? folderGlyph(name) : assetGlyph(assetType);
  // An open folder opens. Expansion is then visible in the icon as well as in the chevron, which
  // matters at this size — the chevron's two states differ by a rotation of a few pixels.
  const Icon = (open ? glyph.openIcon : undefined) ?? glyph.icon;

  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      data-asset-icon={isDirectory ? 'folder' : (assetType ?? 'unknown')}
      className={cn('size-3.5 shrink-0', glyph.tone, className)}
    />
  );
}
