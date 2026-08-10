import { describe, expect, it } from 'vitest';
import { APP_CLIPS, BEDS, BLOCKS, FPS, SOURCE_FRAMES, TOTAL_FRAMES, shots, titles } from './edit.mjs';

/**
 * The promo's edit.
 *
 * Arithmetic that has to come out exactly: three minutes, no gaps, no overlaps, and every asset the
 * cut names actually generated. Checked here rather than by exporting and measuring the file, because a
 * three-minute export is minutes of render to find out that a shot started one frame late.
 */

describe('the promo edit', () => {
  it('is exactly three minutes', () => {
    const total = shots().reduce((sum, shot) => sum + shot.frames, 0);
    expect(total).toBe(TOTAL_FRAMES);
    expect(TOTAL_FRAMES / FPS).toBe(180);
  });

  it('leaves no gap and no overlap between shots', () => {
    // A gap is a black frame in the middle of a promo and an overlap is a shot nobody sees the end of.
    const all = shots();
    const faults = all.filter(
      (shot, index) => index > 0 && shot.start !== all[index - 1].start + all[index - 1].frames,
    );
    expect(faults).toEqual([]);
  });

  it('starts at zero', () => {
    expect(shots()[0].start).toBe(0);
  });

  it('names only media the generators produce', () => {
    const expected = new Set([
      ...BEDS.map((name) => `media/bed_${name}.mp4`),
      ...APP_CLIPS.map((name) => `media/app_${name}.mp4`),
    ]);
    const named = new Set(shots().map((shot) => shot.asset));
    expect([...named].filter((asset) => !expected.has(asset))).toEqual([]);
  });

  it('uses every bed and every screen recording, so nothing was generated for nothing', () => {
    const named = new Set(shots().map((shot) => shot.asset));
    for (const name of BEDS) expect(named.has(`media/bed_${name}.mp4`)).toBe(true);
    for (const name of APP_CLIPS) expect(named.has(`media/app_${name}.mp4`)).toBe(true);
  });

  it('keeps the application on screen regularly, rather than in one block', () => {
    // A promo for an editor that shows the editor only at the end is a promo for something else.
    const appShots = shots().filter((shot) => shot.kind === 'app');
    expect(appShots.length).toBe(BLOCKS.length * 3);
    const sections = new Set(appShots.map((shot) => shot.section));
    expect(sections.size).toBe(BLOCKS.length);
  });

  it('never asks a shot for more material than its source holds', () => {
    // The fault the first version of this cut had: 150-frame shots off a 120-frame bed, so thirty of
    // the forty shots ran a whole second past their own media. Nothing refuses that — the clip simply
    // shows whatever a source has after it ends.
    for (const shot of shots()) {
      expect(shot.frames, `${shot.asset} at ${shot.start}`).toBeLessThanOrEqual(SOURCE_FRAMES[shot.kind]);
    }
  });

  it('puts one title in each section, inside the sequence', () => {
    const all = titles();
    expect(all.length).toBe(BLOCKS.length);
    for (const title of all) {
      expect(title.start).toBeGreaterThanOrEqual(0);
      expect(title.start + title.frames).toBeLessThanOrEqual(TOTAL_FRAMES);
      expect(title.text.length).toBeGreaterThan(0);
    }
  });

  it('gives every narration block something to say', () => {
    for (const block of BLOCKS) {
      expect(block.title.length).toBeGreaterThan(0);
      expect(block.line.split(' ').length).toBeGreaterThan(3);
    }
  });
});
