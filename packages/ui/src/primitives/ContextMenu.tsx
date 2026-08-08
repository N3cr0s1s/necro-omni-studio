import { type ReactNode, useEffect, useRef } from 'react';
import { token } from '../tokens/tokens.js';

/**
 * The menu a right-click opens.
 *
 * Every action it offers already exists elsewhere — on a button, behind a shortcut — which is the
 * point: a context menu is not new capability but the *discoverable* path to what a user can already
 * do. Without one, an editor's whole vocabulary is reachable only by someone who has read the
 * shortcuts.
 *
 * Deliberately dumb. It takes a list of items and a position, and reports which was chosen; what the
 * items *are* is the caller's business, because the answer depends on what was clicked and this
 * component has no way to know that.
 */

export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  /** Shown right-aligned, so a user learns the shortcut by using the menu. */
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** Draws a rule above this item, for grouping actions of different weight. */
  readonly separated?: boolean;
  /** Destructive items are coloured, because undo is a worse answer than not doing it. */
  readonly danger?: boolean;
}

export interface ContextMenuProps {
  /** Viewport coordinates of the click that opened it. */
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onChoose: (id: string) => void;
  readonly onClose: () => void;
}

/** Roughly what one row costs, for keeping the menu on screen without measuring it first. */
const ROW_HEIGHT_PX = 26;
const MENU_WIDTH_PX = 220;

export function ContextMenu({ x, y, items, onChoose, onClose }: ContextMenuProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Any click outside closes it, and so does Escape. A menu that could only be dismissed by
    // choosing something would make a mis-click into a forced decision.
    function onPointerDown(event: PointerEvent): void {
      if (ref.current?.contains(event.target as Node) === true) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const placed = placeMenu(x, y, items.length);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Actions"
      data-context-menu="true"
      style={{
        position: 'fixed',
        left: placed.left,
        top: placed.top,
        width: MENU_WIDTH_PX,
        padding: `${token.space2} 0`,
        background: token.surface1,
        border: `1px solid ${token.border}`,
        borderRadius: token.radiusControl,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
        zIndex: 100,
      }}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separated === true && (
            <div
              aria-hidden="true"
              style={{ height: 1, background: token.borderSubtle, margin: `${token.space2} 0` }}
            />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled === true}
            onClick={() => {
              onChoose(item.id);
              onClose();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: token.space3,
              width: '100%',
              height: ROW_HEIGHT_PX,
              padding: `0 ${token.space4}`,
              background: 'transparent',
              border: 'none',
              textAlign: 'left',
              font: `400 12px ${token.fontUi}`,
              color:
                item.disabled === true
                  ? token.textGhost
                  : item.danger === true
                    ? token.danger
                    : token.textBright,
              cursor: item.disabled === true ? 'default' : 'pointer',
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.label}
            </span>
            {item.shortcut !== undefined && (
              // Shown so the menu teaches the shortcut rather than competing with it.
              <span style={{ font: token.textMeta, color: token.textFaint, flex: 'none' }}>
                {item.shortcut}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Keeps the menu inside the window.
 *
 * Flipped rather than clamped when it would overflow: a menu pinned to the bottom edge covers the
 * thing that was clicked, which is the one place a user is still looking.
 */
export function placeMenu(
  x: number,
  y: number,
  itemCount: number,
  viewport: { readonly width: number; readonly height: number } = {
    width: globalThis.innerWidth || 1920,
    height: globalThis.innerHeight || 1080,
  },
): { readonly left: number; readonly top: number } {
  const height = itemCount * ROW_HEIGHT_PX + 12;
  const left = x + MENU_WIDTH_PX > viewport.width ? Math.max(0, x - MENU_WIDTH_PX) : x;
  const top = y + height > viewport.height ? Math.max(0, y - height) : y;
  return { left, top };
}
