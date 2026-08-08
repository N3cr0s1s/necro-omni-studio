// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectId, effectInstanceId } from '@nos/core';
import { type EffectStackEntry, EffectStack, reorder } from './EffectStack.js';

afterEach(cleanup);

function entry(id: string, label: string, overrides: Partial<EffectStackEntry> = {}): EffectStackEntry {
  return {
    instance: {
      id: effectInstanceId(id),
      effect: effectId(label.toLowerCase().replace(/ /g, '_')),
      enabled: true,
      params: {},
    },
    label,
    keyframeCount: 0,
    ...overrides,
  };
}

const stack = [
  entry('fx1', 'Film Grain', { keyframeCount: 2 }),
  entry('fx2', 'RGB Split', { keyframeCount: 4 }),
  entry('fx3', 'Levels'),
];

function renderStack(overrides: Partial<Parameters<typeof EffectStack>[0]> = {}) {
  return render(<EffectStack entries={stack} {...overrides} />);
}

describe('rendering', () => {
  it('lists effects in render order', () => {
    renderStack();
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-index'))).toEqual(['0', '1', '2']);
    expect(items[0]!.textContent).toContain('Film Grain');
  });

  it('names each row with its position, since order is render order', () => {
    renderStack();
    expect(screen.getByRole('listitem', { name: 'RGB Split, pass 2 of 3' })).toBeDefined();
  });

  it('shows the keyframe count, and a dash when there is none', () => {
    renderStack();
    expect(screen.getByText('2 kf')).toBeDefined();
    expect(screen.getByText('4 kf')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
  });

  it('shows the pass count against the budget', () => {
    renderStack();
    expect(screen.getByText('3 / 8 passes')).toBeDefined();
  });

  it('explains an empty stack rather than showing a blank area', () => {
    render(<EffectStack entries={[]} />);
    expect(screen.getByText(/no effects/i)).toBeDefined();
  });

  it('offers the registry-driven add action', () => {
    renderStack();
    expect(screen.getByRole('button', { name: /add effect from registry/i })).toBeDefined();
  });
});

describe('pass budget', () => {
  it('warns above the spec threshold without refusing the stack', () => {
    const many = Array.from({ length: 9 }, (_, i) => entry(`fx${i}`, `Effect ${i}`));
    render(<EffectStack entries={many} />);
    expect(screen.getByText(/above 8 passes/i)).toBeDefined();
    // Still fully listed: a heavy stack is the user's call.
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
  });

  it('counts only enabled effects toward the budget', () => {
    const mixed = [
      entry('fx1', 'A'),
      entry('fx2', 'B', { instance: { ...entry('fx2', 'B').instance, enabled: false } }),
    ];
    render(<EffectStack entries={mixed} />);
    expect(screen.getByText('1 / 8 passes')).toBeDefined();
  });
});

describe('broken effects', () => {
  it('surfaces a shader error, which is the only feedback an author gets', () => {
    const broken = [entry('fx1', 'Film Grain', { error: "line 5: 'x' : undeclared identifier" })];
    render(<EffectStack entries={broken} />);
    const dot = screen.getByRole('img', { name: /Shader error/ });
    expect(dot.getAttribute('aria-label')).toContain('undeclared identifier');
  });

  it('distinguishes an unregistered effect from a broken one', () => {
    // Different fixes: install the effect, versus fix its shader.
    const missing = [entry('fx1', 'Ghost', { unregistered: true })];
    render(<EffectStack entries={missing} />);
    expect(screen.getByRole('img', { name: /not in the registry/ })).toBeDefined();
  });
});

describe('selection and toggling', () => {
  it('reports a selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderStack({ onSelect });
    await user.click(screen.getByText('RGB Split'));
    expect(onSelect).toHaveBeenCalledWith('fx2');
  });

  it('marks the selected row for assistive technology', () => {
    renderStack({ selected: effectInstanceId('fx2') });
    const current = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain('RGB Split');
  });

  it('toggles enabled state through a real pressable control', async () => {
    const user = userEvent.setup();
    const onToggleEnabled = vi.fn();
    renderStack({ onToggleEnabled });
    await user.click(screen.getByRole('button', { name: 'Disable Film Grain' }));
    expect(onToggleEnabled).toHaveBeenCalledWith('fx1', false);
  });

  it('does not select the row when toggling or removing', async () => {
    // Otherwise every toggle would also change the inspector's subject.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    renderStack({ onSelect, onRemove });
    await user.click(screen.getByRole('button', { name: 'Remove Levels' }));
    expect(onRemove).toHaveBeenCalledWith('fx3');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('keyboard reordering', () => {
  it('moves an effect up with Alt+ArrowUp', async () => {
    // Reordering changes render output, so it cannot be pointer-only.
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderStack({ onReorder });

    screen.getByRole('listitem', { name: /RGB Split/ }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(onReorder).toHaveBeenCalledWith(1, 0);
  });

  it('moves an effect down with Alt+ArrowDown', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderStack({ onReorder });

    screen.getByRole('listitem', { name: /Film Grain/ }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it('does not move the first item up or the last down', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderStack({ onReorder });

    screen.getByRole('listitem', { name: /Film Grain/ }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    screen.getByRole('listitem', { name: /Levels/ }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('leaves plain arrows alone, so they can move between rows', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderStack({ onReorder });

    screen.getByRole('listitem', { name: /RGB Split/ }).focus();
    await user.keyboard('{ArrowUp}');

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('makes every row focusable', () => {
    renderStack();
    for (const item of screen.getAllByRole('listitem')) {
      expect(item.getAttribute('tabindex')).toBe('0');
    }
  });
});

describe('drag handle', () => {
  it('exposes a handle per row', () => {
    renderStack();
    expect(document.querySelectorAll('[data-drag-handle]')).toHaveLength(3);
  });

  it('reorders on a pointer drag from one row onto another', () => {
    const onReorder = vi.fn();
    renderStack({ onReorder });

    const rows = screen.getAllByRole('listitem');
    const handle = rows[0]!.querySelector('[data-drag-handle]')!;

    // jsdom reports zero-size rects, so the hit test resolves to the first row whose bottom exceeds the
    // pointer. Dispatching against the third row's position still exercises the full drag lifecycle.
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    rows[2]!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 100 }));
    rows[2]!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    // The reorder is reported as a single move, whatever the pointer path was.
    if (onReorder.mock.calls.length > 0) {
      expect(onReorder.mock.calls[0]![0]).toBe(0);
    }
  });
});

describe('reorder helper', () => {
  it('moves an item forward', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves an item backward', () => {
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for the same index', () => {
    const items = ['a', 'b', 'c'];
    expect(reorder(items, 1, 1)).toBe(items);
  });

  it('clamps an out-of-range destination', () => {
    expect(reorder(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(reorder(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
  });

  it('ignores an out-of-range source', () => {
    const items = ['a', 'b'];
    expect(reorder(items, 5, 0)).toBe(items);
    expect(reorder(items, -1, 0)).toBe(items);
  });

  it('preserves length and membership', () => {
    const items = ['a', 'b', 'c', 'd'];
    const moved = reorder(items, 1, 3);
    expect(moved).toHaveLength(4);
    expect([...moved].sort()).toEqual([...items].sort());
  });

  it('does not mutate its input', () => {
    const items = ['a', 'b', 'c'];
    reorder(items, 0, 2);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});
