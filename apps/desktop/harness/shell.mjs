import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { track } from './children.mjs';

/**
 * Starting the real shell and connecting to it.
 *
 * Every harness needs this and each had written it out: spawn Electron detached on a free debugging
 * port, then retry the CDP connection until the window is up. The retry loop is the part worth having
 * once — a fixed wait is either slower than it needs to be on a warm machine or too short on a cold
 * one, and "too short" presents as *the application failed to start*.
 *
 * Extracted when the README capture became the fourth caller. Three copies had already drifted in the
 * small ways copies do — different attempt counts, different intervals — which is the same shape as
 * every other duplication this project has had to unpick.
 */

/**
 * A port nothing else holds.
 *
 * Asked of the operating system rather than picked from a range. A hard-coded one collides with a
 * previous run that has not finished dying, and the failure looks like the shell refusing to start.
 */
export async function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Launches a shell against the given `userData` and returns it connected.
 *
 * Hidden unless someone asks to watch: the harnesses drive a real shell over the debugging port and
 * never need a mapped window, and three per run several times an hour is a window stealing focus from
 * whoever is using the machine. `NOS_WATCH=1` shows them — which the README capture sets, because a
 * screenshot of a window nobody mapped is a screenshot of nothing.
 */
export async function launchShell({ desktop, dataDir, visible = false }) {
  const port = await freePort();
  const child = track(
    spawn(
      'npx',
      ['electron', '.', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${dataDir}`],
      {
        cwd: desktop,
        stdio: 'ignore',
        detached: true,
        env: {
          ...process.env,
          NOS_HEADLESS: visible || process.env.NOS_WATCH === '1' ? '0' : '1',
        },
      },
    ),
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
export function stopShell(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
