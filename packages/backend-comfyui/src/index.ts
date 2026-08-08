/**
 * `@nos/backend-comfyui` — the ComfyUI implementation of `GeneratorBackend`.
 *
 * The only package that knows ComfyUI's protocol exists. Graph patching is pure and separately testable
 * against the real supplied graphs; the rest is endpoint calls.
 */
export * from './graph-patcher.js';
export * from './comfyui-backend.js';
