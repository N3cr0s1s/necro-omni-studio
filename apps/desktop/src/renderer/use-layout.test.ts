// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readLayout } from './use-layout.js';

/**
 * Reading a stored panel layout.
 *
 * Every assertion here is about *refusing* one, because that is where the damage is. The library takes
 * the layout as authoritative: a share that is `NaN` because something wrote a string, or an entry
 * naming a panel that no longer exists, makes the group throw or collapse every panel to nothing — and
 * the user's editor opens empty with no way to tell why. Opening at the defaults is always the better
 * failure.
 */

const KEY = 'nos.test.layout';

afterEach(() => localStorage.clear());

describe('a layout worth restoring', () => {
  it('is read back as it was written', () => {
    localStorage.setItem(KEY, JSON.stringify({ browser: 18, stage: 60, inspector: 22 }));
    expect(readLayout(KEY)).toEqual({ browser: 18, stage: 60, inspector: 22 });
  });

  it('keeps a collapsed panel collapsed', () => {
    // Zero is a real share, not a missing one: a browser closed on purpose must not reopen on launch.
    localStorage.setItem(KEY, JSON.stringify({ browser: 0, stage: 78, inspector: 22 }));
    expect(readLayout(KEY)).toEqual({ browser: 0, stage: 78, inspector: 22 });
  });
});

describe('a layout that is not', () => {
  it('is nothing on a first run', () => {
    expect(readLayout(KEY)).toBeUndefined();
  });

  it('is nothing for text that is not JSON', () => {
    localStorage.setItem(KEY, 'not json at all');
    expect(readLayout(KEY)).toBeUndefined();
  });

  it('is nothing for a share that is not a number', () => {
    // The case that collapses the editor: the group divides by it and every panel goes to zero.
    localStorage.setItem(KEY, JSON.stringify({ browser: '18', stage: 60 }));
    expect(readLayout(KEY)).toBeUndefined();
  });

  it('is nothing for a share that is not finite', () => {
    localStorage.setItem(KEY, '{"browser":null,"stage":60}');
    expect(readLayout(KEY)).toBeUndefined();
  });

  it('is nothing for a negative share, which no panel can have', () => {
    localStorage.setItem(KEY, JSON.stringify({ browser: -20, stage: 120 }));
    expect(readLayout(KEY)).toBeUndefined();
  });

  it('is nothing for the wrong shape entirely', () => {
    for (const stored of ['[]', '"a string"', '42', 'null', '{}']) {
      localStorage.setItem(KEY, stored);
      expect(readLayout(KEY), stored).toBeUndefined();
    }
  });

  it('is discarded whole rather than partly, so one bad entry cannot survive', () => {
    // Repairing it would restore a layout the user never chose, which is harder to explain than one
    // that reset.
    localStorage.setItem(KEY, JSON.stringify({ browser: 18, stage: 'wide', inspector: 22 }));
    expect(readLayout(KEY)).toBeUndefined();
  });
});
