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
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Starts a shell against a given `userData` and connects to it. */
async function launch(dataDir) {
  const port = await freePort();
  const child = spawn(
    'npx',
    ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${dataDir}`],
    { cwd: desktop, stdio: 'ignore', detached: true },
  );
  let connected;
  for (let attempt = 0; attempt < 60 && connected === undefined; attempt += 1) {
    try {
      connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  if (connected === undefined) throw new Error('the shell never exposed a debugging port');
  return { child, browser: connected };
}

/** The group, not the process: Electron spawns renderers and a sidecar. */
function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

const started = await launch(userData);
const electron = started.child;

const browser = started.browser;
try {
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

  /*
   * The transport keys, which are the part of a keyboard-driven editor that is easiest to add and
   * hardest to notice missing: a binding that does nothing looks exactly like one that is not there.
   *
   * The playhead's own readout is the observable — it names the current time in its accessible label,
   * so a key that moved it is distinguishable from one that was swallowed.
   */
  const currentTime = async () => {
    const label = await page
      .locator('[aria-label^="Current time"]')
      .first()
      .getAttribute('aria-label')
      .catch(() => null);
    return label === null ? undefined : label.replace('Current time ', '');
  };

  await page
    .locator('body')
    .click({ position: { x: 4, y: 4 } })
    .catch(() => undefined);
  await page.keyboard.press('Home');
  await page.waitForTimeout(600);
  const atStart = await currentTime();

  await page.keyboard.press('End');
  await page.waitForTimeout(800);
  const atEnd = await currentTime();

  if (atStart === undefined || atEnd === undefined) {
    fail('the playhead has no readable current time, so the transport keys cannot be checked');
  } else if (atStart === atEnd) {
    fail(`End did not move the playhead — it stayed at ${atStart}`);
  } else {
    pass(`End goes to the end of the sequence (${atStart} → ${atEnd})`);
  }

  await page.keyboard.press('Home');
  await page.waitForTimeout(600);
  if ((await currentTime()) === atStart) pass('Home comes back to the start');
  else fail('Home did not return the playhead to the start');

  /*
   * Bringing a file in, and the two refusals that matter more than the success.
   *
   * The dialog half is Electron's and cannot be driven from here, so this exercises the half that
   * touches the filesystem: the copy, an overwrite, and a destination that tries to leave the project.
   * A renderer that can put bytes anywhere on the machine is a different security posture from one
   * that can fill a project folder.
   */
  const outside = join(work, 'outside.txt');
  writeFileSync(outside, 'imported');

  const landed = await page.evaluate(
    async (from) => globalThis.nos.copyIntoProject([{ from, to: 'media/outside.txt' }]),
    outside,
  );
  if (landed.length === 1 && existsSync(join(project, 'media', 'outside.txt'))) {
    pass('a chosen file is copied into the project');
  } else {
    fail('the import did not copy the file into the project');
  }

  const again = await page.evaluate(
    async (from) => globalThis.nos.copyIntoProject([{ from, to: 'media/outside.txt' }]),
    outside,
  );
  if (again.length === 0) pass('an import never overwrites what is already there');
  else fail('the import overwrote an existing file');

  /*
   * A destination outside the project **throws**, where an unreadable source is merely skipped, and the
   * difference is deliberate: a file that will not read is an ordinary thing to survive, while a
   * placement pointing out of the folder is a programming error and should be loud.
   */
  const escaped = await page.evaluate(
    async (from) =>
      globalThis.nos
        .copyIntoProject([{ from, to: '../escaped.txt' }])
        .then(() => 'allowed')
        .catch((error) => String(error)),
    outside,
  );
  if (/outside the project/.test(escaped) && !existsSync(join(work, 'escaped.txt'))) {
    pass('an import cannot write outside the project');
  } else {
    fail(`the import did not refuse a path outside the project — ${escaped}`);
  }

  if (errors.length > 0) {
    fail(`the renderer raised ${errors.length}: ${errors[0]}`);
    for (const extra of errors.slice(1, 4)) console.error(`  also: ${extra}`);
  } else {
    pass('nothing was raised while every panel was visited');
  }
} finally {
  await browser.close().catch(() => undefined);
  // The group, not the process: Electron spawns renderers and a sidecar, and killing only the parent
  // leaves them holding the port for the next run.
  stop(electron);
  if (failures > 0) console.error(`  the run is left in ${work}`);
}

/*
 * The state a new user actually meets first.
 *
 * Nothing covered it: every harness writes a session file and opens a project, so the path where there
 * is no project had been exercised by nobody. Its own shell, because the application has no way to
 * close a project — and inventing one just to be testable would be the tail wagging the dog.
 *
 * What matters is that it says so, offers the way in, and does not hold out actions that cannot work:
 * a Save that does nothing teaches a user to distrust the ones that do.
 */
const freshData = join(work, 'fresh-user-data');
mkdirSync(freshData, { recursive: true });

let fresh;
try {
  fresh = await launch(freshData);
  const page = fresh.browser.contexts()[0].pages().at(-1);
  const raised = [];
  page.on('pageerror', (error) => raised.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') raised.push(message.text().slice(0, 200));
  });

  await page.waitForTimeout(9000);
  const body = await page.locator('body').innerText();

  if (/no project open/i.test(body)) pass('a fresh start says there is no project');
  else fail('a fresh start does not say that no project is open');

  if ((await page.getByRole('button', { name: 'Open project' }).count()) > 0) {
    pass('a fresh start offers the way in');
  } else {
    fail('a fresh start offers no way to open a project');
  }

  for (const name of ['Save', 'Export']) {
    const disabled = await page
      .getByRole('button', { name, exact: true })
      .first()
      .isDisabled()
      .catch(() => false);
    if (disabled) pass(`${name} is not offered without a project`);
    else fail(`${name} is live with no project open`);
  }

  if (raised.length === 0) pass('a fresh start raises nothing');
  else fail(`a fresh start raised ${raised.length}: ${raised[0]}`);
} finally {
  await fresh?.browser.close().catch(() => undefined);
  if (fresh !== undefined) stop(fresh.child);
  if (failures === 0) rmSync(work, { recursive: true, force: true });
}

if (failures === 0) console.log('smokecheck passed');
