import { describe, expect, it } from 'vitest';
import { isHarnessShell } from './children.mjs';

/**
 * Which processes the harness will kill on its way in.
 *
 * The only piece of this repository that terminates processes it did not start, so it is the one place
 * where being approximately right is not good enough. The first version matched on the profile flag
 * alone — and the shell command that *launches* a harness carries that flag in its own command line,
 * so it would have killed the terminal that started it, along with anything scripting or grepping a
 * run.
 */
describe('recognising a harness shell', () => {
  const PROFILE = '--user-data-dir=/tmp/nos-smokecheck-YbE22f/user-data';

  it('accepts the Electron binary', () => {
    expect(
      isHarnessShell(`/home/u/p/node_modules/electron/dist/electron --remote-debugging-port=1 ${PROFILE} .`),
    ).toBe(true);
  });

  it('accepts the npx wrapper that starts it', () => {
    // What is actually spawned. Its exit says nothing about the window, which is why it is tracked.
    expect(isHarnessShell(`node /home/u/p/node_modules/.bin/electron . ${PROFILE}`)).toBe(true);
  });

  it('refuses a shell that merely mentions the profile', () => {
    // The near-miss that would have been destructive: this is the shape of the command that starts a
    // run, of a `grep` over its output, and of anything a person types about it.
    expect(isHarnessShell(`/bin/bash -c 'node smokecheck/run.mjs ${PROFILE} | grep passed'`)).toBe(false);
  });

  it('refuses another Electron application', () => {
    // Someone else's editor is not ours to close, whatever it is running.
    expect(isHarnessShell('/opt/other/electron --user-data-dir=/home/u/.config/other')).toBe(false);
  });

  it('refuses a node process that is not the wrapper', () => {
    expect(isHarnessShell(`node /home/u/p/scripts/watch.mjs ${PROFILE}`)).toBe(false);
  });

  it('refuses an empty line', () => {
    expect(isHarnessShell('')).toBe(false);
  });
});
