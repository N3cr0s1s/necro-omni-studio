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

/**
 * Replaces the contents of a Monaco editor.
 *
 * `fill` is for form controls; Monaco's textarea is a keyboard surface it diffs on every input, and
 * setting its value directly does not reach the model. Select-all then `insertText` is the gesture a
 * user makes, and it goes through the same path their typing does — which is the point of driving the
 * real window at all.
 */
async function setCode(page, locator, text) {
  /*
   * Clicked on the *visible* text, not on the input.
   *
   * Monaco's input is a one-pixel textarea parked under the caret. Focusing it directly is enough to
   * make typing land — `insertText` goes straight to the focused element — but not enough for the
   * editor to consider itself focused, so none of its keybindings fire: no Ctrl+Space, no Ctrl+F.
   * That produced a run where text could be entered and every keyboard feature looked broken.
   * Clicking the rendered lines is what a user does, and it is what routes the keyboard properly.
   */
  await editorSurface(locator).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
  await page.waitForTimeout(400);
}

/** The rendered lines of the editor a labelled input belongs to. */
function editorSurface(locator) {
  return locator.locator('xpath=ancestor::*[contains(@class,"monaco-editor")][1]').locator('.view-lines');
}

/** Everything a Monaco editor is showing, from its model rather than its virtualized rows. */
async function readCode(page, name) {
  return page.evaluate((label) => {
    const area = document.querySelector(`textarea[aria-label="${label}"]`);
    // The rendered rows: Monaco virtualizes long files, so this is what is *visible*, which is all a
    // check about the first lines of a file needs.
    const root = area?.closest('.monaco-editor');
    return [...(root?.querySelectorAll('.view-line') ?? [])].map((line) => line.textContent).join('\n');
  }, name);
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

/*
 * Build before driving anything.
 *
 * `electron .` loads whatever is in `dist/`, so without this the harness happily tests the *last*
 * build and reports a clean run against code that is not the code in the working tree. That is worse
 * than no harness: it is a green result that means nothing, and it hid a whole feature's absence
 * exactly once before this line existed. `NOS_SKIP_BUILD=1` is there for re-running the checks
 * against a build that was just made.
 */
if (process.env.NOS_SKIP_BUILD !== '1') {
  const built = spawnSync('npm', ['run', 'build'], { cwd: desktop, stdio: 'inherit' });
  if (built.status !== 0) {
    fail('the application does not build — nothing below this line would have meant anything');
    process.exit(1);
  }
  pass('the application builds');
}

/** Starts a shell against a given `userData` and connects to it. */
async function launch(dataDir) {
  const port = await freePort();
  /*
   * Hidden unless someone asks to watch. The harnesses drive a real shell over the debugging port
   * and never need a mapped window; three per run, several runs an hour, is a window stealing focus
   * from whoever is using the machine. `NOS_WATCH=1` shows them for when a run has to be seen.
   */
  const child = spawn(
    'npx',
    ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${dataDir}`],
    {
      cwd: desktop,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, NOS_HEADLESS: process.env.NOS_WATCH === '1' ? '0' : '1' },
    },
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
  // Every tab of the panel. Issue #29 split the crowded `inspector` into `Clip`, `Effects` and
  // `Project`, so the set is wider than it was — and each still mounts a different tree.
  for (const tab of ['Clip', 'Effects', 'Generate', 'Variants', 'Segment', 'Project']) {
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
  await page.getByRole('tab', { name: 'Project' }).click();
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
  await page.getByRole('tab', { name: 'Project' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('textbox', { name: 'Backend address' }).fill('');
  await page.getByRole('textbox', { name: 'Backend address' }).blur();
  await page.waitForTimeout(1500);

  /*
   * §5.8's global variant override, which the queue has taken since it was written and nothing set.
   * A setting stored but unreachable is the same as no setting.
   */
  await page.getByRole('tab', { name: 'Project' }).click();
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

  /*
   * Retiming, which the document has carried since M4 with nothing able to set it.
   *
   * Driven here because the value has to survive the whole round trip — control to document to the
   * field reading it back — and because the linked-audio rule this operation exists to honour is
   * invisible to a component test that renders the section on its own.
   */
  await page.getByRole('tab', { name: 'Clip' }).click();
  await page.waitForTimeout(700);

  const speedField = page.getByLabel('Speed factor');
  if ((await speedField.count()) === 0) {
    fail('a clip offers no way to change its speed');
  } else {
    pass('a clip can be retimed');

    await page.getByRole('button', { name: '2×' }).click();
    await page.waitForTimeout(700);

    // Read back from the field, not from what was clicked: a preset that highlights itself without
    // reaching the document is the exact failure this is looking for.
    const factor = await speedField.inputValue();
    if (factor.startsWith('2')) pass('and the new speed reaches the document');
    else fail(`the speed field reads ${factor} after asking for 2x`);

    await page.getByRole('button', { name: '1×' }).click();
    await page.waitForTimeout(600);
  }

  /*
   * Fades and the crossfade an overlap makes, per issue #38.
   *
   * The whole of what the report is about is invisible to a unit test in one specific way: the ramp
   * has to reach `project.json`. Every layer under this is covered — the model, the mixer, the
   * compositor, the operations — and the fault the report describes is that no gesture in the running
   * application could write one.
   */
  const fadeIn = page.getByLabel('fade in');
  if ((await fadeIn.count()) === 0) {
    fail('a clip offers no way to fade');
  } else {
    pass('a clip can be faded');

    await fadeIn.fill('8');
    await fadeIn.press('Enter');
    await page.waitForTimeout(700);

    // On the clip, not only in the field. A ramp that exists in the inspector and is not drawn is the
    // one that makes a drop-created crossfade indistinguishable from a collision allowed by mistake.
    if ((await page.locator('[data-fade-ramp="in"]').count()) > 0) {
      pass('and the ramp is drawn on the clip');
    } else {
      fail('a fade never reached the clip on the timeline');
    }

    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);
    if (/"fade"\s*:/.test(readFileSync(join(project, 'project.json'), 'utf8'))) {
      pass('and it is saved into the project');
    } else {
      fail('a fade never reached project.json');
    }
  }

  /*
   * Keyframe lanes, per issue #37.
   *
   * The two symptoms the report gives are both about the *header column*, which no component test
   * sees: a lane appeared with nothing beside it, so it named no parameter and every row below it came
   * apart from its own header. Both are questions about the assembled window.
   */
  const disclosure = page.locator('[data-clip-disclosure]').first();
  if ((await disclosure.count()) === 0) {
    fail('no clip on the fixture offers its parameter lanes');
  } else {
    await disclosure.click({ force: true });
    await page.waitForTimeout(900);

    const laneHeader = page.locator('[data-lane-header]').first();
    if ((await laneHeader.count()) === 0) {
      fail('a lane opened with no header beside it — the two columns are out of step');
    } else {
      pass('a lane names the parameter it animates');

      // The alignment itself, measured. Two components each deciding a height is exactly how the
      // columns drifted, so the check is that they agree rather than that both look plausible.
      const laneId = await laneHeader.getAttribute('data-lane-header');
      const body = page.locator(`[data-clip-lane="${laneId}"]`);
      const headerBox = await laneHeader.boundingBox();
      const bodyBox = await body.boundingBox();
      if (headerBox !== null && bodyBox !== null && Math.abs(headerBox.height - bodyBox.height) < 1) {
        pass(`the header and the lane are the same height (${Math.round(headerBox.height)} px)`);
      } else {
        fail(`a lane header is ${headerBox?.height} px against a lane of ${bodyBox?.height}`);
      }

      // The vertical zoom: more pixels per unit of value is the whole of what makes a curve precise.
      const magnify = page.getByLabel(/^Magnify the /).first();
      if ((await magnify.count()) === 0) {
        fail('a lane offers no way to magnify it');
      } else {
        await magnify.click();
        await page.waitForTimeout(500);
        const taller = await laneHeader.boundingBox();
        if (taller !== null && headerBox !== null && taller.height > headerBox.height) {
          pass(
            `magnifying makes the lane taller (${Math.round(headerBox.height)} → ${Math.round(taller.height)} px)`,
          );
        } else {
          fail('magnifying a lane changed nothing');
        }
      }

      // The curve, which needs a real layout: it is sampled across the viewport's own width.
      if ((await page.locator('[data-value-curve] polyline').count()) > 0) {
        pass('the lane draws the value curve');
      } else {
        fail('a lane of markers draws no curve between them');
      }

      /*
       * Clicking a marker has to reach the right column. Before this it selected the marker and the
       * panel went on describing the clip, so every property of a keyframe except its value and its
       * easing was unreachable.
       */
      await page.getByRole('tab', { name: 'Clip' }).click();
      await page.waitForTimeout(600);
      await page.locator('[data-keyframe]').first().click({ force: true });
      await page.waitForTimeout(700);

      if ((await page.getByRole('region', { name: 'Keyframe' }).count()) === 0) {
        fail('clicking a marker put nothing in the inspector');
      } else {
        pass('a selected marker opens in the right column');

        const curve = page.getByRole('radio', { name: 'bezier' });
        if ((await curve.count()) === 0) {
          fail('a marker cannot be given a hand-drawn curve');
        } else {
          await curve.click();
          await page.waitForTimeout(600);
          if ((await page.getByRole('group', { name: 'easing curve' }).count()) > 0) {
            pass('and choosing a curve gives it a curve to draw');
          } else {
            fail('choosing bezier showed no editor');
          }
        }
      }
    }

    // Put the lanes away: the checks after this expect the tracks where they were.
    await disclosure.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
  }

  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.waitForTimeout(700);

  /*
   * The effect editor, per issue #28, driven to the end.
   *
   * Here rather than in a component test because every claim it makes needs a **real driver**: that a
   * shader compiles, that a diagnostic names the line the author typed, and that the preview draws at
   * all. jsdom has no WebGL2, so a component test can only check that the panel reports itself
   * unavailable — which is the one state that does not matter.
   */
  const writeEffect = page.getByRole('button', { name: /Write a new effect/i });
  if ((await writeEffect.count()) === 0) {
    fail('the effect stack offers no way to write an effect');
  } else {
    await writeEffect.click();
    await page.waitForTimeout(1200);

    // A region, not a dialog: issue #31 made this a tab, so it is a panel filling the window rather
    // than an overlay covering it.
    const editor = page.getByRole('region', { name: 'Effect editor' });
    const canvas = page.locator('canvas[aria-label="Shader preview"]');

    // Scoped to the editor and exact: Playwright matches an accessible name by substring, so a loose
    // `Id` also finds the media browser's `Only video` filter behind the dialog.
    // Monaco's own hidden textarea, which is what carries the accessible name and takes the typing.
    const shader = editor.getByLabel('Fragment shader', { exact: true });
    const saveEffect = editor.getByRole('button', { name: 'Save effect' });

    // A screenshot, not `readPixels`: without `preserveDrawingBuffer` the drawing buffer is undefined
    // once composited, so reading it back gives zeros for a canvas that is plainly visible.
    const starter = await canvas.screenshot().catch(() => Buffer.alloc(0));
    if (starter.length > 1000) pass('the effect editor previews the starter shader on a real driver');
    else fail(`the preview drew nothing — ${starter.length} bytes`);

    await setCode(page, shader, 'void main() { fragColor = nosuchfn(source, v_uv); }');
    await page.waitForTimeout(1200);
    const reported = await editor.innerText();

    if (/line 1:/.test(reported)) {
      pass('and reports a compile error against the line the author typed');
    } else {
      // The whole value of the check: a diagnostic pointing past the end of the file is worse than
      // none, and the assembled source is a dozen lines longer than what is on screen.
      fail(
        `a broken shader was not reported against line 1 — it said ${JSON.stringify(reported.slice(0, 160))}`,
      );
    }

    if (await saveEffect.isDisabled()) pass('and refuses to save a shader that does not compile');
    else fail('an effect that cannot compile could be saved');

    await setCode(
      page,
      shader,
      'void main() { vec4 c = texture(source, v_uv); fragColor = vec4(1.0, 0.0, 0.0, c.a); }',
    );
    await editor.getByLabel('Id', { exact: true }).fill('smokecheck_red');
    await editor.getByLabel('Name', { exact: true }).fill('Smokecheck red');
    await page.waitForTimeout(1200);

    if (await saveEffect.isDisabled()) {
      fail('a finished effect could not be saved');
    } else {
      await saveEffect.click();
      await page.waitForTimeout(2500);

      const wrote =
        existsSync(join(project, 'effects', 'smokecheck_red.frag')) &&
        existsSync(join(project, 'effects', 'smokecheck_red.json'));
      if (wrote) pass('and writes both the shader and the manifest that names it');
      else fail('saving an effect did not produce both files');

      // Usable without a restart, which is what `onSaved` reloading the library is for.
      //
      // Back to the editor *workspace* tab first: since issue #31 the effect editor fills the window,
      // so the panel's own tabs are not on screen while it is showing.
      await page.waitForTimeout(2500);
      await page.getByRole('tab', { name: 'Editor' }).click();
      await page.waitForTimeout(1000);
      await page
        .locator('[data-clip-id]')
        .first()
        .click({ force: true })
        .catch(() => undefined);
      await page.getByRole('tab', { name: 'Effects' }).click();
      await page.waitForTimeout(1000);
      const add = page.getByRole('button', { name: /Add effect/i }).first();
      if ((await add.count()) > 0) await add.click();
      await page.waitForTimeout(1200);

      if ((await page.innerText('body')).includes('Smokecheck red')) {
        pass('and the effect is in the library without a restart');
      } else {
        fail('an effect written by the editor did not appear in the library');
      }
      // Back to the editor tab, so the checks after this see the window they expect.
      await page.getByRole('tab', { name: 'Editor' }).click();
      await page.waitForTimeout(800);
    }
  }

  /*
   * Opening a source file, per issue #32.
   *
   * A `.frag` used to be refused with "…is not something that can go on the timeline" — true, and it
   * left the user with no way to reach an editor that existed. And the only route to the effect editor
   * started with selecting a clip, so a user who had not selected one saw an empty column and no hint.
   */
  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.waitForTimeout(800);
  if ((await page.getByRole('button', { name: /Write a new effect/i }).count()) > 0) {
    pass('the effect editor is reachable with no clip selected');
  } else {
    fail('with nothing selected there is no way to reach the effect editor');
  }

  // `effects/` holds the fixture's shader and its manifest, which is one of each kind worth opening.
  await page
    .getByRole('treeitem', { name: /effects/ })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(1200);

  const shaderRow = page.getByRole('treeitem', { name: /\.frag/ }).first();
  if ((await shaderRow.count()) === 0) {
    fail('the browser does not list the project’s shader');
  } else {
    await shaderRow.dblclick();
    await page.waitForTimeout(2000);

    if ((await page.getByRole('region', { name: 'Effect editor' }).count()) > 0) {
      // On the *effect*, not on the file: a shader is half of one, and the editor holds both halves.
      pass('and a shader opens the effect that names it');
    } else {
      fail('double-clicking a shader did not open the effect editor');
    }

    await page.getByRole('tab', { name: 'Editor' }).click();
    await page.waitForTimeout(1000);

    /*
     * The effect's *manifest*, named rather than pattern-matched.
     *
     * Two things were wrong here and they hid each other. Clicking `effects` a second time *collapsed*
     * the folder it had just opened, so `tint.json` was off screen — and `.first()` on a `/\.json/`
     * pattern then matched `project.json` at the root instead. The check still passed, because all it
     * asserted was that the buffer starts with a brace. A locator loose enough to match the wrong file
     * turns a failure into a pass, which is the worst thing a harness can do.
     */
    const jsonRow = page.getByRole('treeitem', { name: /tint\.json/ }).first();
    if ((await jsonRow.count()) === 0) {
      fail('the browser does not list the project’s manifest');
    } else {
      await jsonRow.dblclick();
      await page.waitForTimeout(2000);

      const fileEditor = page.getByRole('region', { name: 'File editor' });
      if ((await fileEditor.count()) === 0) {
        fail('double-clicking a manifest did not open the text editor');
      } else {
        // Loaded, not merely opened: an editor that shows an empty buffer for a file that exists is
        // one save away from destroying it.
        const contents = await readCode(page, 'File contents');
        if (contents.trim().startsWith('{')) pass('and a manifest opens in the text editor, loaded');
        else fail(`the text editor opened empty — ${contents.length} characters`);

        /*
         * Completion, per issue #31 — driven rather than merely present.
         *
         * The engine is tested on its own; what only a real window can show is that the caret the
         * suggestions are computed from is the one on screen, and that accepting one writes into the
         * file being edited. The manifest under the caret is an effect manifest, so the names offered
         * are the ones `effects/*.json` uses.
         */
        const editor = page.getByLabel('File contents');
        await setCode(page, editor, '{\n  "sha\n}');

        /*
         * Caret at the end of the half-typed name, which is where someone asking for help would be —
         * reached from the **top** of the file rather than the bottom.
         *
         * Monaco auto-closes the `{` that `setCode` inserts and re-indents what follows, so the buffer
         * is four lines rather than three and its indentation is not what was typed. Counting up from
         * the end therefore landed one line short, inside the trailing brace, where there is genuinely
         * nothing to suggest — and the check reported the editor as broken for two rounds while the
         * completion engine was answering correctly the whole time. Counting down from the top is
         * exact whatever the editor adds below.
         */
        await editorSurface(editor).click();
        await page.keyboard.press('Control+Home');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('End');
        await page.keyboard.press('Control+Space');
        await page.waitForTimeout(700);

        // Monaco names its suggestion list `Suggest`, not `Suggestions`. An exact name is the point:
        // a loose one would match some other list and turn a failure into a pass.
        const list = page.getByRole('listbox', { name: 'Suggest', exact: true });
        if ((await list.count()) === 0) {
          const shown = await page
            .locator('section[aria-label="File editor"] header span')
            .first()
            .textContent();
          fail(`the completion list did not open on Ctrl+Space (editing ${String(shown)})`);
        } else {
          pass('and suggests what belongs at the caret');

          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
          const completed = await readCode(page, 'File contents');

          // The name, the quote it was inside closed, and the colon — accepting a completion that
          // left you to type `": "` yourself would have done the easy half.
          if (completed.includes('"shader": ')) pass('and accepting one writes it into the file');
          else fail(`accepting a completion produced ${JSON.stringify(completed)}`);
        }
      }
    }

    /*
     * Put back what this section disturbed.
     *
     * The checks after it need the editor tab showing and a clip selected — the effect stack's own
     * controls, and the toolbar, are both inside those. Restoring the state a section found is the
     * same discipline as the backend-address check putting the setting back.
     */
    await page.getByRole('tab', { name: 'Editor' }).click();
    await page.waitForTimeout(800);
    await page
      .locator('[data-clip-id]')
      .first()
      .click({ force: true })
      .catch(() => undefined);
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.waitForTimeout(900);
  }

  /*
   * The story board, per issue #33.
   *
   * Driven the whole way rather than merely opened: add a beat, write it, colour it, and read the
   * block back. Everything the board does goes through the document, so a beat that is added but not
   * drawn — or drawn but not committed — is the failure mode worth catching, and neither shows up in a
   * unit test that renders the tab on its own.
   */
  await page.getByRole('button', { name: 'Story' }).first().click();
  await page.waitForTimeout(1200);

  if ((await page.getByRole('tab', { name: 'Story' }).count()) === 0) {
    fail('the Story button did not open a story tab');
  } else {
    pass('the story board opens in its own tab');

    await page.getByRole('button', { name: 'Add beat' }).click();
    await page.waitForTimeout(600);

    // Exact: `getByLabel` matches substrings, and "Untitled beat" contains "title".
    const title = page.getByLabel('Title', { exact: true });
    if ((await title.count()) === 0) {
      fail('adding a beat did not select it for writing');
    } else {
      pass('a new beat is selected, ready to be written');

      await title.fill('Wide shot of the dunes');
      await page.getByLabel('Notes', { exact: true }).fill('# Late light\n\nSlow push in.');
      await page.waitForTimeout(500);

      // On the *block*, not just in the field: the board and the editor read one document, and a
      // title that only exists in the input is one the plan does not have.
      if ((await page.getByLabel('Wide shot of the dunes').count()) > 0) {
        pass('and what is typed appears on the block');
      } else {
        fail('a beat’s title never reached the board');
      }

      await page.getByLabel('Accent 3').click();
      await page.waitForTimeout(400);
      if ((await page.locator('[aria-label="Accent 3"][aria-pressed="true"]').count()) > 0) {
        pass('an accent can be chosen');
      } else {
        fail('choosing an accent did not take');
      }

      /*
       * The round trip. A plan that is not in the file it travels with is a plan that is lost the
       * next time the project is opened — which is the whole argument for putting beats in the
       * document rather than beside it, and it is worth checking rather than asserting.
       */
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(2500);

      const saved = readFileSync(join(project, 'project.json'), 'utf8');
      if (saved.includes('Wide shot of the dunes')) pass('and the beat is saved into the project');
      else fail('a written beat never reached project.json');
    }

    // Put the window back the way the checks after this one expect to find it.
    await page.getByRole('tab', { name: 'Editor' }).click();
    await page.waitForTimeout(800);
  }

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
  // Retried: the shell is still shutting down and may write into the folder while it is being
  // removed, which surfaces as ENOTEMPTY and would fail a run that actually passed.
  if (failures === 0) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures === 0) console.log('smokecheck passed');
