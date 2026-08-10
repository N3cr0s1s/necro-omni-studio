/**
 * Screenshots and a short recording of the running application, for the README.
 *
 * Issue #39 asked for a readme with pictures and video of the app and no invented prose. The pictures
 * therefore have to be *of the app* — a mockup, a mock-up of a mockup, or a hand-drawn approximation
 * would all be the thing the issue asked not to have. So this drives the real shell exactly as the
 * checks do, on a real project, and photographs what appears.
 *
 * ## The project it photographs
 *
 * Built here rather than checked in, from clips ffmpeg synthesizes: a screenshot of an empty timeline
 * says nothing about an editor, and committing a few megabytes of sample footage to show that would be
 * paying for the picture twice. Everything in it is real — real files, decoded by the real pipeline,
 * composited by the real compositor.
 *
 * Usage, from the repository root:
 *   node apps/desktop/capture/run.mjs
 *
 * The window is *mapped* for this, unlike a check run: a screenshot of an unmapped window is a
 * screenshot of nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFirst } from '../harness/build-first.mjs';
import { armCleanup } from '../harness/children.mjs';
import { launchShell, stopShell } from '../harness/shell.mjs';
import { demoProject } from './demo-project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const repo = join(desktop, '..', '..');
const media = join(repo, 'docs', 'media');

armCleanup();
buildFirst(desktop, { pass: (m) => console.log(`✓ ${m}`), fail: (m) => console.error(`✗ ${m}`) });

const work = mkdtempSync(join(tmpdir(), 'nos-capture-'));
const project = join(work, 'Demo');
for (const folder of ['media', 'generated', 'masks', 'effects', 'generators', 'notes', 'renders', 'cache']) {
  mkdirSync(join(project, folder), { recursive: true });
}

/**
 * Four shots and a tone, synthesized.
 *
 * `testsrc2` and `smptebars` because they are recognisable as *footage* rather than as flat colour —
 * a timeline of solid rectangles reads as a diagram of an editor instead of a picture of one — and
 * because their motion makes the recording show that something is actually playing.
 */
const SHOTS = [
  { name: 'wide.mp4', source: 'testsrc2=size=1280x720:rate=30', seconds: 4 },
  { name: 'bars.mp4', source: 'smptebars=size=1280x720:rate=30', seconds: 3 },
  { name: 'grad.mp4', source: 'gradients=size=1280x720:rate=30', seconds: 4 },
  { name: 'noise.mp4', source: 'testsrc=size=1280x720:rate=30', seconds: 3 },
];

for (const shot of SHOTS) {
  const made = spawnSync('ffmpeg', [
    ...['-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', `${shot.source}:duration=${shot.seconds}`],
    ...['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '20'],
    join(project, 'media', shot.name),
  ]);
  if (made.status !== 0) {
    console.error(`✗ could not synthesize ${shot.name} — is ffmpeg installed?`);
    process.exit(1);
  }
}

const tone = spawnSync('ffmpeg', [
  ...['-v', 'error', '-y'],
  ...['-f', 'lavfi', '-i', 'sine=frequency=220:duration=13:sample_rate=48000'],
  ...['-ac', '2'],
  join(project, 'media', 'bed.wav'),
]);
if (tone.status !== 0) {
  console.error('✗ could not synthesize the audio bed');
  process.exit(1);
}

writeFileSync(join(project, 'project.json'), `${JSON.stringify(demoProject(), null, 2)}\n`);

const userData = join(work, 'user-data');
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'session.json'), JSON.stringify({ lastProject: project }, null, 2));

mkdirSync(media, { recursive: true });

