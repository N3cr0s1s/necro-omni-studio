import type { ReactNode } from 'react';
import type { AssetType } from '@nos/media';
import { assetSwatch, folderSwatch, token } from '../tokens/tokens.js';

/**
 * The mark beside a row in the browser.
 *
 * A coloured square told the user there were four kinds of thing without saying which was which:
 * every row looked the same until you had learned the palette, and nothing in the window taught it.
 * A glyph names the kind at a glance and keeps the colour, so the two reinforce each other rather
 * than the colour carrying the meaning alone — which also makes the browser readable to someone who
 * cannot separate the hues.
 *
 * Drawn as inline SVG rather than an icon font or an image: it inherits `currentColor`, scales with
 * the row, needs no network, and adds no file to a project folder that is the user's.
 */

export interface AssetIconProps {
  /** Absent for a directory. */
  readonly assetType?: AssetType | undefined;
  readonly isDirectory?: boolean;
  /** The folder's own name, so the reserved project folders keep their established colours. */
  readonly name?: string;
  readonly open?: boolean;
  readonly sizePx?: number;
}

export function AssetIcon({
  assetType,
  isDirectory = false,
  name = '',
  open = false,
  sizePx = 13,
}: AssetIconProps): ReactNode {
  const colour = isDirectory ? folderSwatch(name) : assetSwatch(assetType);

  return (
    <svg
      width={sizePx}
      height={sizePx}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-asset-icon={isDirectory ? 'folder' : (assetType ?? 'unknown')}
      style={{ flex: 'none', color: colour, display: 'block' }}
    >
      {isDirectory ? <FolderGlyph open={open} /> : <FileGlyph assetType={assetType} />}
    </svg>
  );
}

/** An open folder leans, so expansion is visible in the icon as well as in the chevron. */
function FolderGlyph({ open }: { readonly open: boolean }): ReactNode {
  return open ? (
    <path
      d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3.1l1.4 1.6h4.6a1.2 1.2 0 0 1 1.2 1.2v.6H4.6L2.4 13H2a1 1 0 0 1-1-1zM4 13l2.1-5.4h8.4L12.4 13z"
      fill="currentColor"
    />
  ) : (
    <path
      d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3.1l1.4 1.6h5.1a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z"
      fill="currentColor"
    />
  );
}

/**
 * One glyph per kind the application can act on.
 *
 * Each is the thing the file *is* rather than an application that opens it: a frame with sprocket
 * holes for video, a waveform for audio, a picture for a still, lines for a note. An unknown file
 * gets a plain page, which is honest — it is a file, and that is all this application knows.
 */
function FileGlyph({ assetType }: { readonly assetType: AssetType | undefined }): ReactNode {
  switch (assetType) {
    case 'video':
      return (
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.4" fill="currentColor" opacity="0.85" />
          <g fill={token.bgPanel}>
            <rect x="3" y="4.4" width="1.6" height="1.6" rx="0.4" />
            <rect x="3" y="10" width="1.6" height="1.6" rx="0.4" />
            <rect x="11.4" y="4.4" width="1.6" height="1.6" rx="0.4" />
            <rect x="11.4" y="10" width="1.6" height="1.6" rx="0.4" />
            <rect x="5.4" y="6.6" width="5.2" height="2.8" rx="0.4" />
          </g>
        </>
      );
    case 'audio':
      // A waveform rather than a speaker: the file is the sound, not a way of playing it.
      return (
        <g fill="currentColor">
          <rect x="1.5" y="7" width="1.5" height="2" rx="0.75" />
          <rect x="4" y="5" width="1.5" height="6" rx="0.75" />
          <rect x="6.5" y="2.5" width="1.5" height="11" rx="0.75" />
          <rect x="9" y="4.5" width="1.5" height="7" rx="0.75" />
          <rect x="11.5" y="6.5" width="1.5" height="3" rx="0.75" />
        </g>
      );
    case 'image':
      return (
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.4" fill="currentColor" opacity="0.85" />
          <circle cx="5.4" cy="6.2" r="1.2" fill={token.bgPanel} />
          <path d="M2.6 12.2l3.5-3.6 2.2 2.2 2.4-2.6 2.8 4z" fill={token.bgPanel} />
        </>
      );
    case 'text':
      return (
        <>
          <path
            d="M3 1.8h6.2L13 5.6v8.6a.6.6 0 0 1-.6.6H3a.6.6 0 0 1-.6-.6V2.4A.6.6 0 0 1 3 1.8z"
            fill="currentColor"
            opacity="0.85"
          />
          <g fill={token.bgPanel}>
            <rect x="4.2" y="7" width="6.4" height="1" rx="0.5" />
            <rect x="4.2" y="9.2" width="6.4" height="1" rx="0.5" />
            <rect x="4.2" y="11.4" width="4" height="1" rx="0.5" />
          </g>
        </>
      );
    default:
      return (
        <path
          d="M3.4 1.8h5.4L12.6 5.6v8.6a.6.6 0 0 1-.6.6H3.4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6zm5.2 1v2.6h2.6z"
          fill="currentColor"
          opacity="0.8"
        />
      );
  }
}
