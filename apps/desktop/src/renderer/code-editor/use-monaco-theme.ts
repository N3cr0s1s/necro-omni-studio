import { useEffect, useState } from 'react';

/**
 * A key that changes whenever the palette does — issue #35.
 *
 * Monaco's colours are literal, and this application's are measured from whichever of the six themes
 * is in force. Something has to say "measure again", and the honest signal is the attribute the theme
 * is actually stamped on: watching that covers the picker, the light/dark toggle and a theme restored
 * at startup with one observer, rather than three call sites that each have to remember.
 */
export function useMonacoTheme(): string {
  const [key, setKey] = useState(() => themeSignature());

  useEffect(() => {
    if (typeof document === 'undefined' || globalThis.MutationObserver === undefined) return;

    const root = document.documentElement;
    const observer = new MutationObserver(() => setKey(themeSignature()));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

    return () => observer.disconnect();
  }, []);

  return key;
}

/**
 * What the current palette is, as a string.
 *
 * Both the theme name and the light/dark class, because they are independent: the same theme in dark
 * is a different set of colours, and keying on only one of them leaves Monaco painted for the other.
 */
function themeSignature(): string {
  if (typeof document === 'undefined') return 'none';
  const root = document.documentElement;
  return `${root.dataset['theme'] ?? 'default'}:${root.className}`;
}
