import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import '@nos/ui/globals.css';
import { TooltipProvider } from '@nos/ui/components/ui/tooltip';
import { App } from './App.js';

/**
 * The renderer entry point.
 *
 * Nothing but mounting and the two providers the registry expects around an application: the theme, so
 * `dark` reaches every component, and tooltips, whose delay is shared rather than set per tooltip.
 *
 * There is no toast host. `shadcn add sonner` brings one back in a command, and adding it before
 * anything toasts would be a mounted component that does nothing — which is the kind of thing this
 * refactor exists to remove, not to introduce.
 *
 * `defaultTheme="dark"` is the one opinion left about appearance, and it is the same one this editor
 * has always held: a bright surround changes what a graded frame looks like. It is a *default* — the
 * mode toggle offers `system` too, and a choice made there is remembered.
 */
const host = document.getElementById('root');
if (host === null) throw new Error('the renderer template is missing its #root element');

createRoot(host).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
