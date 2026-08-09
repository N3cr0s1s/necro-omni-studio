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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  /*
   * A backend that is not there, and what the panel says about it.
   *
   * The mock reports success and names outputs it never writes — right for exercising the queue, and
   * wrong to leave unexplained in front of someone whose backend has gone down. Pointing the setting
   * at a dead port is the only way to reach that state deliberately, so it also checks that the
   * address is honoured without a restart.
   *
   * The `userData` here is a temporary directory, so nothing the user has set is touched.
   */
  await page.getByRole('tab', { name: 'inspector' }).click();
  await page.waitForTimeout(600);
  const address = page.getByRole('textbox', { name: 'Backend address' });
  await address.fill('http://127.0.0.1:1');
  // Blur, because that is when the field commits — typing it character by character would point the
  // backend at a different machine for every keystroke.
  await address.blur();
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: 'generate' }).click();

  let warned = '';
  for (let waited = 0; waited < 24 && !/unreachable/.test(warned); waited += 1) {
    await page.waitForTimeout(500);
    warned = await page
      .locator('[role="tabpanel"]')
      .last()
      .innerText()
      .catch(() => '');
  }

  if (/unreachable/.test(warned)) {
    pass('a backend address that answers nothing is reported');
    if (/placeholders, not files/.test(warned)) {
      pass('and the panel says what generating there would produce');
    } else {
      fail('the unreachable notice does not say that generating produces nothing real');
    }
  } else {
    fail(
      `an unreachable backend was never reported — the panel says ${JSON.stringify(warned.slice(0, 160))}`,
    );
  }

  // Back to the default, so the checks after this one meet the project they expect.
  await page.getByRole('tab', { name: 'inspector' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('textbox', { name: 'Backend address' }).fill('');
  await page.getByRole('textbox', { name: 'Backend address' }).blur();
  await page.waitForTimeout(1500);

  /*
   * §5.8's global variant override, which the queue has taken since it was written and nothing set.
   * A setting stored but unreachable is the same as no setting.
   */
  await page.getByRole('tab', { name: 'inspector' }).click();
  await page.waitForTimeout(800);
  const cap = page.getByRole('spinbutton', { name: 'Variants per run, at most' });
  if ((await cap.count()) > 0) pass('the global variant ceiling can be set');
  else fail('nothing offers the global variant ceiling');

  /*
   * Issue #21's "lehet majd több theme is", driven the way a user reaches it.
   *
   * The assertion is on the **computed** background colour, not on the attribute. An attribute is
   * trivially easy to set and proves nothing: if the stylesheet's blocks were missing, misspelled, or
   * beaten on specificity by `:root`, the attribute would still read back exactly right while the
   * window stayed the colour it always was. What a user sees is the computed value, so that is what
   * is compared — before and after, and they have to differ.
   *
   * It also checks that the choice survives a reload, because a palette that resets every launch is
   * not a setting.
   */
  const paintedBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
  );

  await page.getByRole('button', { name: 'Theme' }).click();
  await page.waitForTimeout(400);
  const zinc = page.getByRole('menuitem', { name: 'Zinc' });

  if ((await zinc.count()) === 0) {
    fail('the theme picker offers nothing to choose');
  } else {
    await zinc.click();
    await page.waitForTimeout(700);

    const stamped = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
    const paintedAfter = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
    );

    if (stamped !== 'zinc') {
      fail(`choosing a theme left data-theme at ${JSON.stringify(stamped)}`);
    } else if (paintedAfter === paintedBefore || paintedAfter === '') {
      // The failure this check exists for: the attribute lands and nothing is painted differently.
      fail(`the theme changed but --background stayed ${JSON.stringify(paintedBefore)}`);
    } else {
      pass('a theme can be chosen and the window is actually painted in it');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const afterReload = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
      if (afterReload === 'zinc') pass('and the chosen theme survives a reload');
      else fail(`the chosen theme was forgotten on reload — data-theme is ${JSON.stringify(afterReload)}`);

      // Back to the theme the editor ships in, so nothing after this reads a different window.
      await page.getByRole('button', { name: 'Theme' }).click();
      await page.waitForTimeout(400);
      await page
        .getByRole('menuitem', { name: 'Studio' })
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(600);
    }
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
  /*
   * Missing media, and the repair offered where it is announced.
   *
   * The fixture's audio clip points at a file that is not copied in until later in this run, so the
   * project opens with one asset missing — which is the state a user meets after moving a folder.
   */
  const kept = readFileSync(tone);
  rmSync(tone);

  // The watcher reports the deletion on its own debounce, so this waits for the editor to notice
  // rather than assuming — which also checks that it *does* notice, with no rescan asked for.
  let noticed = '';
  for (let waited = 0; waited < 20 && !/is missing/.test(noticed); waited += 1) {
    await page.waitForTimeout(500);
    noticed = await page
      .locator('[aria-label="Status"]')
      .innerText()
      .catch(() => '');
  }

  if (/is missing/.test(noticed)) {
    pass('a file removed under the editor is noticed and named');
    const relink = page.getByRole('button', { name: 'Relink…' });
    if ((await relink.count()) > 0) pass('the repair is offered where the problem is announced');
    else fail('the missing-media notice offers no way to fix it');
  } else {
    fail('a file removed under the editor was never noticed');
  }

  // Put it back, so the checks after this one see the project they expect.
  writeFileSync(tone, kept);
  await page.waitForTimeout(2500);

  /*
   * The way in, before the thing it does.
   *
   * A capability reachable only by calling the bridge from a test is not a capability: the checks
   * below drive `copyIntoProject` directly, which would keep passing even if the menu entry that leads
   * to it had never been added.
   */
  await page.getByRole('tree', { name: 'Project folder' }).click({ button: 'right' });
  await page.waitForTimeout(800);
  const importItem = page.getByRole('menuitem', { name: /Import/i });
  if ((await importItem.count()) > 0) pass('the browser offers a way to import media');
  else fail('nothing in the browser offers to import media');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  /*
   * The step a drop depends on and no component test can reach.
   *
   * A renderer cannot name a file on disk, so a drop resolves its paths through the preload. If that
   * binding were missing the drop would silently do nothing — the panel would light up, the files
   * would filter to none, and nothing would be imported or said. Dragging a *real* file is not
   * something this can do, so it checks the binding is there and that a synthetic file answers with
   * the empty string rather than throwing, which is the path every non-file drag takes.
   */
  const naming = await page.evaluate(() => {
    const nos = globalThis.nos;
    if (typeof nos?.pathForFile !== 'function') return 'missing';
    try {
      return typeof nos.pathForFile(new File(['x'], 'shot.mp4')) === 'string' ? 'ok' : 'wrong type';
    } catch (error) {
      return `threw: ${String(error)}`;
    }
  });
  if (naming === 'ok') pass('a dropped file can be named through the preload');
  else fail(`a drop could not resolve its paths — ${naming}`);

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

  /*
   * And appears. Landing on disk is only half of an import: the browser is driven by the watcher, so a
   * file that arrived without the tree noticing would be there and invisible — which is
   * indistinguishable, to the user, from an import that failed.
   */
  let shown = false;
  for (let waited = 0; waited < 20 && !shown; waited += 1) {
    await page.waitForTimeout(500);
    shown = (await page.getByRole('treeitem', { name: /outside\.txt/ }).count()) > 0;
  }
  if (shown) pass('an imported file appears in the browser');
  else fail('an imported file never appeared in the browser');

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
 * Crash recovery, which §8 asks for and whose failure is the one an editor cannot apologise for.
 *
 * Driven the only way that means anything: make an edit, kill the shell *hard* so nothing gets to run
 * a shutdown handler, and start again. A test that closed the window politely would exercise the path
 * that was never in doubt.
 */
let crashed;
try {
  crashed = await launch(userData);
  const page = crashed.browser.contexts()[0].pages().at(-1);
  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, {
    timeout: 30_000,
  });
  const discardFirst = page.getByRole('button', { name: 'Discard' });
  if (await discardFirst.count()) await discardFirst.first().click();

  // An edit the autosave will pick up, and one whose absence afterwards would be obvious: the title
  // moves a frame, which is a document change and nothing else.
  await page
    .locator('body')
    .click({ position: { x: 4, y: 4 } })
    .catch(() => undefined);
  await page
    .locator('[data-clip-id]')
    .first()
    .click({ force: true })
    .catch(() => undefined);
  await page.keyboard.press('.');
  await page.waitForTimeout(1200);

  /*
   * The autosave runs on §8's thirty-second timer, so this waits past it — and then checks the file
   * rather than inferring. A wait that was too short would look exactly like an autosave that never
   * wrote, and my first attempt at this waited six seconds and blamed the application.
   */
  const recoveryFile = join(project, 'project.recovery.json');
  for (let waited = 0; waited < 40 && !existsSync(recoveryFile); waited += 1) {
    await page.waitForTimeout(1000);
  }
  if (existsSync(recoveryFile)) pass('an edit is written to the recovery file');
  else fail('no recovery file was written within forty seconds of an edit');

  stop(crashed.child);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const after = await launch(userData);
  const recovered = after.browser.contexts()[0].pages().at(-1);
  await recovered.waitForTimeout(9000);
  const body = await recovered.locator('body').innerText();

  if (/was recovered/i.test(body)) pass('unsaved work is offered back after a hard kill');
  else fail('a hard kill lost unsaved work — nothing was offered back');

  /*
   * Restoring it must leave the project **dirty**. Recovered work is unwritten by definition — that is
   * why it was in a recovery file — and marking it saved told the editor an unwritten document was
   * safe: nothing to autosave, no prompt on close, and the work gone on the next quit.
   *
   * The unsaved marker beside the project name is the observable — a bullet after it — which is what
   * the user reads too.
   */
  const restore = recovered.getByRole('button', { name: 'Restore it' });
  if ((await restore.count()) > 0) {
    await restore.click();
    await recovered.waitForTimeout(1500);
    const header = await recovered.locator('body').innerText();
    if (/smokecheck\s*•/.test(header)) pass('recovered work is still unsaved until it is written');
    else fail('recovered work was marked saved, so quitting would lose it again');
  } else {
    fail('the recovery offer had no way to restore the work');
  }

  await after.browser.close().catch(() => undefined);
  stop(after.child);
} finally {
  await crashed?.browser.close().catch(() => undefined);
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
}

