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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/*
 * The fixture's audio, synthesized rather than committed.
 *
 * A binary in the repository for a one-second tone would be a strange thing to review, and ffmpeg is
 * already required to read the delivered file back. A tone is also the right *kind* of signal here: its
 * level is known, so "the export is silent" and "the export has audio" are separated by a number rather
 * than by listening.
 */
const tone = join(project, 'media', 'tone.wav');
mkdirSync(dirname(tone), { recursive: true });
const synth = spawnSync('ffmpeg', [
  ...['-v', 'error', '-y'],
  ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000'],
  ...['-ac', '2', tone],
]);
if (synth.status !== 0) fail('the fixture tone could not be synthesized — is ffmpeg installed?');

/*
 * A ramp on the tone, so the delivered audio can be asked whether it faded.
 *
 * Written into the fixture *copy* rather than committed, for the same reason the tone is synthesized:
 * the file on disk stays the plain case, and the property under test is stated here where the
 * assertion that reads it can be seen beside it.
 *
 * This is the audio half of the bug this harness was built for. Every title was once silently absent
 * from every delivered file because the export prepared its plan differently from the preview — and
 * the mixer has exactly the same shape of seam. A fade that plays and does not export would be
 * invisible to every test in the repository, because each half is correct on its own.
 */
const FADE_IN_FRAMES = 15;
{
  const file = join(project, 'project.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  for (const track of parsed.sequence.tracks) {
    for (const clip of track.clips ?? []) {
      if (clip.kind === 'audio') clip.fade = { inFrames: FADE_IN_FRAMES };
    }
  }
  writeFileSync(file, JSON.stringify(parsed, null, 2));
}

const port = await freePort();
/*
 * Hidden unless someone asks to watch. The harnesses drive a real shell over the debugging port
 * and never need a mapped window; three per run, several runs an hour, is a window stealing focus
 * from whoever is using the machine. `NOS_WATCH=1` shows them for when a run has to be seen.
 */
