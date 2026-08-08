import type { MaskId } from '@nos/core';

/**
 * Mask textures.
 *
 * The seam between the segmentation pipeline and the compositor, and deliberately the *only* one. The
 * spec's rule is that a mask is an asset type like any other and reaches an effect through a declared
 * `mask` sampler slot — so this takes decoded RGBA bytes and nothing else. It does not know about RLE,
 * about SAM 2, or about how a mask was produced. `@nos/masks` decodes; this uploads.
 *
 * One texture per mask id, re-uploaded in place as the frame changes. Re-uploading beats a texture per
 * frame for the reason that matters at 30 fps: allocating and freeing a texture every frame fragments
 * driver memory and shows up as periodic hitching, while `texSubImage2D` into a same-sized texture does
 * not allocate at all.
 */

/** One frame's mask, decoded and ready to upload. */
export interface MaskBitmap {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes. Every channel carries the coverage value. */
  readonly rgba: Uint8Array;
}

export interface MaskTextureStore {
  /**
   * Uploads a mask, replacing whatever that id held.
   *
   * Returns `undefined` when the bitmap does not match its dimensions rather than uploading it: GL
   * would read past the buffer, and the resulting texture is garbage in a way that looks like a model
   * problem.
   */
  set(mask: MaskId, bitmap: MaskBitmap): WebGLTexture | undefined;
  /** The texture for a mask, or `undefined` when none has been uploaded. */
  get(mask: MaskId): WebGLTexture | undefined;
  /** Drops one mask's texture. Called when a mask track is deleted. */
  release(mask: MaskId): void;
  /**
   * Frees anything not touched since the last sweep.
   *
   * The same policy the layer texture cache uses: a mask scrolled off the timeline should not hold VRAM
   * indefinitely, and reference counting across a render plan that is rebuilt every frame would be far
   * more machinery for the same result.
   */
  sweep(): void;
  dispose(): void;
  /** Textures currently resident, for the diagnostics panel. */
  readonly size: number;
}

interface Entry {
  readonly texture: WebGLTexture;
  width: number;
  height: number;
  touched: boolean;
}

export function createMaskTextureStore(gl: WebGL2RenderingContext): MaskTextureStore {
  const entries = new Map<MaskId, Entry>();

  function allocate(bitmap: MaskBitmap): Entry | undefined {
    const texture = gl.createTexture();
    if (texture === null) return undefined;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Clamped and linear: a mask sampled outside its edges must not wrap round to the opposite side of
    // the frame, which shows up as a stripe of the wrong coverage along one border.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      bitmap.width,
      bitmap.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bitmap.rgba,
    );
    return { texture, width: bitmap.width, height: bitmap.height, touched: true };
  }

  return {
    get size() {
      return entries.size;
    },

    set(mask, bitmap) {
      if (bitmap.rgba.length !== bitmap.width * bitmap.height * 4) {
        return undefined;
      }

      const existing = entries.get(mask);
      if (existing === undefined) {
        const created = allocate(bitmap);
        if (created === undefined) return undefined;
        entries.set(mask, created);
        return created.texture;
      }

      existing.touched = true;
      gl.bindTexture(gl.TEXTURE_2D, existing.texture);
      if (existing.width === bitmap.width && existing.height === bitmap.height) {
        // The steady state during playback: same object, same resolution, new frame. No allocation.
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          bitmap.width,
          bitmap.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bitmap.rgba,
        );
      } else {
        // A resolution change means the mask was regenerated at a different size — reallocate rather
        // than upload a mismatched sub-image, which GL would reject and leave the old frame resident.
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          bitmap.width,
          bitmap.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bitmap.rgba,
        );
        existing.width = bitmap.width;
        existing.height = bitmap.height;
      }
      return existing.texture;
    },

    get(mask) {
      const entry = entries.get(mask);
      if (entry === undefined) return undefined;
      entry.touched = true;
      return entry.texture;
    },

    release(mask) {
      const entry = entries.get(mask);
      if (entry === undefined) return;
      gl.deleteTexture(entry.texture);
      entries.delete(mask);
    },

    sweep() {
      for (const [mask, entry] of [...entries.entries()]) {
        if (entry.touched) {
          entry.touched = false;
          continue;
        }
        gl.deleteTexture(entry.texture);
        entries.delete(mask);
      }
    },

    dispose() {
      for (const entry of entries.values()) gl.deleteTexture(entry.texture);
      entries.clear();
    },
  };
}
