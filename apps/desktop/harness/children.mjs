/**
 * Every shell a harness starts, and the guarantee that none of them outlives it.
 *
 * Each check spawns Electron detached, in its own process group, so it can be stopped as a group —
 * Electron forks renderers and a sidecar, and killing only the parent leaves them holding the port.
 * That much already worked **when the harness reached its own cleanup**.
 *
 * It does not always reach it. A `finally` does not run when the process is killed from outside, when
 * a `browser.close()` hangs on a window that has stopped answering, or when the run is cut short. Each
 * of those leaves a real application window on the user's screen, and they accumulate silently because
 * the next run starts a fresh one and reports green. Enough runs and somebody is closing them by hand.
 *
 * So cleanup is attached to the *process*, not to a block. `exit` covers a normal end and an
 * `process.exit()` from an assertion; the signals cover a kill from a terminal or a supervisor; and
 * `uncaughtException` covers a harness that throws somewhere with no handler — which is exactly the
 * case where a `finally` in `run.mjs` never happens.
 *
 * `SIGKILL` rather than `SIGTERM` on the way out. A polite signal is right while the run is in
 * progress and the window may still have something to write; by the time this fires the run is over,
 * and a shell that ignores the request is precisely the one that would be left behind.
 */

import { execFileSync } from 'node:child_process';

const children = new Set();
let armed = false;

/** Where every harness puts its shell's profile. Necessary for a match, and not sufficient. */
const HARNESS_PROFILE = /--user-data-dir=\/tmp\/nos-\w+check-/;

/**
 * Whether a `ps` line is one of our shells, rather than something that merely mentions one.
 *
 * The profile flag alone is **not** enough, and finding that out was worth the detour: the very shell
 * command that starts a harness has the flag in its own command line, so a check on the flag alone
 * would have this killing the terminal that launched it. Anything scripted, logged or grepped about a
 * run matches too.
 *
 * So the process has to *be* Electron: either the binary itself, or the `npx` wrapper that starts it.
 * A `/bin/bash -c '… --user-data-dir=/tmp/nos-smokecheck-… …'` is neither.
 */
export function isHarnessShell(args) {
  if (!HARNESS_PROFILE.test(args)) return false;

  const executable = args.split(/\s+/)[0] ?? '';
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  if (name === 'electron') return true;
  // The wrapper: `node …/node_modules/.bin/electron .`
  return name === 'node' && /\/\.bin\/electron\b/.test(args);
}

/**
 * Kills shells left by a previous run.
 *
 * The one case in-process cleanup cannot cover is `SIGKILL` on the harness itself: no handler runs,
 * and the window stays. Nothing can fix that from inside the process that was killed — so the next run
 * clears up after the last one, which turns an unbounded pile into at most one stale window.
 *
 * **Only old ones.** A live run is minutes; anything still up after half an hour belongs to a run that
 * is not coming back. The age test is what makes this safe to do unconditionally — without it, a
 * harness started while another was running would kill the other one's shell and report its failure as
 * the application's.
 *
 * Best-effort by design. `ps` missing, or a pid that has already gone, is not a reason to refuse to
 * run the checks.
 */
export function reapStale(maxAgeSeconds = 1800) {
  let listing = '';
  try {
    listing = execFileSync('ps', ['-eo', 'pid=,etimes=,args='], { encoding: 'utf8' });
  } catch {
    return 0;
  }

  let reaped = 0;
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;

    const [, pid, age, command] = match;
    if (!isHarnessShell(command)) continue;
    if (Number(age) < maxAgeSeconds) continue;

    try {
      process.kill(-Number(pid), 'SIGKILL');
    } catch {
      // Not a group leader, or gone already.
    }
    try {
      process.kill(Number(pid), 'SIGKILL');
      reaped += 1;
    } catch {
      // Gone between listing and killing, which is fine.
    }
  }
  return reaped;
}

/**
 * Registers a spawned child so it is stopped whatever happens to this process.
 *
 * Deliberately **not** dropped when the child reports `exit`. What is spawned is `npx electron`, a
 * node wrapper that starts the real shell and then leaves — so the wrapper's exit says nothing about
 * whether an application window is still on screen. Untracking there is what let three of twelve
 * survive a signal: the group was no longer being watched by the time anything tried to kill it.
 *
 * Keeping the pid costs nothing. `process.kill` on a group that has already gone raises `ESRCH`, which
 * is the outcome this wants anyway and is swallowed below.
 */
export function track(child) {
  children.add(child);
  return child;
}

/** Stops everything still tracked. Synchronous, because an `exit` handler may not await. */
export function stopAll() {
  for (const child of children) {
    // The group first — Electron's renderers are its children, not this process's.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone, or never a group leader. Fall through to the direct kill.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing left to kill, which is the outcome this wants anyway.
    }
  }
  children.clear();
}

/**
 * Attaches the cleanup to this process. Safe to call more than once.
 *
 * Call it before the first `launch`, not after: a crash between the two is the window that gets left
 * behind, and that is the whole failure this exists to stop.
 */
export function armCleanup() {
  if (armed) return;
  armed = true;

  const stale = reapStale();
  if (stale > 0) console.log(`✓ cleared ${stale} shell${stale === 1 ? '' : 's'} left by an earlier run`);

  process.on('exit', stopAll);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      stopAll();
      // Re-raising rather than exiting quietly, so a caller waiting on this run still sees it was
      // signalled rather than that it finished.
      process.exit(1);
    });
  }

  process.on('uncaughtException', (error) => {
    stopAll();
    console.error(error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    stopAll();
    console.error(reason);
    process.exit(1);
  });
}