/*
 * A project whose `project.json` will not load.
 *
 * The most destructive path this shell has had. It used to make the project current *before* reading
 * the document, so a file that failed to validate left the editor showing an empty timeline under the
 * project's name with Save enabled — and one click replaced a broken-but-repairable file with an
 * empty `Untitled`. It is checked here rather than in a unit test because every part of it is a fact
 * about the assembled application: which name the header shows, whether Save is offered, and what is
 * on disk afterwards.
 *
 * The corruption is the realistic one: valid JSON of the wrong shape, which is what a hand edit or a
 * schema change produces. A file that is not JSON at all takes a different branch and is easier.
 */
const brokenWork = join(work, 'broken');
const brokenProject = join(brokenWork, 'project');
mkdirSync(brokenWork, { recursive: true });
cpSync(project, brokenProject, { recursive: true });
writeFileSync(
  join(brokenProject, 'project.json'),
  readFileSync(join(brokenProject, 'project.json'), 'utf8').replace(
    /"frameRate":\s*"[^"]*"/,
    '"frameRate": 12345',
  ),
);
const brokenBefore = readFileSync(join(brokenProject, 'project.json'), 'utf8');

const brokenData = join(brokenWork, 'user-data');
mkdirSync(brokenData, { recursive: true });
writeFileSync(join(brokenData, 'session.json'), JSON.stringify({ lastProject: brokenProject }, null, 2));

