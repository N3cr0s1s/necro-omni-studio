import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, VARIANT_MAXIMUM_RANGE, mergeSettings, parseSettings } from './app-settings.js';

/**
 * Settings that belong to the installation rather than to a project.
 *
 * §5.8 asks for a global override of the variant count, and the job queue has taken a ceiling since it
 * was written — nothing ever set it, because there was nowhere for an application-level setting to
 * live. A cap on how much work a machine takes on follows the machine, not the cut.
 */

describe('reading what was on disk', () => {
  it('is the defaults for a file that is not there', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('is the defaults for something that is not an object', () => {
    expect(parseSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(7)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps a stored value', () => {
    expect(parseSettings({ variantMaximum: 4 }).variantMaximum).toBe(4);
  });

  it('falls back per field, so one bad entry does not cost the rest', () => {
    // A settings file is edited by hand sooner or later. It is also what makes adding a setting safe:
    // a file written by an older build simply has defaults for what it does not mention.
    expect(parseSettings({ variantMaximum: 'lots' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps a number outside the range rather than discarding it', () => {
    // Someone who typed forty meant "as many as you can", and the ceiling is closer to that than the
    // default is.
    expect(parseSettings({ variantMaximum: 40 }).variantMaximum).toBe(VARIANT_MAXIMUM_RANGE.max);
    expect(parseSettings({ variantMaximum: 0 }).variantMaximum).toBe(VARIANT_MAXIMUM_RANGE.min);
  });

  it('rounds a fraction, since a count of variants is whole', () => {
    expect(parseSettings({ variantMaximum: 3.6 }).variantMaximum).toBe(4);
  });

  it('ignores a non-finite number, which says nothing about intent', () => {
    expect(parseSettings({ variantMaximum: Number.NaN })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ variantMaximum: Number.POSITIVE_INFINITY })).toEqual(DEFAULT_SETTINGS);
  });
});

describe('applying a change', () => {
  const current = { variantMaximum: 5, backendUrl: 'http://127.0.0.1:9000', theme: 'zinc' };

  it('changes what was named', () => {
    expect(mergeSettings(current, { variantMaximum: 2 }).variantMaximum).toBe(2);
  });

  it('leaves what was not named', () => {
    // The change-object rule this codebase follows everywhere: absent means leave it.
    expect(mergeSettings(current, {}).variantMaximum).toBe(5);
  });

  it('validates a change exactly as a file is validated', () => {
    // Not because a renderer is hostile, but because a control with a typo in its `max` would write a
    // cap nothing could later undo through that same control.
    expect(mergeSettings(current, { variantMaximum: 99 }).variantMaximum).toBe(VARIANT_MAXIMUM_RANGE.max);
    expect(mergeSettings(current, { variantMaximum: 'lots' }).variantMaximum).toBe(5);
  });

  it('ignores a patch that is not an object at all', () => {
    expect(mergeSettings(current, undefined)).toEqual(current);
  });
});

describe('where the backend is', () => {
  it('is empty by default, which means wherever the default is', () => {
    // Not the address itself: storing a copy would freeze today's default into every settings file
    // ever written.
    expect(DEFAULT_SETTINGS.backendUrl).toBe('');
  });

  it('keeps an http or https address', () => {
    expect(parseSettings({ backendUrl: 'http://10.0.0.4:8188' }).backendUrl).toBe('http://10.0.0.4:8188');
    expect(parseSettings({ backendUrl: 'https://comfy.example' }).backendUrl).toBe('https://comfy.example');
  });

  it('drops a trailing slash, so one path is not joined twice', () => {
    expect(parseSettings({ backendUrl: 'http://10.0.0.4:8188/' }).backendUrl).toBe('http://10.0.0.4:8188');
  });

  it('refuses a scheme that is not http, which the renderer would hand to fetch', () => {
    // A settings file is exactly the kind of thing that gets pasted into.
    expect(parseSettings({ backendUrl: 'file:///etc/passwd' }).backendUrl).toBe('');
    expect(parseSettings({ backendUrl: 'javascript:alert(1)' }).backendUrl).toBe('');
  });

  it('refuses something that is not an address at all', () => {
    expect(parseSettings({ backendUrl: 'not a url' }).backendUrl).toBe('');
    expect(parseSettings({ backendUrl: 42 }).backendUrl).toBe('');
  });

  it('lets the field be cleared, which is how it says "use the default"', () => {
    expect(
      mergeSettings({ variantMaximum: 3, backendUrl: 'http://x.test', theme: '' }, { backendUrl: '' })
        .backendUrl,
    ).toBe('');
  });

  it('keeps the current address when a change is refused', () => {
    const kept = mergeSettings(
      { variantMaximum: 3, backendUrl: 'http://x.test', theme: '' },
      { backendUrl: 'file:///x' },
    );
    expect(kept.backendUrl).toBe('http://x.test');
  });
});

describe('which palette the editor draws in', () => {
  const current = { variantMaximum: 5, backendUrl: '', theme: 'zinc' };

  it('is empty by default, meaning whatever the application ships in', () => {
    // Not the default id itself: that is named once, in `@nos/ui`, and a copy here would be a second
    // answer to a question that has one.
    expect(parseSettings({}).theme).toBe('');
  });

  it('keeps an id it has never heard of', () => {
    // The list of themes lives in a package the main process may not import values from, so an
    // unknown id is not something this side can recognise — and a settings file written by a later
    // build is the ordinary way one arrives. The renderer falls back when it resolves it.
    expect(parseSettings({ theme: 'a-theme-from-next-year' }).theme).toBe('a-theme-from-next-year');
  });

  it('refuses anything that is not shaped like an attribute value', () => {
    // The guard that matters: this string is interpolated into an HTML attribute and matched by a CSS
    // attribute selector, and a settings file is exactly the kind of thing that gets pasted into.
    for (const value of ['" onload="x', 'Zinc Two', 'a'.repeat(40), 42, null]) {
      expect(mergeSettings(current, { theme: value }).theme).toBe('zinc');
    }
  });

  it('takes an empty string as a deliberate return to the default', () => {
    expect(mergeSettings(current, { theme: '' }).theme).toBe('');
  });

  it('leaves the palette alone when a change does not mention it', () => {
    expect(mergeSettings(current, { variantMaximum: 3 }).theme).toBe('zinc');
  });
});
