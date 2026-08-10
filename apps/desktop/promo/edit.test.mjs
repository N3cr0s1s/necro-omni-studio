import { describe, expect, it } from 'vitest';
import {
  APP_CLIPS,
  BEDS,
  BLOCKS,
  FPS,
  MAX_APPEARANCES,
  MUSIC,
  SECTION_FRAMES,
  SOURCE_FRAMES,
  TOTAL_FRAMES,
  accents,
  honestLength,
  shots,
  titles,
} from './edit.mjs';

/**
 * The promo's edit.
 *
 * Arithmetic that has to come out exactly, and one judgement that has to hold whatever the folder
 * contains: no source is shown more than four times. Checked here rather than by exporting and measuring
 * the file, because a three-minute export is minutes of render to find out that a shot started a frame
 * late.
 */

const countBy = (all) => {
  const counts = new Map();
  for (const shot of all) counts.set(shot.label, (counts.get(shot.label) ?? 0) + 1);
  return counts;
};

describe('the full cut', () => {
  it('fills the three minutes the issue asks for', () => {
    const all = shots();
    expect(all.reduce((sum, shot) => sum + shot.frames, 0)).toBe(TOTAL_FRAMES);
    expect(TOTAL_FRAMES / FPS).toBe(180);
  });

  it('leaves no gap and no overlap', () => {
    // A gap is a black frame in the middle of a promo; an overlap is a shot nobody sees the end of.
    const all = shots();
    const faults = all.filter(
      (shot, index) => index > 0 && shot.start !== all[index - 1].start + all[index - 1].frames,
    );
    expect(faults).toEqual([]);
    expect(all[0].start).toBe(0);
  });

  it('never asks a shot for more material than its source holds', () => {
    // The fault the first version had: 150-frame shots off a 120-frame bed, thirty times over. Nothing
    // refuses that — the clip simply runs past its own media.
    for (const shot of shots()) {
      expect(shot.frames, `${shot.asset} at ${shot.start}`).toBeLessThanOrEqual(SOURCE_FRAMES[shot.kind]);
    }
  });

  it('shows no source more often than its kind allows', () => {
    // The fifth showing of the same four seconds is where a viewer stops reading it as an edit.
    const kindOf = new Map(shots().map((shot) => [shot.label, shot.kind]));
    for (const [label, count] of countBy(shots())) {
      expect(count, label).toBeLessThanOrEqual(MAX_APPEARANCES[kindOf.get(label)]);
    }
  });

  it('keeps the application on screen throughout, not in one block', () => {
    // A promo for an editor that shows the editor only at the end is a promo for something else.
    const sections = new Set(
      shots()
        .filter((shot) => shot.kind === 'app')
        .map((shot) => shot.section),
    );
    expect(sections.size).toBeGreaterThanOrEqual(BLOCKS.length - 1);
  });
});

describe('a cut from less material', () => {
  const one = () => {
    const frames = honestLength(1, APP_CLIPS.length);
    return { frames, all: shots({ beds: ['bands'], frames }) };
  };

  it('shortens rather than repeating one bed thirty times', () => {
    // The day's actual situation: one bed generated of twelve. Three minutes from it would be padding
    // wearing the shape of an edit.
    const { frames } = one();
    expect(frames).toBeLessThan(TOTAL_FRAMES);
    expect(frames % SECTION_FRAMES).toBe(0);
  });

  it('still respects the appearance limit with one bed', () => {
    const all = one().all;
    const kindOf = new Map(all.map((shot) => [shot.label, shot.kind]));
    for (const [label, count] of countBy(all)) {
      expect(count, label).toBeLessThanOrEqual(MAX_APPEARANCES[kindOf.get(label)]);
    }
  });

  it('fills exactly the length it claims', () => {
    const { frames, all } = one();
    expect(all.reduce((sum, shot) => sum + shot.frames, 0)).toBe(frames);
  });

  it('reaches the full three minutes once every bed exists', () => {
    expect(honestLength(BEDS.length, APP_CLIPS.length)).toBe(TOTAL_FRAMES);
  });

  it('carries one title per section it actually has', () => {
    const { frames } = one();
    const carried = titles({ frames });
    expect(carried.length).toBe(frames / SECTION_FRAMES);
    for (const title of carried) {
      expect(title.start + title.frames).toBeLessThanOrEqual(frames);
      expect(title.text.length).toBeGreaterThan(0);
    }
  });
});

describe('the narration', () => {
  it('gives every block something to say', () => {
    for (const block of BLOCKS) {
      expect(block.title.length).toBeGreaterThan(0);
      expect(block.line.split(' ').length).toBeGreaterThan(3);
    }
  });
});

/*
 * The sound.
 *
 * `stable_audio_3` fits in the container the video model does not — eighty seconds of underscore in twelve
 * seconds of compute — so the promo has a score even with one picture bed. Which is the right way round: a
 * silent promo reads as broken, a short one only reads as short.
 */
describe('the accents', () => {
  const at = (frames) => accents({ frames });

  it('never overlaps, because the editing rules refuse a collision rather than resolving it', () => {
    // A builder that emits two overlapping clips on one track produces a document the application will not
    // accept. The opening riser and the tick cluster overlapped in the first version by exactly that much.
    for (const frames of [SECTION_FRAMES, 2160, TOTAL_FRAMES]) {
      const all = at(frames);
      const faults = all.filter(
        (accent, index) => index > 0 && accent.start < all[index - 1].start + all[index - 1].frames,
      );
      expect(faults, `at ${frames} frames`).toEqual([]);
    }
  });

  it('marks every section, so no cut opens in silence', () => {
    const sections = 2160 / SECTION_FRAMES;
    // One per section, plus the tick cluster that opens the film once.
    expect(at(2160).length).toBe(sections + 1);
  });

  it('alternates, so consecutive sections do not open the same way', () => {
    // An accent that never varies is one the ear stops hearing.
    const kinds = at(TOTAL_FRAMES)
      .filter((accent) => accent.label !== 'ticks')
      .map((accent) => accent.label);
    expect(new Set(kinds).size).toBeGreaterThan(1);
  });

  it('stays inside the cut', () => {
    for (const accent of at(2160)) {
      expect(accent.start).toBeGreaterThanOrEqual(0);
      expect(accent.start + accent.frames).toBeLessThanOrEqual(2160 + accent.frames);
    }
  });

  it('sets the bed under the accents rather than at unity', () => {
    // The accents are what a viewer registers and the bed is what they feel.
    expect(MUSIC.gain).toBeGreaterThan(0);
    expect(MUSIC.gain).toBeLessThan(0.5);
  });
});
