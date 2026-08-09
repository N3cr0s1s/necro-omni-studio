/**
 * Asserts that the timeline stays interactive at the size the spec asks for.
 *
 * §8 fixes two numbers that no unit test can check: a **16 ms interaction budget** and **200 clips**.
 * The domain guards in `@nos/smoke` measure the document and the plan builders, which is the half that
 * could go quadratic — but the half a user feels is React rendering two hundred clips while their
 * pointer moves, and nothing measured that at all.
 *
 * So this drives the real shell: it writes a 200-clip project, opens it, zooms out until every clip is
 * on screen at once — the worst case, and the one `isSpanVisible` culling cannot help with — and drags
 * a clip across sixty animation frames while watching what the main thread does.
 *
 * ## What it asserts, and why these and not a stopwatch
 *
 * **Long tasks**, not frame intervals. A first attempt measured `requestAnimationFrame` gaps and read a
 * p95 of 17 ms as a budget breach. It was not one: the display runs well above 60 Hz, so 17 ms was two
 * ordinary frames, and the figure described the monitor rather than this application. A long task is
 * the browser's own definition of work that blocked the main thread, and it does not move with the
 * hardware.
 *
 * **Cost per pointer move, against the spec's 16 ms.** Also not against the display: on a 123 Hz screen
 * keeping pace would mean 8.1 ms, a bar the spec never set and one that would make this harness pass or
 * fail depending on which machine ran it.
 *
 * A negative result is recorded here because it cost an afternoon: memoizing `ClipBody` to skip the 199
 * clips that do not move makes this **slower**, by roughly 5%. Every clip's `geometry` is recomputed on
 * every render and the props genuinely differ, so the comparison never skips and only adds work. The
 * numbers to beat, at 200 clips fully zoomed out, are ~430 ms of JS for a 60-move drag and no long
 * tasks at all.
 *
 * Usage, from the repository root:
 *   npm --prefix apps/desktop run build
 *   node apps/desktop/perfcheck/run.mjs
 *
 * Exits non-zero if any expectation fails, so it can gate a release.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');

/** The spec's target, and the shape of a project that reaches it. */
const CLIPS = 200;
const TRACKS = 8;
const MOVES = 60;
/** §8's interaction budget, which is what a pointer move has to fit inside. */
const BUDGET_MS = 16;

/**
 * A port nothing else holds.
 *
 * Asked of the operating system rather than picked from a range, for the reason `exportcheck` records:
 * a hard-coded one that an unrelated process held looked exactly like the application failing to start.
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

/**
 * A project at the spec's limit.
 *
 * Written rather than checked in: it is a hundred lines of generated JSON, and a fixture nobody reads
 * is a fixture nobody notices going stale. The clips are staggered across tracks so the lanes are not
 * identical, and none of them name a real file — this measures rendering, and a filmstrip that never
 * arrives is one fewer variable.
 */
function buildProject() {
  const tracks = [];
  let index = 0;

  for (let t = 0; t < TRACKS / 2; t += 1) {
    const clips = [];
    for (let k = 0; k < CLIPS / TRACKS; k += 1) {
      clips.push({
        id: `v${index}`,
        kind: 'video',
        span: { start: k * 140 + t * 7, duration: 120 },
        label: `shot ${index}`,
        enabled: true,
        effects: [],
        source: { asset: 'media/absent.mp4', sourceIn: 0, sourceRate: '30' },
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        speed: { factor: 1, preservePitch: true },
      });
      index += 1;
    }
    tracks.push({ id: `V${t + 1}`, kind: 'video', name: `V${t + 1}`, height: 72, clips });
  }

  for (let t = 0; t < TRACKS / 2; t += 1) {
    const clips = [];
    for (let k = 0; k < CLIPS / TRACKS; k += 1) {
      clips.push({
        id: `a${index}`,
        kind: 'audio',
        span: { start: k * 140 + t * 11, duration: 130 },
        label: `take ${index}`,
        enabled: true,
        effects: [],
        source: { asset: 'media/absent.flac', sourceIn: 0, sourceRate: '30' },
        speed: { factor: 1, preservePitch: true },
        gain: 1,
        pan: 0,
      });
      index += 1;
    }
    tracks.push({ id: `A${t + 1}`, kind: 'audio', name: `A${t + 1}`, height: 56, clips });
  }

  return {
    schemaVersion: 1,
    id: 'perfcheck',
    name: 'perfcheck',
    frameRate: '30',
    resolution: { width: 1920, height: 1080 },
    sequence: { id: 'main', name: 'main', tracks },
  };
}

const work = mkdtempSync(join(tmpdir(), 'nos-perfcheck-'));
const project = join(work, 'perfcheck');
mkdirSync(join(project, 'media'), { recursive: true });

/*
 * The two source files every clip shares, made real.
 *
 * They were named `absent` and never created, which was harmless until the editor learned to notice
 * missing media: after that, all two hundred clips were offline and each drew a marker, so this
 * measured the cost of a pathological project rather than the cost of two hundred clips. The
 * difference was about two milliseconds of the sixteen — enough to make the number mean something
 * else without saying so.
 *
 * A second of black and a second of silence: nothing here decodes them, the clips only need the paths
 * to resolve, and a real asset would put a filmstrip derivation in the middle of a timing run.
 */