let shell;
try {
  shell = await launchShell({ desktop, dataDir: userData, visible: true });
  const page = shell.browser.contexts()[0].pages().at(-1);

  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, undefined, {
    timeout: 60_000,
  });
  // Long enough for proxies, waveforms and filmstrips to land. A screenshot taken before they do is a
  // picture of the application still working, which is honest and not what the issue asked for.
  await page.waitForTimeout(12_000);

  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  const shoot = async (name) => {
    await page.screenshot({ path: join(media, `${name}.png`) });
    console.log(`✓ ${name}.png`);
  };

  /*
   * Park the playhead inside the graded shot before the first picture.
   *
   * Frame zero is the head of the first clip, which is the least interesting frame in any edit — and
   * with the title starting at frame 8 it is also the one frame where nothing is composited over
   * anything. Twenty frames into the third shot there is a graded picture with an effect on it.
   */
  await page.keyboard.press('Home');
  for (let step = 0; step < 18; step += 1) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(2500);
  await shoot('editor');

  /*
   * The effect stack, per mockup 1b.
   *
   * Clicked on the clip's *label* rather than its middle: the body carries the drag and trim gestures,
   * and a forced click at the centre of a wide clip landed on neither the selection nor anything else —
   * the first run of this produced two pictures of an unselected clip and a panel saying so.
   */
  await page.locator('[data-clip-id="shot_3"]').click({ force: true, position: { x: 12, y: 8 } });
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.waitForTimeout(1800);
  await shoot('effects');

  /*
   * The keyframe lanes, which are the other half of 1b.
   *
   * Through the disclosure the clip body offers, not a double-click: a double-click on a clip renames
   * it. The button only exists on a clip that *has* an animation, which the title does.
   */
  await page.locator('[data-clip-disclosure="title_1"]').click({ force: true });
  await page.waitForTimeout(1800);
  await shoot('keyframes');

  await page.getByRole('tab', { name: 'Markers' }).click();
  await page.waitForTimeout(1200);
  await shoot('markers');

  /*
   * A recording of the window, walked through the cut ten frames at a time.
   *
   * Playwright's video recording is a property of a context it created; this connects to a shell that
   * already exists, so there is no context to ask. Screenshots into ffmpeg is the honest way to get
   * moving pictures out of a window we did not open.
   *
   * **Stepped rather than played**, and that was a correction. Recording real-time playback produced a
   * black preview and `1 layers still decoding` across the dissolve — true of the first play of an
   * unwarmed timeline, and a picture of the decoder rather than of the editor. A warm-up pass did not
   * fix it, because each play seeks and decodes again. Stepping is paced by the screenshot, so every
   * frame in the recording is a frame the compositor had finished, and the walk covers the whole
   * sequence instead of the first two seconds of it.
   */
  await page.getByRole('tab', { name: 'Clip' }).click();
  await page.keyboard.press('Home');
  await page.waitForTimeout(1200);

  const frames = join(work, 'frames');
  mkdirSync(frames, { recursive: true });

  const STEPS = 36;
  for (let index = 0; index < STEPS; index += 1) {
    await page.screenshot({ path: join(frames, `f${String(index).padStart(3, '0')}.png`) });
    // Ten frames a step: thirty-six of them cover the 350-frame sequence, so the recording is a tour
    // of the whole cut rather than of its opening.
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(320);
  }

  const encoded = spawnSync('ffmpeg', [
    ...['-v', 'error', '-y'],
    ...['-framerate', '8', '-i', join(frames, 'f%03d.png')],
    // `yuv420p` and an even size, or the file plays nowhere: GitHub's player and most browsers refuse
    // an odd dimension, and the failure is a black rectangle rather than a message.
    ...['-vf', 'scale=1280:-2', '-pix_fmt', 'yuv420p'],
    ...['-c:v', 'libx264', '-crf', '26', '-movflags', '+faststart'],
    join(media, 'walkthrough.mp4'),
  ]);
  if (encoded.status === 0) console.log('✓ walkthrough.mp4');
  else console.error('✗ the recording could not be encoded');

  /*
   * The same walk as a GIF, because that is what plays in a README.
   *
   * GitHub renders an `<img>` inline and does not reliably play a `<video>` pointing at a file in the
   * repository — a readme whose one moving picture is a broken player is worse than one with a still.
   * Two passes with a generated palette rather than one: the default 216-colour web palette turns a
   * dark editor chrome into bands, and the whole subject here is a dark interface.
   */
  const palette = join(work, 'palette.png');
  const paletted = spawnSync('ffmpeg', [
    ...['-v', 'error', '-y', '-i', join(media, 'walkthrough.mp4')],
    ...['-vf', 'fps=8,scale=1000:-1:flags=lanczos,palettegen=max_colors=128'],
    palette,
  ]);
  const gif =
    paletted.status !== 0
      ? paletted
      : spawnSync('ffmpeg', [
          ...['-v', 'error', '-y', '-i', join(media, 'walkthrough.mp4'), '-i', palette],
          ...['-lavfi', 'fps=8,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3'],
          join(media, 'walkthrough.gif'),
        ]);
  if (gif.status === 0) console.log('✓ walkthrough.gif');
  else console.error('✗ the GIF could not be encoded');
} finally {
  await shell?.browser.close().catch(() => undefined);
  if (shell !== undefined) stopShell(shell.child);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
