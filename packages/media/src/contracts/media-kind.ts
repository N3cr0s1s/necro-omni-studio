import { type AssetPath, type AssetType } from '@nos/core';

// Re-exported so existing media consumers keep one import site, while core owns the vocabulary.
export { ASSET_TYPES, isAssetType, type AssetType } from '@nos/core';

/**
 * Extension-to-type mapping.
 *
 * Classification is by extension rather than by content sniffing, because the media
 * browser mirrors the project folder live and must label thousands of entries without
 * opening any of them. A real probe corrects the guess when a file is actually imported —
 * that is the only point where being wrong has consequences.
 */
const EXTENSION_TYPES: Readonly<Record<string, AssetType>> = {
  // Video containers. `.mov` and `.mkv` may hold audio only; the probe settles it.
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  avi: 'video',
  m4v: 'video',
  mpg: 'video',
  mpeg: 'video',
  ts: 'video',
  mts: 'video',
  m2ts: 'video',
  wmv: 'video',

  // Audio. FLAC first among equals: the spec requires generator audio to be lossless.
  flac: 'audio',
  wav: 'audio',
  aiff: 'audio',
  aif: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  opus: 'audio',

  image: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  tif: 'image',
  tiff: 'image',
  bmp: 'image',
  exr: 'image',
  tga: 'image',

  // Free-form notes. The spec requires the browser to render markdown.
  md: 'text',
  markdown: 'text',
  txt: 'text',
  srt: 'text',
  vtt: 'text',
  json: 'text',
};

/** Lower-case extension without the dot, or `undefined` for a name with no extension. */
export function fileExtension(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // A leading dot means a hidden file, not an extension: `.gitignore` has none.
  if (dot <= 0) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Name without its extension, for deriving a clip label from a file. */
export function fileStem(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * Best-effort type for a path. `undefined` means "the browser shows it but the timeline
 * cannot accept it", which is a legitimate state: the spec allows arbitrary files in the
 * project folder.
 */
export function classifyAsset(path: AssetPath | string): AssetType | undefined {
  const extension = fileExtension(path);
  if (extension === undefined) return undefined;
  return EXTENSION_TYPES[extension];
}

export function isTimelineAsset(path: AssetPath | string): boolean {
  const type = classifyAsset(path);
  return type === 'video' || type === 'audio' || type === 'image';
}

/** Extensions offered in an import dialog, grouped for a file filter. */
export function extensionsForType(type: AssetType): readonly string[] {
  return Object.entries(EXTENSION_TYPES)
    .filter(([, value]) => value === type)
    .map(([extension]) => extension)
    .sort();
}