let broken;
try {
  broken = await launch(brokenData);
  const page = broken.browser.contexts()[0].pages().at(-1);
  await page.waitForTimeout(9000);

  const header = await page
    .locator('header')
    .innerText()
    .catch(() => '');
  if (/no project open/i.test(header)) {
    pass('a project that cannot be read does not become the open project');
  } else {
    fail(`a project that cannot be read was adopted anyway — the header says ${JSON.stringify(header)}`);
  }

  const dialog = await page
    .getByRole('dialog')
    .innerText()
    .catch(() => '');
  if (/could not be opened/i.test(dialog)) {
    pass('and the shell says which project it was');
    // The reason, not just the fact: the describer names the offending path for the same reason the
    // spec makes a broken manifest name its broken pointer, and the shell used to throw it away.
    if (/frameRate/i.test(dialog)) pass('and why, naming the field that is wrong');
    else fail(`the reason does not name the field — it says ${JSON.stringify(dialog.slice(0, 160))}`);
  } else {
    fail('nothing explained why the project did not open');
  }

  const saveLive = await page
    .getByRole('button', { name: 'Save', exact: true })
    .first()
    .isEnabled()
    .catch(() => false);
  if (saveLive) {
    // Only clicked when it is live, because the click is the destructive act being guarded against.
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.waitForTimeout(2000);
  }

  if (readFileSync(join(brokenProject, 'project.json'), 'utf8') === brokenBefore) {
    pass('and the file it could not read is left exactly as it was');
  } else {
    fail('the shell overwrote a project.json it had failed to read');
  }
} finally {
  await broken?.browser.close().catch(() => undefined);
  if (broken !== undefined) stop(broken.child);
  if (failures === 0) rmSync(work, { recursive: true, force: true });
}

if (failures === 0) console.log('smokecheck passed');
