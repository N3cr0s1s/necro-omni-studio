/**
 * Asserts that what the preview shows is what the export delivers.
 *
 * This exists because of a bug that every unit test in the repository missed. The export built its own
 * render plan without a text cache key and never rasterized a title, so the plan asked for text by clip
 * id while the rasterizer stored it by content hash — and **every title was silently absent from every
 * delivered file**. The preview showed it. Each side was correct on its own; only the pair was wrong.
 *
 * So this drives the real application: it launches the shell, opens a project, clicks Export, and reads
 * the *delivered mp4* back with ffmpeg. Nothing is stubbed, because the failure lived precisely in the
 * seam between the parts a stub would replace.
 *
 * The fixture has no media in it — a title alone exercises the path that broke — so there is no binary
 * asset in the repository and nothing to keep in sync.
 *
 * Usage, from the repository root:
 *   npm --prefix apps/desktop run build
 *   node apps/desktop/exportcheck/run.mjs
 *
 * Exits non-zero if any expectation fails, so it can gate a release.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');

/**
 * A port nothing else holds.
 *
 * Asked of the operating system rather than picked from a range. A hard-coded one cost an hour once:
 * an unrelated process held it, Electron could not bind its DevTools, and the only symptom was a
 * connection timeout that looked like the application failing to start.
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

// A throwaway copy, so a run never writes into the checked-in fixture and two runs cannot collide.
const work = mkdtempSync(join(tmpdir(), 'nos-exportcheck-'));
// Named `exportcheck`, because the shell derives the export's filename from the folder's name — so a
// copy called anything else would deliver `<that>.mp4` and this would look for the wrong file.
const project = join(work, 'exportcheck');
cpSync(join(here, 'fixture'), project, { recursive: true });

/*
  The shell reopens the project it last had open, and remembers that in `userData`. Writing it here is
  how this drives a *native* folder picker without one — and it exercises the same restore path a user
  gets on every launch rather than a back door built for testing.
*/
const userData = join(work, 'user-data');
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'session.json'), JSON.stringify({ lastProject: project }, null, 2));

const port = await freePort();
const electron = spawn(
  'npx',
  ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${userData}`],
  // `ignore`, not `pipe`. Nothing here reads the shell's output, and an unread pipe keeps this
  // process alive after the child is killed — the harness printed every result and then hung.
  { cwd: desktop, stdio: 'ignore', detached: true },
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
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // The project reopens by itself; waiting for a clip is waiting for that to have happened.
  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, {
    timeout: 30_000,
  });

  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  await page.getByRole('button', { name: 'Export' }).first().click();
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Export' }).click();
  await page.waitForFunction(() => document.body.textContent?.includes('complete') === true, {
    timeout: 180_000,
  });

  if (errors.length > 0) fail(`the renderer raised ${errors.length}: ${errors[0]}`);

  const delivered = join(project, 'renders', 'exportcheck.mp4');
  if (!existsSync(delivered)) {
    fail('no file was delivered');
  } else {
    // Read back as raw luminance and find what is lit. A title that reached the file has a bounding
    // box; the bug this guards against produced a frame that was uniformly black.
    const width = 1920;
    const height = 1080;

    /** One frame of the delivered file, as raw luminance. */
    const frameAt = (index) =>
      spawnSync(
        'ffmpeg',
        [
          ...['-v', 'error', '-i', delivered],
          // `select` rather than a seek: the file is thirty frames long and seeking a sub-second
          // clip lands on a keyframe, which would silently read frame 0 for every index asked for.
          ...['-vf', `select=eq(n\\,${index})`, '-vsync', '0', '-vframes', '1'],
          ...['-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
        ],
        { maxBuffer: 1 << 28 },
      ).stdout;

    /** What is lit in a frame, and how far right it reaches. */
    const inkOf = (pixels) => {
      let lit = 0;
      let left = width;
      let right = -1;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          if (pixels[y * width + x] > 40) {
            lit += 1;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      return { lit, left, right };
    };

    const pixels = frameAt(25);

    if (pixels.length < width * height) {
      fail('the delivered file could not be decoded — is ffmpeg installed?');
    } else {
      const { lit, left, right } = inkOf(pixels);

      const coverage = lit / ((width / 2) * (height / 2));
      // Generous bounds either side. The assertion is "a title is there", not "these exact glyphs":
      // a font substitution changes the pixels and must not fail this.
      if (coverage < 0.01) fail(`the delivered frame is blank — coverage ${coverage.toFixed(4)}`);
      else if (coverage > 0.5) fail(`the delivered frame is not a title — coverage ${coverage.toFixed(4)}`);
      else console.log(`✓ the title reached the delivered file (coverage ${(coverage * 100).toFixed(1)}%)`);

      // Centred to within a tenth of the frame. Catches a title drawn into a corner, which is what an
      // origin or a row order getting flipped between the two paths would look like.
      const centre = (left + right) / 2 / width;
      if (Math.abs(centre - 0.5) > 0.1) fail(`the title is off centre at ${centre.toFixed(3)}`);
      else console.log(`✓ the title is where the preview puts it (centre ${centre.toFixed(3)})`);

      /*
       * The typewriter, read off the delivered file.
       *
       * The fixture types its title over the first twenty frames, so frame 4 must show *some* of it
       * and less of it than frame 25 does. This is the check that would have caught the reveal being
       * computed and then ignored: every frame was fully typed, and nothing anywhere said so.
       */
      const early = frameAt(4);
      if (early.length < width * height) {
        fail('the early frame could not be decoded');
      } else {
        const partial = inkOf(early);
        if (partial.lit === 0) {
          fail('nothing is typed four frames in — the reveal hides the whole title');
        } else if (partial.lit >= lit) {
          fail(`the title is not being typed: ${partial.lit} lit early against ${lit} when complete`);
        } else if (partial.right >= right) {
          fail(`the reveal is not cutting from the right: reaches ${partial.right} against ${right}`);
        } else {
          const share = ((partial.lit / lit) * 100).toFixed(0);
          console.log(`✓ the typewriter reached the delivered file (${share}% typed at frame 4)`);
        }
      }
    }
  }
} finally {
  await browser?.close().catch(() => undefined);
  // The group, not the process: Electron's main process spawns renderers and utilities, and killing
  // only the parent leaves them holding the port for the next run.
  try {
    process.kill(-electron.pid, 'SIGTERM');
  } catch {
    electron.kill('SIGTERM');
  }
  // Left behind on failure, so the delivered file can be looked at.
  if (process.exitCode === undefined || process.exitCode === 0)
    rmSync(work, { recursive: true, force: true });
  else console.error(`  the run is left in ${work}`);
}

if (process.exitCode === undefined || process.exitCode === 0) console.log('exportcheck passed');
