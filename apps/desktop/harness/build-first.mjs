import { spawnSync } from 'node:child_process';

/**
 * Builds the shell before a harness drives it.
 *
 * `electron .` loads whatever is in `dist/`, so a harness that does not build happily tests the
 * **last** build and reports a clean run against code that is not the code in the working tree. That
 * is worse than no harness: it is a green result that means nothing.
 *
 * It has now cost twice. `smokecheck` grew this guard after a missing feature passed a whole run; a
 * comment there records it. `exportcheck` and `perfcheck` kept the instruction to build first as a
 * line in their header comment — and a header comment is not a guard. The second time, a GPU readout
 * that had just been written was reported absent by a check running a binary from before it existed,
 * and the twenty minutes that followed went into the application rather than the harness.
 *
 * So it lives in one place now, which is the actual lesson: **the same fix in one harness and not its
 * neighbours is how this project's checks keep going quietly wrong.** The teardown retry did it, the
 * track lock did it, and this is the third.
 *
 * `NOS_SKIP_BUILD=1` re-runs against a build that was just made, which is worth having when a single
 * build is feeding several checks in a row.
 */
export function buildFirst(desktop, { pass, fail }) {
  if (process.env.NOS_SKIP_BUILD === '1') return;

  const built = spawnSync('npm', ['run', 'build'], { cwd: desktop, stdio: 'inherit' });
  if (built.status !== 0) {
    fail('the application does not build — nothing below this line would have meant anything');
    process.exit(1);
  }
  pass('the application builds');
}
