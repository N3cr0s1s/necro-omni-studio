import type { DesktopBridge } from '../main/ipc-contract.js';

/**
 * The way out of the renderer.
 *
 * Everything this window cannot do for itself — reading a folder, spawning the sidecar, reaching
 * ComfyUI, writing a file — goes through this one object, which the preload script puts on
 * `globalThis` under `contextIsolation`. That makes it the single seam between the two processes.
 *
 * It was written out five times, byte for byte, in five files. Nothing had drifted yet, but a seam
 * with five definitions is five places to change the day it grows anything — a version check, a log
 * when it is missing, a stub for the visual harness — and four places to forget.
 *
 * `undefined` rather than a throw, because running without it is a **supported** state: the `@nos/ui`
 * harness renders the same components in a plain browser with no preload at all. Every caller is
 * expected to have an answer for its absence, and most of them say so on screen.
 */
export function bridge(): DesktopBridge | undefined {
  return (globalThis as { nos?: DesktopBridge }).nos;
}
