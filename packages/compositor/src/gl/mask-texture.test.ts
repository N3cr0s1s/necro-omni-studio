import { describe, expect, it, vi } from 'vitest';
import { maskId } from '@nos/core';
import { type MaskBitmap, createMaskTextureStore } from './mask-texture.js';

/**
 * A recording GL stub.
 *
 * The store's contract is about *which GL calls happen* — an allocation per frame is the bug this
 * component exists to avoid — so a stub that records calls tests exactly the property that matters.
 * Pixel correctness is covered by the GL harness, which runs against a real context.
 */
function fakeGl() {
  let next = 1;
  const calls: string[] = [];
  const deleted: unknown[] = [];

  const gl = {
    TEXTURE_2D: 3553,
    TEXTURE_WRAP_S: 1,
    TEXTURE_WRAP_T: 2,
    TEXTURE_MIN_FILTER: 3,
    TEXTURE_MAG_FILTER: 4,
    CLAMP_TO_EDGE: 33071,
    LINEAR: 9729,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    createTexture: vi.fn(() => ({ id: next++ }) as unknown as WebGLTexture),
    bindTexture: vi.fn(),
    texParameteri: vi.fn((_target: number, name: number, value: number) => {
      calls.push(`param:${name}=${value}`);
    }),
    texImage2D: vi.fn(() => calls.push('texImage2D')),
    texSubImage2D: vi.fn(() => calls.push('texSubImage2D')),
    deleteTexture: vi.fn((texture: unknown) => {
      deleted.push(texture);
      calls.push('deleteTexture');
    }),
  };

  return { gl: gl as unknown as WebGL2RenderingContext, calls, deleted, raw: gl };
}

const bitmap = (width = 2, height = 2): MaskBitmap => ({
  width,
  height,
  rgba: new Uint8Array(width * height * 4),
});

describe('uploading', () => {
  it('allocates once per mask', () => {
    const { gl, calls } = fakeGl();
    const store = createMaskTextureStore(gl);
    const id = maskId('m1');

    store.set(id, bitmap());
    store.set(id, bitmap());
    store.set(id, bitmap());

    expect(calls.filter((call) => call === 'texImage2D')).toHaveLength(1);
  });

  it('re-uploads in place for a new frame of the same size', () => {
    // The steady state during playback. Allocating a texture every frame fragments driver memory and
    // shows up as periodic hitching.
    const { gl, calls } = fakeGl();
    const store = createMaskTextureStore(gl);

    store.set(maskId('m1'), bitmap());
    store.set(maskId('m1'), bitmap());

    expect(calls.filter((call) => call === 'texSubImage2D')).toHaveLength(1);
  });

  it('reallocates when the resolution changes', () => {
    // A sub-image upload of a different size is rejected by GL and leaves the previous frame resident,
    // which reads as a mask that stopped tracking.
    const { gl, calls } = fakeGl();
    const store = createMaskTextureStore(gl);

    store.set(maskId('m1'), bitmap(2, 2));
    store.set(maskId('m1'), bitmap(4, 4));

    expect(calls.filter((call) => call === 'texImage2D')).toHaveLength(2);
    expect(calls).not.toContain('texSubImage2D');
  });

  it('keeps one texture per mask', () => {
    const { gl, raw } = fakeGl();
    const store = createMaskTextureStore(gl);

    store.set(maskId('m1'), bitmap());
    store.set(maskId('m2'), bitmap());

    expect(raw.createTexture).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);
  });

  it('clamps rather than wraps', () => {
    // A mask sampled past its edge must not wrap to the opposite side, which draws a stripe of the
    // wrong coverage along one border.
    const { gl, calls } = fakeGl();
    createMaskTextureStore(gl).set(maskId('m1'), bitmap());

    expect(calls).toContain('param:1=33071');
    expect(calls).toContain('param:2=33071');
  });

  it('refuses a bitmap that does not match its dimensions', () => {
    // GL would read past the buffer and produce garbage that looks like a model problem.
    const { gl, raw } = fakeGl();
    const store = createMaskTextureStore(gl);

    const result = store.set(maskId('m1'), { width: 2, height: 2, rgba: new Uint8Array(4) });
    expect(result).toBeUndefined();
    expect(raw.createTexture).not.toHaveBeenCalled();
  });

  it('reports a failed allocation rather than returning a broken handle', () => {
    const { gl, raw } = fakeGl();
    raw.createTexture.mockReturnValueOnce(null as unknown as WebGLTexture);
    expect(createMaskTextureStore(gl).set(maskId('m1'), bitmap())).toBeUndefined();
  });
});

describe('lookup', () => {
  it('returns the uploaded texture', () => {
    const { gl } = fakeGl();
    const store = createMaskTextureStore(gl);
    const uploaded = store.set(maskId('m1'), bitmap());
    expect(store.get(maskId('m1'))).toBe(uploaded);
  });

  it('returns nothing for a mask that has not been generated yet', () => {
    // The compositor treats this as "not ready" and skips the pass, rather than stalling the preview.
    const { gl } = fakeGl();
    expect(createMaskTextureStore(gl).get(maskId('m1'))).toBeUndefined();
  });
});

describe('lifetime', () => {
  it('frees a mask that was not touched since the last sweep', () => {
    const { gl } = fakeGl();
    const store = createMaskTextureStore(gl);
    store.set(maskId('m1'), bitmap());

    // A just-uploaded mask survives the first sweep: `set` marks it touched, which is what keeps a
    // mask uploaded this frame from being freed before it is ever drawn.
    store.sweep();
    expect(store.size).toBe(1);

    store.sweep();
    expect(store.size).toBe(0);
  });

  it('keeps a mask that was used this frame', () => {
    const { gl } = fakeGl();
    const store = createMaskTextureStore(gl);
    store.set(maskId('m1'), bitmap());
    store.sweep();

    store.get(maskId('m1'));
    store.sweep();
    expect(store.size).toBe(1);
  });

  it('releases one mask without touching the others', () => {
    const { gl } = fakeGl();
    const store = createMaskTextureStore(gl);
    store.set(maskId('m1'), bitmap());
    store.set(maskId('m2'), bitmap());

    store.release(maskId('m1'));
    expect(store.get(maskId('m1'))).toBeUndefined();
    expect(store.get(maskId('m2'))).toBeDefined();
  });

  it('ignores releasing a mask it never held', () => {
    const { gl, raw } = fakeGl();
    createMaskTextureStore(gl).release(maskId('nope'));
    expect(raw.deleteTexture).not.toHaveBeenCalled();
  });

  it('frees everything on dispose', () => {
    const { gl, deleted } = fakeGl();
    const store = createMaskTextureStore(gl);
    store.set(maskId('m1'), bitmap());
    store.set(maskId('m2'), bitmap());

    store.dispose();
    expect(deleted).toHaveLength(2);
    expect(store.size).toBe(0);
  });
});
