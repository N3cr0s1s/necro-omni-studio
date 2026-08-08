// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRMATION_HOLD_MS, useConfirmation } from './use-confirmation.js';

/**
 * A confirmation's lifetime.
 *
 * Worth testing because the bug it fixes was invisible until the application had been used for a
 * while: a "kept — …" message from ten minutes ago still sitting in the status bar, under an error
 * icon, with nothing to remove it.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a confirmation', () => {
  it('is nothing until something is said', () => {
    const { result } = renderHook(() => useConfirmation());
    expect(result.current.message).toBeUndefined();
  });

  it('shows what was said', () => {
    const { result } = renderHook(() => useConfirmation());
    act(() => result.current.say('kept — it went to a new track'));
    expect(result.current.message).toBe('kept — it went to a new track');
  });

  it('goes away on its own', () => {
    const { result } = renderHook(() => useConfirmation());
    act(() => result.current.say('kept'));
    act(() => void vi.advanceTimersByTime(CONFIRMATION_HOLD_MS + 1));
    expect(result.current.message).toBeUndefined();
  });

  it('is still there a moment before that', () => {
    // A confirmation that vanished as the user looked down would be worse than none at all.
    const { result } = renderHook(() => useConfirmation());
    act(() => result.current.say('kept'));
    act(() => void vi.advanceTimersByTime(CONFIRMATION_HOLD_MS - 100));
    expect(result.current.message).toBe('kept');
  });

  it('restarts the clock when the same thing is said again', () => {
    // Keeping two variants in a row says the same sentence twice, and the second one is the one the
    // user is waiting on. Inheriting the first one's remaining time would blink it away instantly.
    const { result } = renderHook(() => useConfirmation());
    act(() => result.current.say('kept'));
    act(() => void vi.advanceTimersByTime(CONFIRMATION_HOLD_MS - 100));
    act(() => result.current.say('kept'));
    act(() => void vi.advanceTimersByTime(200));

    expect(result.current.message).toBe('kept');
  });

  it('can be dismissed before its time', () => {
    const { result } = renderHook(() => useConfirmation());
    act(() => result.current.say('kept'));
    act(() => result.current.clear());
    expect(result.current.message).toBeUndefined();
  });

  it('drops its timer when the component goes away', () => {
    // A timer firing into an unmounted component is a React warning at best and a leak at worst.
    const { result, unmount } = renderHook(() => useConfirmation());
    act(() => result.current.say('kept'));
    unmount();
    expect(() => vi.advanceTimersByTime(CONFIRMATION_HOLD_MS + 1)).not.toThrow();
  });
});
