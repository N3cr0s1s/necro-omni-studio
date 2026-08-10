/**
 * The promo's edit, as data (issue #40).
 *
 * A three-minute piece out of forty-eight seconds of generated footage and a handful of screen
 * recordings, which is an ordinary situation for an editor and the reason the arithmetic is written
 * down rather than felt: twelve beds of four seconds, each cut in two or three times, interleaved with
 * the application's own footage, titles over the held ends.
 *
 * Cuts at roughly four seconds rather than slow motion. Retiming a 24 fps bed to half speed on a 30 fps
 * timeline shows every source frame two or three times, and on hard-edged motion graphics that reads as
 * a stutter — a fast cut is both the honest way to fill the time and the right idiom for the genre.
 *
 * Data, and separated from the builder, for the same reason the README's demo project is: an edit
 * written by hand can be wrong, and this way it can be checked without launching anything.
 */

/** Project frame rate. Every number below is in frames at this rate. */
export const FPS = 30;

/** Three minutes, which is what the issue asks for. */
export const TOTAL_FRAMES = 180 * FPS;

/**
 * The generated beds, in the order they were prompted.
 *
 * Four seconds each at 24 fps. On a 30 fps timeline a bed is 120 frames of *timeline* at 1× — the
 * document counts frames at the project rate and the compositor resamples the source, so a four-second
 * source is four seconds long here whatever it was shot at.
 */
export const BEDS = [
  'grid',
  'assemble',
  'bands',
  'rings',
  'ribbons',
  'reveal',
  'shards',
  'particles',
  'columns',
  'mesh',
  'sweep',
  'close',
];

/** The screen recordings, which are what actually make the case for an editor. */
export const APP_CLIPS = ['drag', 'trim', 'zoom', 'keyframes', 'scrub', 'effects'];

/**
 * How much material each kind of source actually holds, in timeline frames.
 *
 * The number that has to be respected rather than assumed. A bed is four seconds — the longest this
 * machine's ComfyUI container can render without being OOM-killed — which is 120 frames at the project's
 * 30 fps whatever the source was shot at. A screen recording is about 26 frames at 12 fps, a little over
 * two seconds, so sixty frames is inside it with room to spare.
 *
 * The first version of this cut asked for 150-frame shots off a 120-frame source: a whole second of
 * material that does not exist, at the end of thirty of the forty shots. Nothing refuses it — the clip
 * simply runs past its own media — so the arithmetic is stated here and asserted in the test.
 */
export const SOURCE_FRAMES = { bed: 120, app: 60 };

/**
 * The narration blocks, in order, with the title each one is paired with.
 *
 * The title carries the message on screen and the narration says it — so a viewer with the sound off
 * still gets the promo, which for a program demo is most viewers.
 */
export const BLOCKS = [
  { title: 'A vágás a tiéd.', line: 'A vágás a tiéd. A gépi munka a miénk.' },
  {
    title: 'NECRO OMNI STUDIO',
    line: 'Necro Omni Studio. Helyben futó videószerkesztő, generatív modellekkel a vágóasztalon.',
  },
  {
    title: 'A projekt egy mappa',
    line: 'A projekt nem adatbázis, hanem egy mappa. Bezippelve átvihető. Mindent te látsz benne.',
  },
  {
    title: 'Frame-pontos vágás',
    line: 'Minden időérték kockaindex. Vágás, trimmelés, csúsztatás, ripple — pontosan ott, ahol akartad.',
  },
  {
    title: 'Egy compositor',
    line: 'Amit a previewben látsz, az kerül a fájlba. Ugyanaz a shader, ugyanaz a keyframe-kiértékelés.',
  },
  {
    title: 'Effektek és keyframe-ek',
    line: 'Az effektek GLSL shaderek manifesttel. Bármely szám keyframe-elhető, és a görbét te rajzolod.',
  },
  {
    title: 'Generátorok manifestből',
    line: 'A generátorok manifestből kapcsolódnak. Új képesség egy JSON, nem egy új kódsor.',
  },
  {
    title: 'Variánsok a helyükön',
    line: 'A variánsok a timeline-on jelennek meg, a saját környezetükben hallgatod és nézed őket.',
  },
  { title: 'Maszkok', line: 'A maszk nem különleges eset: bármely effekt kérhet egy maszk bemenetet.' },
  { title: 'A döntés a tiéd.', line: 'Necro Omni Studio. A gép dolgozik. A döntés a tiéd.' },
];

/**
 * The cut, as a list of shots.
 *
 * Deterministic and written out rather than shuffled: the same inputs must give the same film, which is
 * the same rule the document store follows for undo. Beds and app footage alternate in a fixed pattern
 * so neither disappears for long, and the pattern is stated here rather than emerging from a loop
 * nobody can read.
 *
 * Ten sections, one per narration block, eighteen seconds each — 540 frames — which comes to exactly
 * three minutes.
 */
export function shots() {
  const SECTION = TOTAL_FRAMES / BLOCKS.length; // 540 frames, 18 s
  const made = [];

  BLOCKS.forEach((block, section) => {
    const start = section * SECTION;

    /*
     * Six shots per section: bed, app, bed, app, bed, app — 120/60/120/60/120/60 = 540.
     *
     * Every length is exactly what its source holds, which is what fixes the shots from running past
     * their own media. A bed is the backdrop the title sits over and gets the full four seconds; a
     * screen recording says its thing in two and outstays it just as fast.
     */
    const plan = [
      { kind: 'bed', index: section * 3, frames: SOURCE_FRAMES.bed },
      { kind: 'app', index: section, frames: SOURCE_FRAMES.app },
      { kind: 'bed', index: section * 3 + 1, frames: SOURCE_FRAMES.bed },
      { kind: 'app', index: section + 2, frames: SOURCE_FRAMES.app },
      { kind: 'bed', index: section * 3 + 2, frames: SOURCE_FRAMES.bed },
      { kind: 'app', index: section + 4, frames: SOURCE_FRAMES.app },
    ];

    let at = start;
    for (const entry of plan) {
      const source =
        entry.kind === 'bed'
          ? {
              asset: `media/bed_${BEDS[entry.index % BEDS.length]}.mp4`,
              label: BEDS[entry.index % BEDS.length],
            }
          : {
              asset: `media/app_${APP_CLIPS[entry.index % APP_CLIPS.length]}.mp4`,
              label: APP_CLIPS[entry.index % APP_CLIPS.length],
            };

      made.push({
        ...source,
        kind: entry.kind,
        start: at,
        frames: entry.frames,
        section,
      });
      at += entry.frames;
    }
  });

  return made;
}

/** Where each title sits: over the section's opening bed, held for six seconds. */
export function titles() {
  const SECTION = TOTAL_FRAMES / BLOCKS.length;
  return BLOCKS.map((block, section) => ({
    text: block.title,
    start: section * SECTION + 24,
    frames: 6 * FPS,
  }));
}
