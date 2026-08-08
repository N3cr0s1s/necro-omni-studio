import type { Resolution } from '@nos/core';

/**
 * Offscreen render targets.
 *
 * The spec's effect model is a chain where each pass reads the previous pass's output, which needs two
 * textures swapped between passes — a ping-pong pair. Allocating them per frame would thrash GPU
 * memory at 30 fps, so targets come from a pool keyed by resolution and are reused for the session.
 *
 * Half-float (`RGBA16F`) rather than 8-bit: an eight-pass chain quantizes visibly in 8-bit, showing as
 * banding in gradients that each individual pass looks fine on. The spec allows up to eight passes
 * before it even warns, so the intermediate format has to carry that without degrading.
 */

export interface RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

export interface RenderTargetPool {
  /** Borrows a target at the given size. Contents are undefined until cleared or drawn to. */
  acquire(resolution: Resolution): RenderTarget;
  /** Returns a target for reuse. */
  release(target: RenderTarget): void;
  /** Targets currently borrowed, for leak assertions in tests. */
  borrowedCount(): number;
  dispose(): void;
}

export class RenderTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderTargetError';
  }
}

/**
 * Creates a colour render target.
 *
 * No depth or stencil attachment: the compositor draws fullscreen quads in a fixed order and has no
 * use for depth testing. Omitting them saves a meaningful amount of memory at 1080p across five or
 * more live targets.
 */
export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): RenderTarget {
  const texture = gl.createTexture();
  if (texture === null) throw new RenderTargetError('could not create a texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  // LINEAR so a scaled layer resamples smoothly; CLAMP_TO_EDGE because a shader sampling outside the
  // intended area should read the edge rather than wrapping the opposite side into frame.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null) {
    gl.deleteTexture(texture);
    throw new RenderTargetError('could not create a framebuffer');
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    // Named rather than silent: an incomplete framebuffer means every subsequent draw is discarded,
    // and the symptom is a black preview with no error anywhere.
    throw new RenderTargetError(`framebuffer incomplete (status 0x${status.toString(16)})`);
  }

  return { framebuffer, texture, width, height };
}

/**
 * A pool of render targets, keyed by size.
 *
 * Keyed rather than one-size-fits-all because export renders at project resolution while preview
 * renders at proxy resolution, and both may be live in the same session.
 */
export function createRenderTargetPool(gl: WebGL2RenderingContext): RenderTargetPool {
  const available = new Map<string, RenderTarget[]>();
  const borrowed = new Set<RenderTarget>();

  const key = (width: number, height: number): string => `${width}x${height}`;

  return {
    acquire(resolution: Resolution): RenderTarget {
      const bucketKey = key(resolution.width, resolution.height);
      const bucket = available.get(bucketKey);
      const reused = bucket?.pop();

      const target =
        reused ?? createRenderTarget(gl, resolution.width, resolution.height);
      borrowed.add(target);
      return target;
    },

    release(target: RenderTarget): void {
      if (!borrowed.delete(target)) return;
      const bucketKey = key(target.width, target.height);
      const bucket = available.get(bucketKey);
      if (bucket === undefined) available.set(bucketKey, [target]);
      else bucket.push(target);
    },

    borrowedCount: () => borrowed.size,

    dispose(): void {
      for (const bucket of available.values()) {
        for (const target of bucket) {
          gl.deleteFramebuffer(target.framebuffer);
          gl.deleteTexture(target.texture);
        }
      }
      for (const target of borrowed) {
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
      available.clear();
      borrowed.clear();
    },
  };
}

/**
 * A ping-pong pair for running an effect chain.
 *
 * `read` is the current input, `write` the target for the next pass. `swap` after each pass makes the
 * output become the next input. Wrapping this in a small object rather than juggling two variables at
 * the call site is what keeps the chain loop readable and the swap impossible to forget.
 */
export interface PingPong {
  readonly read: RenderTarget;
  readonly write: RenderTarget;
  swap(): PingPong;
}

export function createPingPong(front: RenderTarget, back: RenderTarget): PingPong {
  return {
    read: front,
    write: back,
    swap: () => createPingPong(back, front),
  };
}
