/**
 * Short recordings of the application being *used*, for the promo (issue #40).
 *
 * A promo for an editor has to show the editor. The generated motion-graphics beds are the backdrop;
 * what makes the case is a clip being dragged, an edge being trimmed, a keyframe being moved — the
 * things the program is for. Recorded the same way `run.mjs` records its walkthrough: real shell, real
 * project, screenshots into ffmpeg, because Playwright's own video recording belongs to a context it
 * created and this connects to a window that already exists.
 *
 * Each interaction becomes its own file, so the edit can order and re-time them freely. Cropped to
 * 16:9 before scaling: the shell's window is 1920×1051, and a promo that letterboxes its own footage
 * inside a 16:9 timeline would show bars around every shot of the app.
 *
 * Usage, from the repository root:
 *   node apps/desktop/capture/promo-clips.mjs
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
const out = process.env.NOS_PROMO_OUT ?? join(tmpdir(), 'nos-promo-clips');

armCleanup();
buildFirst(desktop, { pass: (m) => console.log(`✓ ${m}`), fail: (m) => console.error(`✗ ${m}`) });

const work = mkdtempSync(join(tmpdir(), 'nos-promo-'));
const project = join(work, 'Demo');
for (const folder of ['media', 'generated', 'masks', 'effects', 'generators', 'notes', 'renders', 'cache']) {
  mkdirSync(join(project, folder), { recursive: true });
}

/** The same synthesized footage the README capture uses, for the same reason: nothing committed. */
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
    console.error('✗ ffmpeg could not synthesize the fixture footage');
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
  console.error('✗ ffmpeg could not synthesize the tone');
  process.exit(1);
}

writeFileSync(join(project, 'project.json'), `${JSON.stringify(demoProject(), null, 2)}\n`);

const userData = join(work, 'user-data');
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'session.json'), JSON.stringify({ lastProject: project }, null, 2));
mkdirSync(out, { recursive: true });

let shell;
try {
  shell = await launchShell({ desktop, dataDir: userData, visible: true });
  const page = shell.browser.contexts()[0].pages().at(-1);

  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, undefined, {
    timeout: 60_000,
  });
  await page.waitForTimeout(12_000);
  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  /**
   * Records while `act` runs.
   *
   * The screenshots pace the interaction rather than racing it: a gesture driven at full speed produces
   * three frames of motion and a cut, and the point of these clips is that the motion is *visible*.
   */
  const record = async (name, frames, act) => {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });

    let index = 0;
    const shoot = async () => {
      await page.screenshot({ path: join(dir, `f${String(index).padStart(3, '0')}.png`) });
      index += 1;
    };

    await act(shoot, frames);
    while (index < frames) await shoot();

    const encoded = spawnSync('ffmpeg', [
      ...['-v', 'error', '-y'],
      ...['-framerate', '12', '-i', join(dir, 'f%03d.png')],
      // Cropped to 16:9 from the window's 1920×1051, then scaled. Padding instead would put bars
      // around every shot of the application inside a 16:9 promo.
      ...['-vf', 'crop=1868:1051,scale=1280:-2', '-pix_fmt', 'yuv420p'],
      ...['-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart'],
      join(out, `${name}.mp4`),
    ]);
    console.log(encoded.status === 0 ? `✓ ${name}.mp4 (${index} frames)` : `✗ ${name} failed to encode`);
  };

  /** Drags from one point to another, shooting along the way so the motion is on the recording. */
  const dragAcross = async (shoot, from, to, steps) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      await shoot();
    }
    await page.mouse.up();
    await shoot();
  };

  const boxOf = async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (box === null) throw new Error(`${selector} has no box`);
    return box;
  };

  // 1. A clip moved along the track — the gesture the whole application is arranged around.
  await record('drag', 26, async (shoot) => {
    const clip = await boxOf('[data-clip-id="shot_4"]');
    await dragAcross(
      shoot,
      { x: clip.x + 20, y: clip.y + clip.height / 2 },
      { x: clip.x + 190, y: clip.y + clip.height / 2 },
      20,
    );
  });

  // 2. Trimming an edge, which is the other half of cutting.
  await record('trim', 24, async (shoot) => {
    const clip = await boxOf('[data-clip-id="shot_1"]');
    await dragAcross(
      shoot,
      { x: clip.x + clip.width - 3, y: clip.y + clip.height / 2 },
      { x: clip.x + clip.width - 90, y: clip.y + clip.height / 2 },
      18,
    );
  });

  // 3. The preview zoomed in on the frame, then released back to fit.
  await record('zoom', 26, async (shoot) => {
    const preview = await boxOf('canvas[aria-label="Preview"]');
    await page.mouse.move(preview.x + preview.width / 2, preview.y + preview.height / 2);
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -240);
      await page.keyboard.up('Control');
      await shoot();
      await shoot();
    }
    await page.mouse.dblclick(preview.x + preview.width / 2, preview.y + preview.height / 2);
    await shoot();
  });

  // 4. A keyframe dragged in its lane, with the picture following.
  await record('keyframes', 26, async (shoot) => {
    await page.locator('[data-clip-disclosure="title_1"]').click({ force: true });
    await page.waitForTimeout(1200);
    await shoot();
    const marker = await boxOf('[data-keyframe]');
    await dragAcross(
      shoot,
      { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 },
      { x: marker.x + 120, y: marker.y + marker.height / 2 },
      16,
    );
  });

  // 5. The playhead scrubbed across the cut, so the compositor is seen working.
  await record('scrub', 30, async (shoot) => {
    await page.keyboard.press('Home');
    for (let step = 0; step < 28; step += 1) {
      await page.keyboard.press('Shift+ArrowRight');
      await shoot();
    }
  });

  // 6. An effect added from the registry — the manifest-driven half of the program.
  await record('effects', 24, async (shoot) => {
    await page.locator('[data-clip-id="shot_2"]').click({ force: true, position: { x: 12, y: 8 } });
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.waitForTimeout(900);
    await shoot();
    await page.getByRole('button', { name: /Add effect from registry/i }).click();
    await page.waitForTimeout(700);
    await shoot();
    await shoot();
    const grain = page.getByRole('button', { name: 'Film Grain' }).first();
    await grain.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    await grain.click();
    for (let step = 0; step < 8; step += 1) await shoot();
  });
} finally {
  await shell?.browser.close().catch(() => undefined);
  if (shell !== undefined) stopShell(shell.child);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`clips in ${out}`);
