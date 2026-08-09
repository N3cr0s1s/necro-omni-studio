/**
 * Asserts that the application opens and every part of it draws.
 *
 * The other harnesses each drive one capability to its end: `exportcheck` reads the delivered file,
 * `perfcheck` measures a drag, `glcheck` compiles the shaders. None of them asks the plainest question
 * there is — does the editor come up, does a project open, and does every panel render without
 * throwing? A component that crashes on mount takes its whole panel with it, and nothing here would
 * have noticed until someone clicked that tab.
 *
 * It is deliberately shallow and wide. Depth belongs to the harness that owns the capability; this one
 * touches everything once, which is the coverage no unit test gives because a unit test renders one
 * component with props it chose rather than the ones the shell actually passes.
 *
 * Every renderer error is fatal, including ones that leave the screen looking fine. A React error
 * boundary that swallows a mount failure, a promise rejection nobody awaited, a missing key on a list
 * — all of them are defects, and all of them are invisible to a screenshot.
 *
 * Usage, from the repository root:
 *   npm --prefix apps/desktop run build
 *   node apps/desktop/smokecheck/run.mjs
 *
 * Exits non-zero if any expectation fails, so it can gate a release.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');

/** A port nothing else holds, asked of the operating system rather than picked. */
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

let failures = 0;
function fail(message) {
  console.error(`✗ ${message}`);
  failures += 1;
  process.exitCode = 1;
}
function pass(message) {
  console.log(`✓ ${message}`);
}

// A throwaway copy of exportcheck's fixture: it already has a title, an audio clip, a project-local
// effect and a generator folder, which is more of the application's surface than a bare project.
const work = mkdtempSync(join(tmpdir(), 'nos-smokecheck-'));
const project = join(work, 'smokecheck');
cpSync(join(desktop, 'exportcheck', 'fixture'), project, { recursive: true });

/*
 * The fixture's audio, synthesized as `exportcheck` does — the file is not in the repository, so a
 * copy of the fixture alone leaves the audio clip pointing at nothing and the sidecar rightly answers
 * 404 when the waveform is asked for. That is the harness being wrong, not the application.
 */
const tone = join(project, 'media', 'tone.wav');
mkdirSync(dirname(tone), { recursive: true });
const synth = spawnSync('ffmpeg', [
  ...['-v', 'error', '-y'],
  ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000'],
  ...['-ac', '2', tone],
]);
if (synth.status !== 0) fail('the fixture tone could not be synthesized — is ffmpeg installed?');

const userData = join(work, 'user-data');
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'session.json'), JSON.stringify({ lastProject: project }, null, 2));

const port = await freePort();
const electron = spawn(
  'npx',
  ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${userData}`],
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

  /*
   * Collected from the first moment rather than checked at the end, so a failure during mount — the
   * most likely kind, and the one a later screenshot cannot show — is still attributed to what was on
   * screen when it happened.
   */
  const errors = [];
  page.on('pageerror', (error) => errors.push(`uncaught: ${String(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on('requestfailed', (request) => errors.push(`request failed: ${request.url().slice(0, 160)}`));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()}: ${response.url().slice(0, 160)}`);
  });

  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, {
    timeout: 30_000,
  });
  pass('the shell opens the project it last had open');

  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  // The landmarks the shell is built from. Absent means a region failed to mount, which is worth
  // saying by name rather than as "something went wrong".
  for (const [role, name] of [
    ['complementary', 'Inspector'],
    ['region', 'Timeline'],
    // A `<footer>` is `contentinfo`, not `region` — the landmark a screen reader jumps to for "what is
    // this application doing", which is exactly what the status bar is.
    ['contentinfo', 'Status'],
  ]) {
    if ((await page.getByRole(role, { name }).count()) > 0) pass(`${name} is on screen`);
    else fail(`${name} did not render`);
  }

  /*
   * Every tab of the inspector, because each mounts a different tree and three of them are the ones a
   * user reaches for first. A tab that throws on mount leaves an empty panel and no other symptom.
   */
  for (const tab of ['inspector', 'generate', 'variants', 'segment']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(700);
    const panel = page.locator('[role="tabpanel"]').last();
    const text = await panel.innerText().catch(() => '');
    if (text.trim().length > 0) pass(`the ${tab} panel draws something`);
    else fail(`the ${tab} panel is empty`);
  }

  // Back to the inspector with a clip selected, which is the state most of the panel's controls need.
  await page
    .locator('[data-clip-id]')
    .first()
    .click({ force: true })
    .catch(() => undefined);
  await page.getByRole('tab', { name: 'inspector' }).click();
  await page.waitForTimeout(700);

  // The dialogs, each of which is a tree that never mounts until it is asked for.
  await page.getByRole('button', { name: 'Export' }).first().click();
  await page.waitForTimeout(700);
  if ((await page.locator('[role="dialog"]').count()) > 0) pass('the export dialog opens');
  else fail('the export dialog did not open');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await page.keyboard.press('?');
  await page.waitForTimeout(700);
  const sheet = page.getByRole('dialog', { name: /keyboard/i });
  if ((await sheet.count()) > 0) {
    pass('the shortcut reference opens');
    await page.keyboard.press('Escape');
  } else {
    // Not fatal on its own: the binding may simply not be `?`. The reference existing is what matters,
    // and `exportcheck` does not cover it either way.
    console.log('· the shortcut reference did not open on "?" — check the binding');
  }
  await page.waitForTimeout(500);

  if (errors.length > 0) {
    fail(`the renderer raised ${errors.length}: ${errors[0]}`);
    for (const extra of errors.slice(1, 4)) console.error(`  also: ${extra}`);
  } else {
    pass('nothing was raised while every panel was visited');
  }
} finally {
  await browser?.close().catch(() => undefined);
  // The group, not the process: Electron spawns renderers and a sidecar, and killing only the parent
  // leaves them holding the port for the next run.
  try {
    process.kill(-electron.pid, 'SIGTERM');
  } catch {
    electron.kill('SIGTERM');
  }
  if (failures === 0) rmSync(work, { recursive: true, force: true });
  else console.error(`  the run is left in ${work}`);
}

if (failures === 0) console.log('smokecheck passed');
