/**
 * Turns the promo's edit into a project the application can open (issue #40).
 *
 * The document is written rather than clicked together, and that is the honest division of labour: an
 * edit decision list is data, and typing forty shots into a timeline by hand through a Playwright
 * script would be a worse test of the program than opening the result and *cutting* it. What this
 * proves is that the shape a real edit needs — four tracks, fades, retimes, titles with animation — is
 * expressible in `project.json` and renders through the same compositor the export uses.
 *
 * Usage, from the repository root:
 *   node apps/desktop/promo/build-project.mjs <media-directory> <project-directory>
 *
 * The media directory is where the beds and screen recordings were collected; every file named by the
 * edit must be there, and the script says which are missing rather than writing a document that opens
 * onto black.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { APP_CLIPS, BEDS, BLOCKS, FPS, TOTAL_FRAMES, shots, titles } from './edit.mjs';

const [, , mediaDirectory, projectDirectory] = process.argv;
if (mediaDirectory === undefined || projectDirectory === undefined) {
  console.error('usage: node apps/desktop/promo/build-project.mjs <media-directory> <project-directory>');
  process.exit(1);
}

for (const folder of ['media', 'generated', 'masks', 'effects', 'generators', 'notes', 'renders', 'cache']) {
  mkdirSync(join(projectDirectory, folder), { recursive: true });
}

/*
 * Copied in, because §4 says a project is a folder and an asset is a project-relative path. A document
 * pointing at a scratch directory outside the project is one that stops opening the moment the
 * directory is cleared — which is exactly what a scratch directory is for.
 */
const wanted = new Map();
for (const name of BEDS) wanted.set(`bed_${name}.mp4`, join(mediaDirectory, `${name}.mp4`));
for (const name of APP_CLIPS) wanted.set(`app_${name}.mp4`, join(mediaDirectory, `${name}.mp4`));

const missing = [];
for (const [target, source] of wanted) {
  if (existsSync(source)) copyFileSync(source, join(projectDirectory, 'media', target));
  else missing.push(basename(source));
}
if (missing.length > 0) {
  console.error(`✗ missing media: ${missing.join(', ')}`);
  console.error('  the edit names every one of these; a document without them opens onto black');
  process.exit(1);
}

const transform = { x: 0, y: 0, scale: 1, rotation: 0 };

/**
 * One shot on the picture track.
 *
 * A short ramp on every shot but the first, which is what makes forty cuts read as an edit rather than
 * as a slideshow. The ramp is the clip's own, not a transition: a dissolve needs an overlap and these
 * shots are butt-jointed, so an in-ramp against what is under it is the right mechanism.
 */
const shotClip = (shot, index) => ({
  id: `shot_${String(index).padStart(3, '0')}`,
  kind: 'video',
  span: { start: shot.start, duration: shot.frames },
  label: shot.label,
  enabled: true,
  effects: [],
  source: { asset: shot.asset, sourceIn: 0, sourceRate: '30' },
  transform: { ...transform, opacity: 1 },
  speed: { factor: 1, preservePitch: true },
  ...(index === 0 ? {} : { fade: { inFrames: 6, outFrames: 0 } }),
});

/** A title card, faded in and out by keyframes so the animation is editable rather than hidden. */
const titleClip = (title, index) => ({
  id: `title_${String(index).padStart(2, '0')}`,
  kind: 'text',
  span: { start: title.start, duration: title.frames },
  label: title.text,
  enabled: true,
  effects: [],
  content: {
    text: title.text,
    font: 'system-ui, sans-serif',
    size: 96,
    weight: 700,
    align: 'center',
  },
  transform: {
    ...transform,
    opacity: {
      keyframes: [
        { id: `t${index}_a`, frame: 0, value: 0, ease: 'ease-out' },
        { id: `t${index}_b`, frame: 15, value: 1, ease: 'linear' },
        { id: `t${index}_c`, frame: title.frames - 20, value: 1, ease: 'ease-in' },
        { id: `t${index}_d`, frame: title.frames - 5, value: 0, ease: 'linear' },
      ],
    },
  },
});

const document = {
  schemaVersion: 1,
  id: 'nos_promo',
  name: basename(projectDirectory),
  frameRate: String(FPS),
  resolution: { width: 1920, height: 1080 },
  sequence: {
    id: 'main',
    // The section starts, so the cut can be navigated by what it is saying rather than by timecode.
    markers: BLOCKS.map((block, section) => ({
      frame: section * (TOTAL_FRAMES / BLOCKS.length),
      label: block.title,
    })),
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        name: 'V1 · picture',
        height: 84,
        clips: shots().map(shotClip),
      },
      {
        id: 'A1',
        kind: 'audio',
        name: 'A1 · music',
        height: 64,
        clips: [],
      },
      {
        id: 'A2',
        kind: 'audio',
        name: 'A2 · narration',
        height: 64,
        clips: [],
      },
      {
        id: 'T1',
        kind: 'text',
        name: 'T1 · titles',
        height: 46,
        clips: titles().map(titleClip),
      },
    ],
  },
};

writeFileSync(join(projectDirectory, 'project.json'), `${JSON.stringify(document, null, 2)}\n`);

// The script goes in `notes/`, which is where the TTS manifest can read it from — so adding the
// narration later is a generation rather than a retyping.
writeFileSync(
  join(projectDirectory, 'notes', 'script.md'),
  `# Necro Omni Studio — promó narráció\n\n${BLOCKS.map(
    (block, index) => `## ${index + 1}. ${block.title}\n\n${block.line}\n`,
  ).join('\n')}`,
);

const shotCount = shots().length;
console.log(`✓ ${projectDirectory}`);
console.log(
  `  ${shotCount} shots, ${titles().length} titles, ${TOTAL_FRAMES} frames (${TOTAL_FRAMES / FPS}s)`,
);
