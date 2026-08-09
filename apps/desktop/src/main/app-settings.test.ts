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
  const current = { variantMaximum: 5 };

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