const electron = spawn(
  'npx',
  ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${userData}`],
  // `ignore`, not `pipe`. Nothing here reads the shell's output, and an unread pipe keeps this
  // process alive after the child is killed — the harness printed every result and then hung.
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
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // The project reopens by itself; waiting for a clip is waiting for that to have happened.
  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, {
    timeout: 30_000,
  });

  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  // Exact, because Playwright matches an accessible name by case-insensitive substring: this
  // fixture project is called `exportcheck`, so any button whose label mentions the destination —
  // the overwrite warning's "Save as exportcheck (2).mp4" — matches a loose `Export` too.
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes('complete') === true, {
    timeout: 180_000,
  });

  const delivered = join(project, 'renders', 'exportcheck.mp4');

  /*
   * A second export, from the same open window.
   *
   * Exporting, watching it finish and exporting again is an ordinary thing to do and it was broken:
   * the encoder job id was built from the output path and the frame count, so the second attempt
   * reused the first one's id and the sidecar refused it as a duplicate. The delivered file is removed
   * first, so its reappearance is proof this render happened rather than the previous artefact.
   *
   * The toolbar button is deliberately not clicked again — the dialog is still open, and clicking it
   * would close it.
   */
  rmSync(delivered, { force: true });
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Export', exact: true }).click();

  /*
   * Existing is not the same as finished: ffmpeg creates the file when it opens the muxer, so reading
   * it the moment it appears reads a header with no frames behind it. The size settling is the
   * observable end of the write, and it is what the frame checks below depend on.
   */
  let redelivered = false;
  let lastSize = -1;
  let settled = 0;
  for (let waited = 0; waited < 180 && !redelivered; waited += 1) {
    await page.waitForTimeout(1000);
    if (!existsSync(delivered)) continue;
    const size = statSync(delivered).size;
    settled = size > 0 && size === lastSize ? settled + 1 : 0;
    lastSize = size;
    redelivered = settled >= 2;
  }
  if (!redelivered) fail('a second export in the same session delivered nothing');
  else console.log('✓ a second export in the same session delivers too');

  /*
   * Exporting over a file that is already there.
   *
   * The encoder passes `-y` and the dialog offers the same `renders/<project>.mp4` every time it
   * opens, so a second export silently replaced the first — minutes of GPU time, and often the only
   * copy of a finished cut. Every other write in this application refuses to destroy without a word:
   * an import skips a name already taken, a delete goes to the trash.
   *
   * Checked here rather than in the component test because the warning depends on the *watcher*
   * having reported the file the export just wrote. A component test supplies that set directly and
   * would pass with the folder never being read at all.
   */
  const dialog = page.locator('[role="dialog"]');
  let warned = '';
  for (let waited = 0; waited < 30 && !/will be replaced/.test(warned); waited += 1) {
    await page.waitForTimeout(1000);
    warned = await dialog.innerText().catch(() => '');
  }

  if (!/will be replaced/.test(warned)) {
    fail('the dialog offered to overwrite a delivered file without saying so');
  } else {
    console.log('✓ exporting onto a delivered file says it will be replaced');

    const free = dialog.getByRole('button', { name: /^Save as / });
    if ((await free.count()) === 0) {
      fail('the overwrite warning offers no way past it');
    } else {
      await free.click();
      await page.waitForTimeout(500);
      await dialog.getByRole('button', { name: 'Export', exact: true }).click();

      const beside = join(project, 'renders', 'exportcheck (2).mp4');
      let landed = false;
      for (let waited = 0; waited < 180 && !landed; waited += 1) {
        await page.waitForTimeout(1000);
        landed = existsSync(beside) && statSync(beside).size > 0;
      }

      // Both, which is the whole point: the free name has to be a *second* file, not a rename of the
      // first.
      if (landed && existsSync(delivered)) {
        console.log('✓ and the free name delivers beside it rather than over it');
      } else {
        fail(
          `taking the free name did not leave both files — beside: ${landed}, first: ${existsSync(delivered)}`,
        );
      }
    }
  }

  if (errors.length > 0) fail(`the renderer raised ${errors.length}: ${errors[0]}`);

  /*
   * §4's promise: zipping the folder moves the whole project.
   *
   * That holds only while nothing the application writes records a path outside the folder.
   * `assetPath` enforces it for the document by refusing an absolute path at the brand constructor,
   * but the provenance sidecars, the mask records, the cache metadata and the rendered mixdown are
   * written by other code that never passes through it. This reads what a *finished* project actually
   * contains, which is the only place all of those meet.
   *
   * Graph pointers like `/52:3/inputs/seed` are JSON-Pointers into a workflow, not filesystem paths,
   * and the manifests are full of them.
   */
  const wrote = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) wrote.push(full);
    }
  };
  walk(project);

  const escapes = [];
  for (const file of wrote) {
    const text = readFileSync(file, 'utf8');
    for (const [, value] of text.matchAll(/"((?:\/|[A-Za-z]:\\\\)[^"]{3,})"/g)) {
      // A JSON-Pointer's first segment is a node id — digits, or digits with a colon. A filesystem
      // path's is a directory name, so the two are told apart without guessing.
      if (/^\/\d+(?::\d+)?\//.test(value)) continue;
      escapes.push(`${file.slice(project.length + 1)}: ${value}`);
    }
  }

  if (escapes.length > 0) {
    fail(`the project records ${escapes.length} path(s) outside itself — ${escapes[0]}`);
  } else {
    console.log(`✓ the project is self-contained (${wrote.length} files record no outside paths)`);
  }
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
      /*
       * The delivered sound.
       *
       * The export used to send the encoder an audio codec and a bitrate and never an audio *stream*,
       * so every file was silent whatever was on the audio tracks — and nothing said so. A stream that
       * exists is not enough either: an empty one would also pass a stream check, so the level is read.
       */
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', delivered],
        { encoding: 'utf8' },
      );
      if (!/\baudio\b/.test(probe.stdout ?? '')) {
        fail('the delivered file has no audio stream, though the sequence has an audio clip');
      } else {
        const volume = spawnSync(
          'ffmpeg',
          [
            '-v',
            'info',
            '-nostats',
            '-i',
            delivered,
            '-map',
            '0:a',
            '-af',
            'volumedetect',
            '-f',
            'null',
            '-',
          ],
          { encoding: 'utf8' },
        );
        const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(volume.stderr ?? '');
        const level = mean === null ? undefined : Number(mean[1]);
        // Digital silence reads about −91 dB. Anything above −60 is unambiguously programme material.
        if (level === undefined) fail('the delivered audio could not be measured');
        else if (level < -60) fail(`the delivered audio is silent at ${level} dB`);
        else console.log(`✓ the mix reached the delivered file (mean ${level} dB)`);

        /*
         * And that it *ramped*.
         *
         * A fade that plays and does not export is invisible to every unit test here: the model, the
         * mix plan and the offline renderer are each correct on their own, and only the pair of paths
         * can be wrong. Measured as two windows rather than one number — the first half of the ramp
         * against a stretch well past it — because absolute levels depend on the tone and the codec
         * while the *difference* between two windows of the same tone does not.
         */
        const windowLevel = (from, duration) => {
          const measured = spawnSync(
            'ffmpeg',
            [
              ...['-v', 'info', '-nostats'],
              ...['-ss', String(from), '-t', String(duration), '-i', delivered],
              ...['-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'],
            ],
            { encoding: 'utf8' },
          );
          const found = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(measured.stderr ?? '');
          return found === null ? undefined : Number(found[1]);
        };

        // The first quarter of the ramp against a window well clear of it, both inside the tone.
        const rampSeconds = FADE_IN_FRAMES / 30;
        const early = windowLevel(0, rampSeconds / 4);
        const later = windowLevel(rampSeconds, rampSeconds);

        if (early === undefined || later === undefined) {
          fail('the delivered audio could not be windowed to check the fade');
        } else if (early >= later - 6) {
          fail(
            `the fade did not reach the delivered file — ${early.toFixed(1)} dB at the start against ` +
              `${later.toFixed(1)} dB past the ramp`,
          );
        } else {
          console.log(
            `✓ the fade reached the delivered file (${early.toFixed(1)} dB rising to ${later.toFixed(1)} dB)`,
          );
        }
      }

      /*
       * The project's own effect, in the delivered file.
       *
       * The export built its effect registry from the builtins alone, so a clip carrying an effect from
       * the project's `effects/` folder rendered in the preview and fell back to passthrough here — the
       * effect simply absent, with nothing reported. The fixture's effect paints every lit pixel hard
       * red, which no antialiasing or codec can be blamed for.
       */
      const rgb = spawnSync(
        'ffmpeg',
        [
          ...['-v', 'error', '-i', delivered],
          ...['-vf', 'select=eq(n\\,25)', '-vsync', '0', '-vframes', '1'],
          ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        ],
        { maxBuffer: 1 << 28 },
      ).stdout;

      if (rgb.length < width * height * 3) {
        fail('the delivered frame could not be read as colour');
      } else {
        let red = 0;
        let litPixels = 0;
        for (let index = 0; index < width * height * 3; index += 3 * 8) {
          const r = rgb[index] ?? 0;
          const g = rgb[index + 1] ?? 0;
          const b = rgb[index + 2] ?? 0;
          if (r > 40 || g > 40 || b > 40) {
            litPixels += 1;
            // Red-dominant by a wide margin, so a grey title cannot be mistaken for a tinted one.
            if (r > 100 && r > g * 2 && r > b * 2) red += 1;
          }
        }
        const share = litPixels === 0 ? 0 : red / litPixels;
        if (litPixels === 0) fail('the delivered frame has nothing lit to check the effect against');
        else if (share < 0.8) {
          fail(
            `the project's own effect did not reach the export — ${(share * 100).toFixed(0)}% of lit pixels are red`,
          );
        } else {
          console.log(
            `✓ a project-local effect reached the delivered file (${(share * 100).toFixed(0)}% red)`,
          );
        }
      }

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
  /*
   * Left behind on failure, so the delivered file can be looked at.
   *
   * Retried, because the shell was sent SIGTERM a line ago and its renderers are still writing to
   * `user-data` while this walks the tree: an unretried remove raced them and threw `ENOTEMPTY`,
   * which failed a run whose every assertion had passed. A check that falls over in its own teardown
   * reports a green result as red, which is worse than not cleaning up at all.
   *
   * `smokecheck` already retried here. The fix existing in one harness and not its neighbour is the
   * same shape as every other gap in this repository, and it is why this comment names both.
   */
  if (process.exitCode === undefined || process.exitCode === 0)
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.error(`  the run is left in ${work}`);
}

if (process.exitCode === undefined || process.exitCode === 0) console.log('exportcheck passed');
