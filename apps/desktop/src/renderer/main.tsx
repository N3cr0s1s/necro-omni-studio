import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import '@nos/ui/globals.css';
import { Toaster } from '@nos/ui/components/ui/sonner';
import { TooltipProvider } from '@nos/ui/components/ui/tooltip';
import { App } from './App.js';

/**
 * The renderer entry point.
 *
 * Nothing but mounting and the three providers the registry expects around an application: the theme,
 * so `dark` reaches every component and `Toaster` knows which mode it is in; tooltips, whose delay is
 * shared rather than per-tooltip; and the toast host itself.
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
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
