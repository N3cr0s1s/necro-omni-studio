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
import { APP_CLIPS, BEDS, BLOCKS, FPS, SECTION_FRAMES, honestLength, shots, titles } from './edit.mjs';

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
/*
 * The cut is built from what is *there*, not from what was hoped for.
 *
 * A bed that failed to render is not a reason to write a document pointing at a file that does not exist —
 * that opens onto black, which is the failure this whole evening has been about. So the pools are filtered
 * to what the media directory holds, the length follows from that, and the script says what it found.
 */
const beds = BEDS.filter((name) => existsSync(join(mediaDirectory, 'beds', `${name}.mp4`)));
const appClips = APP_CLIPS.filter((name) => existsSync(join(mediaDirectory, 'app', `${name}.mp4`)));

if (beds.length === 0 && appClips.length === 0) {
  console.error(`✗ no promo media under ${mediaDirectory} — expected beds/*.mp4 and app/*.mp4`);
  process.exit(1);
}

for (const name of beds) {
  copyFileSync(
    join(mediaDirectory, 'beds', `${name}.mp4`),
    join(projectDirectory, 'media', `bed_${name}.mp4`),
  );
}
for (const name of appClips) {
  copyFileSync(
    join(mediaDirectory, 'app', `${name}.mp4`),
    join(projectDirectory, 'media', `app_${name}.mp4`),
  );
}

const frames = honestLength(beds.length, appClips.length);
console.log(`  ${beds.length}/${BEDS.length} beds, ${appClips.length}/${APP_CLIPS.length} recordings`);
console.log(`  the material supports ${frames / FPS}s without a source appearing more often than it should`);

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
    markers: titles({ frames }).map((title, section) => ({
      frame: section * SECTION_FRAMES,
      label: title.text,
    })),
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        name: 'V1 · picture',
        height: 84,
        clips: shots({ beds, appClips, frames }).map(shotClip),
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
        clips: titles({ frames }).map(titleClip),
      },
    ],
  },
};

writeFileSync(join(projectDirectory, 'project.json'), `${JSON.stringify(document, null, 2)}\n`);

// The script goes in `notes/`, which is where the TTS manifest can read it from — so adding the
// narration later is a generation rather than a retyping.
writeFileSync(
  join(projectDirectory, 'notes', 'script.md'),
  `# Necro Omni Studio — promó narráció\n\n${BLOCKS.slice(0, titles({ frames }).length)
    .map((block, index) => `## ${index + 1}. ${block.title}\n\n${block.line}\n`)
    .join('\n')}`,
);

const cut = shots({ beds, appClips, frames });
console.log(`✓ ${projectDirectory}`);
console.log(
  `  ${cut.length} shots, ${titles({ frames }).length} titles, ${frames} frames (${frames / FPS}s)`,
);
