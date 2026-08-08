import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Where a project file can be fetched from.
 *
 * The sidecar serves the project folder over loopback, and every consumer in the renderer — the
 * texture decoder, the audio engine, the audition player, the filmstrip fetcher and now the browser's
 * preview — needs the same URL. It was written out four times, identically, which is four places to
 * change when the endpoint or the token's header moves and four chances to miss one.
 *
 * Returns `undefined` rather than a broken URL when there is no sidecar. A caller that renders an
 * `<img>` with `src=""` gets a broken-image glyph and a console error; one that is handed nothing can
 * say the file cannot be shown yet, which is the truth while the sidecar is starting.
 */
export function fileUrl(sidecar: SidecarInfo | undefined, asset: string): string | undefined {
  if (sidecar === undefined || !sidecar.available || asset === '') return undefined;

  // The token travels in the query rather than a header because these URLs are handed to `<img>`,
  // `<video>` and `<audio>`, none of which can set one. It is a loopback secret regenerated per
  // session, not a credential.
  return `${sidecar.baseUrl}/media/file?asset=${encodeURIComponent(asset)}&token=${encodeURIComponent(sidecar.token)}`;
}
