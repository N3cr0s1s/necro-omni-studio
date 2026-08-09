import { type RefObject, useEffect, useRef, useState } from 'react';

/**
 * The measured width of an element.
 *
 * Every frame-to-pixel conversion in this application is driven by how wide the lane actually is, so
 * it is measured rather than assumed: a hard-coded width misplaces the playhead on any window that is
 * not exactly that size, and the error is invisible until someone drags the splitter.
 *
 * `inset` is subtracted for chrome inside the observed element that the lanes do not occupy — a track
 * header column, say. `minimum` keeps the viewport usable while a panel is collapsed to nothing, which
 * would otherwise produce a zero width and a division by it.
 */
export function useElementWidth(options: { readonly inset?: number; readonly minimum?: number } = {}): {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly width: number;
} {
  const inset = options.inset ?? 0;
  const minimum = options.minimum ?? 200;
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(minimum);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Absent under jsdom, where nothing lays out anyway — the minimum is the honest answer there.
    if (globalThis.ResizeObserver === undefined) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(minimum, entry.contentRect.width - inset));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [inset, minimum]);

  return { ref, width };
}
