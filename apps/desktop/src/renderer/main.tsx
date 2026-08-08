import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@nos/ui/tokens.css';
import { App } from './App.js';

/**
 * The renderer entry point.
 *
 * Nothing but mounting. The window's chrome, its state and its behaviour are all in `App`, so this file
 * never needs to change and a test can mount `App` without a DOM entry point at all.
 */
const host = document.getElementById('root');
if (host === null) throw new Error('the renderer template is missing its #root element');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
