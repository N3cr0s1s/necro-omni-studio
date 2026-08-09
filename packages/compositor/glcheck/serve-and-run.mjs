/**
 * Starts the harness's dev server, runs the GL check against it, and stops the server.
 *
 * The two steps were a documented dance — start Vite in one shell, run the check in another — and the
 * dance has a trap in it: start the server from the wrong directory and the check still runs, still
 * reaches *a* page, and reports **24 of 27 failing**. That reads as a compositor in ruins rather than
 * as a harness pointed at the wrong application, and it cost a round of alarm.
 *
 * So the pairing is code rather than instructions. The server is started here, from this package,
 * with no chance of it being anything else, and it is stopped whatever the check does.
 *
 * Usage, from the repository root:
 *   npm run check:gl
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compositor = join(here, '..');

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

const port = await freePort();
const server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
  cwd: compositor,
  stdio: 'ignore',
  detached: true,
});

function stopServer() {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

// Waited for rather than slept on: a fixed sleep is either too short on a cold start or wasted on a
// warm one, and too short is what produces the failure this file exists to prevent.
let ready = false;
for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  ready = await fetch(`http://127.0.0.1:${port}/`)
    .then((response) => response.ok)
    .catch(() => false);
}

if (!ready) {
  stopServer();
  console.error('✗ the GL harness server never came up');
  process.exit(1);
}

const run = spawnSync('node', [join(here, 'run.mjs')], {
  cwd: compositor,
  stdio: 'inherit',
  env: { ...process.env, NOS_GLCHECK_URL: `http://127.0.0.1:${port}/glcheck/` },
});

stopServer();
process.exit(run.status ?? 1);
