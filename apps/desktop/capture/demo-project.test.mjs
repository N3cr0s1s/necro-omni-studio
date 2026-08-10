import { describe, expect, it } from 'vitest';
import { describeLoadError, loadDocument } from '@nos/core';
import { demoProject } from './demo-project.mjs';

/**
 * The project the README pictures are taken of.
 *
 * Checked by the suite rather than by watching a window fail to open. The first attempt at this
 * document was rejected by the loader, and the only symptom was a capture run that timed out waiting
 * for clips that were never going to appear — thirty seconds and a launch to learn what
 * `describeLoadError` says in a millisecond.
 *
 * It also stops the fixture rotting: the shape of a clip is the document model's, and this is written
 * by hand, so the day a required field is added the picture would otherwise silently become a
 * screenshot of an empty timeline.
 */
describe('the demo project', () => {
  it('loads, so the capture has something to photograph', () => {
    const result = loadDocument(JSON.stringify(demoProject()));
    expect(result.ok ? 'ok' : describeLoadError(result.error)).toBe('ok');
  });

  it('looks like work rather than like a diagram', () => {
    const result = loadDocument(JSON.stringify(demoProject()));
    if (!result.ok) throw new Error(describeLoadError(result.error));

    const clips = result.value.document.sequence.tracks.flatMap((track) => track.clips ?? []);
    // Four shots, an audio bed and a title. A screenshot of one clip says nothing about an editor.
    expect(clips.length).toBeGreaterThanOrEqual(6);
    expect(result.value.document.sequence.markers.length).toBeGreaterThan(0);
  });

  it('overlaps two shots, so the dissolve is visible in the picture', () => {
    const result = loadDocument(JSON.stringify(demoProject()));
    if (!result.ok) throw new Error(describeLoadError(result.error));

    const video = result.value.document.sequence.tracks.find((track) => track.kind === 'video');
    const [first, second] = video.clips;
    expect(second.span.start).toBeLessThan(first.span.start + first.span.duration);
  });
});
