import { type ReactNode, useEffect } from 'react';
import { PaletteIcon } from 'lucide-react';
import { DEFAULT_THEME_ID, THEMES, themeById } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@nos/ui/components/ui/dropdown-menu';

/**
 * Which palette the editor draws in.
 *
 * The second axis of appearance, beside `ModeToggle`'s light / dark / system. They are independent
 * and both are always answered: every theme carries a light palette and a dark one, so switching
 * either never leaves a role undefined.
 *
 * The list is `THEMES`, not a copy of it — a theme added to that array is offered here, applied by
 * the stylesheet and measured by the audit without another line being written. That is what makes
 * this worth having as a system rather than as a second stylesheet.
 */

export interface ThemePickerProps {
  /** The stored id, or `undefined` while settings are still being read. */
  readonly themeId: string | undefined;
  onChange(id: string): void;
}

/**
 * Puts the palette on `<html>`, where the stylesheet's `[data-theme]` blocks can see it.
 *
 * A hook rather than something the picker does on click, because the setting is read from disk a
 * moment after the window opens and a click is not the only time it changes. Stamping it in an effect
 * means the stored palette applies on the first render that knows it, and a build where settings
 * never arrive simply leaves the attribute off — which renders exactly what this application rendered
 * before themes existed.
 */
export function useThemeAttribute(id: string | undefined): void {
  useEffect(() => {
    // Resolved rather than written through: a stored id from a build with more themes in it would
    // otherwise put an attribute on `<html>` that no stylesheet block matches, leaving the window in
    // whatever `:root` says while the picker claims something else.
    document.documentElement.dataset['theme'] = themeById(id).id;
  }, [id]);
}

export function ThemePicker({ themeId: stored, onChange }: ThemePickerProps): ReactNode {
  const current = themeById(stored);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Theme" title={`Theme — ${current.label}`} />
        }
      >
        <PaletteIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEMES.map((theme) => (
          <DropdownMenuItem
            key={theme.id}
            onClick={() => onChange(theme.id)}
            data-checked={theme.id === current.id}
          >
            {/*
              A swatch of the theme's own primary, drawn from the palette rather than described in
              words: "Zinc" and "Neutral" are not names anyone can picture, and a row that shows the
              colour is the difference between choosing and guessing.

              An inline style is the one place in this application where that is right — the value is
              data from `THEMES`, and a Tailwind class cannot be built from a runtime string because
              Tailwind compiles what it can see in the source.
            */}
            <span
              aria-hidden="true"
              className="size-3.5 shrink-0 border"
              style={{ backgroundColor: theme.light.primary }}
            />
            {theme.label}
            {theme.id === DEFAULT_THEME_ID && (
              <span className="text-muted-foreground ml-auto pl-2 text-xs">default</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