for (const [name, args] of [
  ['media/absent.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=1:r=30']],
  ['media/absent.flac', ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1']],
]) {
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, join(project, name)]);
  if (made.status !== 0) {
    console.error(`✗ the fixture media could not be made — is ffmpeg installed?`);
    process.exitCode = 1;
  }
}

writeFileSync(join(project, 'project.json'), JSON.stringify(buildProject(), null, 1));

// The shell reopens the project it last had open, which is how this drives a native folder picker
// without one — and exercises the same restore path a user gets on every launch.
const userData = join(work, 'user-data');
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'session.json'), JSON.stringify({ lastProject: project }, null, 2));

const port = await freePort();
/*
 * Hidden unless someone asks to watch. The harnesses drive a real shell over the debugging port
 * and never need a mapped window; three per run, several runs an hour, is a window stealing focus
 * from whoever is using the machine. `NOS_WATCH=1` shows them for when a run has to be seen.
 */
const electron = spawn(
  'npx',
  ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${userData}`],
  // `ignore`, not `pipe`: an unread pipe keeps this process alive after the child is killed.
  {
    cwd: desktop,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, NOS_HEADLESS: process.env.NOS_WATCH === '1' ? '0' : '1' },
  },
);

let browser;
try {
  for (let attempt = 0; attempt < 60 && browser === undefined; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  if (browser === undefined) throw new Error('the shell never exposed a debugging port');

  const page = browser.contexts()[0].pages().at(-1);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, {
    timeout: 30_000,
  });

  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  // Fit is the worst case on purpose. At any other zoom the lane culls what is off screen, and the
  // 200-clip target would be measured against whatever fraction happened to be visible.
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(1500);

  const onScreen = await page.evaluate(() => document.querySelectorAll('[data-clip-id]').length);
  if (onScreen < CLIPS) {
    fail(`only ${onScreen} of ${CLIPS} clips were on screen, so the measurement is not the target`);
  } else {
    pass(`all ${CLIPS} clips are on screen at once`);
  }

  const measured = await page.evaluate(async (moves) => {
    const clip = document.querySelector('[data-clip-id]');
    const box = clip.getBoundingClientRect();
    const y = box.top + box.height / 2;

    const long = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) long.push(Math.round(entry.duration));
    });
    observer.observe({ entryTypes: ['longtask'] });

    const down = (x) =>
      new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, buttons: 1 });
    const move = (x) =>
      new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerId: 1, buttons: 1 });

    clip.dispatchEvent(down(box.left + 2));

    // A frame served with no work, to learn what this display's frame actually costs. Comparing the
    // drag against 16.7 ms would measure the monitor; comparing it against this measures the drag.
    const idleStart = performance.now();
    for (let i = 0; i < 10; i += 1) await new Promise((r) => requestAnimationFrame(r));
    const frameMs = (performance.now() - idleStart) / 10;

    const started = performance.now();
    for (let i = 0; i < moves; i += 1) {
      window.dispatchEvent(move(box.left + 2 + i * 3));
      await new Promise((r) => requestAnimationFrame(r));
    }
    const wall = performance.now() - started;

    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: box.left + 2 + moves * 3,
        clientY: y,
        pointerId: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    observer.disconnect();

    return { wall, frameMs, long };
  }, MOVES);

  const perMove = measured.wall / MOVES;
  const refreshHz = Math.round(1000 / measured.frameMs);

  if (measured.long.length > 0) {
    fail(`the main thread blocked ${measured.long.length} time(s): ${measured.long.join(', ')} ms`);
  } else {
    pass('the drag never blocked the main thread');
  }

  /*
   * Against the spec's 16 ms, not against this display.
   *
   * The idle frame is measured and reported, but deliberately not asserted on: the first version of
   * this check compared the drag to it and failed on a 123 Hz monitor, where keeping pace means 8.1 ms
   * — a stricter bar than the spec sets, imposed by whichever screen the harness happened to run on.
   * A requirement that moves with the hardware is not a requirement.
   */
  if (perMove > BUDGET_MS) {
    fail(
      `a pointer move cost ${perMove.toFixed(1)} ms at ${CLIPS} clips, over the ${BUDGET_MS} ms budget ` +
        `(${Math.round(measured.wall)} ms for ${MOVES} moves; this display serves ${refreshHz} Hz)`,
    );
  } else {
    pass(
      `a pointer move cost ${perMove.toFixed(1)} ms of the ${BUDGET_MS} ms budget at ${CLIPS} clips ` +
        `(display ${refreshHz} Hz)`,
    );
  }

  if (errors.length > 0) fail(`the renderer raised ${errors.length}: ${errors[0]}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close().catch(() => undefined);
  // The group, not the process: `npx` spawns Electron as a child and killing only the wrapper leaves
  // the shell running with the debugging port held open.
  try {
    process.kill(-electron.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

console.log(process.exitCode ? 'perfcheck failed' : 'perfcheck passed');
