/**
 * `PointerEvent` for jsdom.
 *
 * jsdom does not implement it, and Base UI constructs one to forward a click's modifier keys — so a
 * `Checkbox` under test throws `PointerEvent is not a constructor` before it ever reports the change.
 * The failure is in the environment, not in the component: the same click works in Electron.
 *
 * Deliberately the smallest thing that can be called with `new`, extending `MouseEvent` so that
 * `clientX`, `button`, `ctrlKey` and the rest keep working. The pointer-specific fields are carried
 * through with the defaults the spec gives them, because a test that reads `pointerType` should see
 * `'mouse'` rather than `undefined`.
 *
 * Registered as a Vitest setup file, and a no-op outside a DOM environment so the node-environment
 * bulk of the suite pays nothing for it.
 */
interface PointerEventInit extends MouseEventInit {
  pointerId?: number;
  width?: number;
  height?: number;
  pressure?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

if (typeof window !== 'undefined' && typeof window.PointerEvent !== 'function') {
  class PointerEventPolyfill extends window.MouseEvent {
    readonly pointerId: number;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;
    readonly tangentialPressure: number;
    readonly tiltX: number;
    readonly tiltY: number;
    readonly twist: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? 0;
      this.tangentialPressure = init.tangentialPressure ?? 0;
      this.tiltX = init.tiltX ?? 0;
      this.tiltY = init.tiltY ?? 0;
      this.twist = init.twist ?? 0;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? false;
    }

    getCoalescedEvents(): PointerEventPolyfill[] {
      return [];
    }

    getPredictedEvents(): PointerEventPolyfill[] {
      return [];
    }
  }

  Object.defineProperty(window, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}
