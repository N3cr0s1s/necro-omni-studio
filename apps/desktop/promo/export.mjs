/**
 * Exports a project by driving the application, and reports what landed (issue #40).
 *
 * The promo has to be *rendered by the program* — that is the whole question the issue asks. So this
 * opens the project in the real shell and presses Export, exactly as `exportcheck` does for its fixture,
 * and then reads the delivered file with ffprobe rather than trusting the dialog.
 *
 * Usage, from the repository root:
 *   node apps/desktop/promo/export.mjs <project-directory>
 *
 * The window is mapped, because an export renders through WebGL in a real renderer and a promo is worth
 * watching land.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFirst } from '../harness/build-first.mjs';
import { armCleanup } from '../harness/children.mjs';
import { launchShell, stopShell } from '../harness/shell.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');

const project = process.argv[2];
if (project === undefined || !existsSync(join(project, 'project.json'))) {
  console.error('usage: node apps/desktop/promo/export.mjs <project-directory>');
  process.exit(1);
}

armCleanup();
buildFirst(desktop, { pass: (m) => console.log(`✓ ${m}`), fail: (m) => console.error(`✗ ${m}`) });

const userData = join(project, '..', `${basename(project)}-user-data`);
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'session.json'), JSON.stringify({ lastProject: project }, null, 2));

let shell;
try {
  shell = await launchShell({ desktop, dataDir: userData, visible: true });
  const page = shell.browser.contexts()[0].pages().at(-1);

  await page.waitForFunction(() => document.querySelectorAll('[data-clip-id]').length > 0, undefined, {
    timeout: 90_000,
  });
  // Long enough for proxies to land. An export renders from the sources rather than the proxies, but a
  // window still deriving is a window whose first frames arrive late.
  await page.waitForTimeout(15_000);

  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.first().click();

  // `exact`, because Playwright matches an accessible name by substring and the overwrite warning's
  // "Save as <project> (2).mp4" contains `Export` too.
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Export', exact: true }).click();

  console.log('exporting…');
  await page.waitForFunction(() => document.body.textContent?.includes('complete') === true, undefined, {
    timeout: 45 * 60_000,
  });

  const renders = join(project, 'renders');
  const delivered = readdirSync(renders)
    .filter((name) => name.endsWith('.mp4'))
    .map((name) => join(renders, name));

  if (delivered.length === 0) {
    console.error('✗ the export reported complete and delivered no file');
    process.exitCode = 1;
  } else {
    for (const file of delivered) {
      // Read back rather than trusted: "complete" is the shell's word for it, and the file is the fact.
      const probe = spawnSync(
        'ffprobe',
        [
          ...['-v', 'error'],
          ...['-show_entries', 'format=duration,size'],
          ...['-show_entries', 'stream=width,height,nb_frames,codec_name'],
          ...['-of', 'default=noprint_wrappers=1'],
          file,
        ],
        { encoding: 'utf8' },
      );
      console.log(`✓ ${file}`);
      console.log(
        probe.stdout
          .trim()
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      );
    }
  }
} finally {
  await shell?.browser.close().catch(() => undefined);
  if (shell !== undefined) stopShell(shell.child);
}
