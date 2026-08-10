/**
 * The promo's edit, as data (issue #40).
 *
 * A promo cut from whatever the machine managed to generate, which on the day was one bed of four seconds
 * and six screen recordings rather than the twelve beds a three-minute version needs. So the length is
 * *derived from the material* instead of asserted: `honestLength` says how long the available sources fill
 * without any one of them wearing out, and `shots` cuts exactly that.
 *
 * The alternative was three minutes containing a single four-second clip thirty times, which is padding
 * wearing the shape of an edit. A shorter promo made of material that holds up is the better deliverable
 * and the more honest one — and the same function produces the full three minutes the moment the rest of
 * the beds exist.
 *
 * Cuts at four seconds and under rather than slow motion. Retiming a 24 fps bed to half speed on a 30 fps
 * timeline shows every source frame two or three times, and on hard-edged motion graphics that reads as a
 * stutter.
 *
 * Data, and separated from the builder, because an edit written by hand can be wrong: this way its
 * arithmetic is checked by the suite rather than by exporting three minutes and measuring the file.
 */

/** Project frame rate. Every number below is in frames at this rate. */
export const FPS = 30;

/** The length the issue asks for, and the ceiling the cut is capped at. */
export const TOTAL_FRAMES = 180 * FPS;

/**
 * How much material each kind of source holds, in timeline frames.
 *
 * A bed is four seconds — the longest this machine's ComfyUI container renders without being OOM-killed —
 * which is 120 frames at the project's 30 fps whatever the source was shot at. A screen recording is about
 * 26 frames at 12 fps, a little over two seconds, so sixty frames sits inside it.
 *
 * The first version of this cut asked for 150-frame shots off a 120-frame source: a whole second of
 * material that does not exist, thirty times over. Nothing refuses that — a clip simply runs past its own
 * media — so the numbers are stated here and asserted in the test.
 */
export const SOURCE_FRAMES = { bed: 120, app: 60 };

/**
 * How many times one source may appear before a promo turns into a screensaver.
 *
 * Per kind, because the two wear out at different rates. A four-second abstract bed shown a fifth time is
 * where a viewer stops reading the film as an edit. A two-second screen recording is a *different* claim
 * each time it appears — this is the drag, this is the trim — and it is the point of the promo, so it
 * carries six.
 *
 * The limit was one number first, and the test caught what that cost: six recordings at four showings each
 * ran out two sections before the end, and the application disappeared from the last thirty-six seconds of
 * its own promo.
 */
export const MAX_APPEARANCES = { bed: 4, app: 6 };

/** The generated motion-graphics beds, in the order they were prompted. */
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
 * The narration blocks, in order, with the title each is paired with.
 *
 * The title carries the message on screen and the narration says it — so a viewer with the sound off still
 * gets the promo, which for a program demo is most viewers.
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

/** A section is one narration block's worth of picture: three beds and three recordings. */
export const SECTION_FRAMES = SOURCE_FRAMES.bed * 3 + SOURCE_FRAMES.app * 3;

/**
 * The longest cut the available sources fill without exceeding `MAX_APPEARANCES`.
 *
 * Capped at the three minutes the issue asks for: twelve beds and six recordings reach it with room over,
 * one bed and six recordings reach a little over half a minute. Rounded down to whole sections, so the
 * titles still land on section starts.
 */
export function honestLength(bedCount, appCount) {
  const supply =
    bedCount * MAX_APPEARANCES.bed * SOURCE_FRAMES.bed + appCount * MAX_APPEARANCES.app * SOURCE_FRAMES.app;
  const sections = Math.max(1, Math.floor(Math.min(TOTAL_FRAMES, supply) / SECTION_FRAMES));
  return Math.min(TOTAL_FRAMES, sections * SECTION_FRAMES);
}

/**
 * The cut, as a list of shots.
 *
 * Deterministic rather than shuffled: the same inputs must give the same film, which is the rule the
 * document store already follows for undo.
 *
 * Beds and recordings alternate, each pool taken round-robin, so neither disappears for long and no single
 * source is leaned on. A source drops out once it has been shown four times; when the pool a turn calls
 * for is spent the other covers it, and when both are spent the cut ends — which is what makes a short
 * folder produce a short promo instead of a long repetitive one.
 */
export function shots({ beds = BEDS, appClips = APP_CLIPS, frames = TOTAL_FRAMES } = {}) {
  const made = [];
  const shown = new Map();

  const take = (pool, kind, turn) => {
    for (let offset = 0; offset < pool.length; offset += 1) {
      const name = pool[(turn + offset) % pool.length];
      if ((shown.get(name) ?? 0) < MAX_APPEARANCES[kind]) {
        shown.set(name, (shown.get(name) ?? 0) + 1);
        return name;
      }
    }
    return undefined;
  };

  let at = 0;
  let turn = 0;
  while (at < frames) {
    const wanted = made.length % 2 === 0 ? 'bed' : 'app';
    const first = wanted === 'bed' ? beds : appClips;
    const second = wanted === 'bed' ? appClips : beds;

    let kind = wanted;
    let chosen = take(first, kind, turn);
    if (chosen === undefined) {
      kind = wanted === 'bed' ? 'app' : 'bed';
      chosen = take(second, kind, turn);
    }
    if (chosen === undefined) break;

    // Never longer than the source holds, and never past the end of the cut.
    const length = Math.min(SOURCE_FRAMES[kind], frames - at);
    if (length <= 0) break;

    made.push({
      asset: `media/${kind}_${chosen}.mp4`,
      label: chosen,
      kind,
      start: at,
      frames: length,
      section: Math.floor(at / SECTION_FRAMES),
    });

    at += length;
    if (kind === 'bed') turn += 1;
  }

  return made;
}

/**
 * Where each title sits: over its section's opening shot, held for six seconds.
 *
 * One per section the cut actually has. A shorter cut carries the first few blocks rather than squeezing
 * all ten in — a title nobody has time to read is worse than one that was left out.
 */
export function titles({ frames = TOTAL_FRAMES } = {}) {
  const sections = Math.max(1, Math.floor(frames / SECTION_FRAMES));
  return BLOCKS.slice(0, sections).map((block, section) => ({
    text: block.title,
    start: section * SECTION_FRAMES + 24,
    frames: 6 * FPS,
  }));
}
