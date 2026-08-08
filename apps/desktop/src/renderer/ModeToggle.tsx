import type { ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@nos/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@nos/ui/components/ui/dropdown-menu';

/**
 * Light, dark, or whatever the desktop says.
 *
 * This file used to be a hook that stamped an attribute on `<html>`, wrote to `localStorage`, and
 * defaulted to dark on the argument that a bright surround changes what a grade looks like. All of
 * that is `next-themes`' now, which is what the registry's own components already read — `Toaster`
 * asks it which theme it is in — so a second mechanism would be a second source of truth.
 *
 * What is left here is a control. It offers **system** as well as the two fixed modes, which the
 * hand-rolled toggle could not: the previous default ignored the desktop's preference deliberately,
 * and the honest version of that argument is to let the user say so rather than to decide for them.
 */
export function ModeToggle(): ReactNode {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Colour mode" title="Light, dark, or system" />
        }
      >
        {/* Both drawn, one shown: swapping the element on a theme change makes the button flicker as
            React remounts it, and a rotation is what the registry's own example does. */}
        <SunIcon className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <MoonIcon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')} data-checked={theme === 'light'}>
          <SunIcon />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')} data-checked={theme === 'dark'}>
          <MoonIcon />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')} data-checked={theme === 'system'}>
          <MonitorIcon />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
