import {
  type AssetPath,
  type Clip,
  type FrameIndex,
  type FrameRate,
  type TimelineDocument,
  type VideoTrack,
  assetPath,
  containsFrame,
  frameIndex,
  framesToSeconds,
  multiply,
  rational,
  secondsToFrames,
  toNumber,
} from '@nos/core';

/**
 * The frame under the playhead, as something a generator can be pointed at.
 *
 * The need is the user's: standing on a video, use *this* frame as the first frame of an
 * image-to-video run. That is not a file until someone writes one, so the decision splits in two —
 * what the playhead is over (here), and lifting it out with ffmpeg (the sidecar). Only the first
 * half is a judgement, and only the first half is worth testing without a decoder.
 *
 * Three things are decided here and nowhere else:
 *
 * - **Which clip.** The topmost enabled video clip covering the playhead, which is the one the
 *   preview is showing. Anything else would hand back a frame the user is not looking at.
 * - **Which source frame.** The clip's own `sourceIn` plus the offset into it, converted at the
 *   *source's* rate. A 24 fps source on a 30 fps timeline is the case where a naive subtraction is
 *   wrong, and wrong by more the further into the clip you are.
 * - **What the file is called.** Derived from the source and the frame, so grabbing the same frame
 *   twice is the same file — no duplicates piling up in the project while a user compares two
 *   candidates.
 */

/** Where grabbed frames live. Inside `media/`, because a still is source material, not output. */
export const STILLS_FOLDER = 'media/stills';

export interface FrameGrabTarget {
  /** The video the frame comes from. */
  readonly asset: AssetPath;
  /** Frame within that source, at the source's own rate. */
  readonly sourceFrame: FrameIndex;
  /** Timestamp to seek to, which is what ffmpeg is given. */
  readonly seconds: number;
  /** Where the image will be written, project-relative. */
  readonly destination: AssetPath;
  /** The clip the frame was taken from, for a label the user can recognise. */
  readonly clip: Clip;
}

/**
 * What grabbing the frame at `playhead` would capture, or `undefined` when nothing is under it.
 *
 * `undefined` rather than an error: having no video under the playhead is an ordinary state, not a
 * failure, and the caller's response is to disable a button rather than to report anything.
 */
export function frameGrabTarget(
  document: TimelineDocument,
  playhead: FrameIndex,
): FrameGrabTarget | undefined {
  const found = topmostVideoClip(document, playhead);
  if (found === undefined) return undefined;

  const sourceFrame = sourceFrameAt(found, playhead, document.frameRate);
  return {
    asset: found.source.asset,
    sourceFrame,
    seconds: toNumber(framesToSeconds(sourceFrame, found.source.sourceRate)),
    destination: stillPath(found.source.asset, sourceFrame),
    clip: found,
  };
}

/**
 * The topmost enabled video clip covering a frame.
 *
 * Topmost means the last track that has one: tracks are ordered bottom-to-top in the document and
 * the compositor draws them in that order, so the last match is what is actually on screen. A
 * disabled clip is skipped for the same reason — it is not being shown.
 */
function topmostVideoClip(
  document: TimelineDocument,
  playhead: FrameIndex,
): (Clip & { readonly kind: 'video' }) | undefined {
  let found: (Clip & { readonly kind: 'video' }) | undefined;

  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of (track as VideoTrack).clips) {
      if (clip.kind !== 'video') continue;
      if (!clip.enabled) continue;
      if (!containsFrame(clip.span, playhead)) continue;
      found = clip;
    }
  }

  return found;
}

/**
 * The frame of the *source* showing at a timeline frame.
 *
 * The conversion runs through exact seconds rather than a frame-count ratio: the offset is measured
 * at the project rate, turned into time, and re-expressed at the source's rate. Subtracting frame
 * numbers directly is right only while the two rates agree, and silently drifts otherwise — a 24 fps
 * source ten seconds into a 30 fps timeline would be sixty frames out.
 *
 * Speed is applied where the clip has it: a clip playing at half speed reaches source frame 50 after
 * 100 timeline frames, and grabbing frame 100 would return a frame the user has not reached.
 */
function sourceFrameAt(
  clip: Clip & { readonly kind: 'video' },
  playhead: FrameIndex,
  projectRate: FrameRate,
): FrameIndex {
  const offset = frameIndex(Math.max(0, playhead - clip.span.start));
  const factor = clip.speed?.factor ?? 1;
  // Rational throughout: this is the same arithmetic the compositor does to pick a frame, and a
  // float rounding differently here would grab the frame next to the one on screen.
  const elapsed = multiply(framesToSeconds(offset, projectRate), rational(Math.round(factor * 1e6), 1e6));
  const advanced = secondsToFrames(elapsed, clip.source.sourceRate);
  return frameIndex(clip.source.sourceIn + advanced);
}

/**
 * Where a grabbed frame is written.
 *
 * Named after the source and the frame, which makes the grab idempotent: asking for the same frame
 * twice produces the same path, so a user stepping between two candidates ends up with two files
 * rather than one per click. The name is also readable months later, which a hash would not be.
 */
export function stillPath(source: AssetPath, sourceFrame: FrameIndex): AssetPath {
  const base = source.split('/').pop() ?? source;
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return assetPath(`${STILLS_FOLDER}/${sanitize(stem)}_${String(sourceFrame).padStart(6, '0')}.png`);
}

/**
 * Reduces a filename to what is safe on every target platform.
 *
 * Project files are named by the user and reach here unchanged — a colon is legal on Linux and
 * fatal on Windows, and a name that opens a project on one machine must not break it on another.
 */
function sanitize(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned === '' ? 'frame' : cleaned;
}

/** One line naming what a grab would capture, for a button that must say what it will do. */
export function describeFrameGrab(target: FrameGrabTarget): string {
  const name = target.asset.split('/').pop() ?? target.asset;
  return `frame ${target.sourceFrame} of ${name}`;
}
