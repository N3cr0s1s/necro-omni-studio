import { useCallback, useRef, useState } from 'react';
import { type TimelineDocument, formatFrameRate, renderRange } from '@nos/core';
import {
  type ExportProgress,
  type ExportSettings,
  createProgressTracker,
  crfFor,
  exportFrames,
  frameCountFor,
  validateExportSettings,
} from '@nos/export';
import {
  createBuiltinPrograms,
  createGlCompositor,
  createProgramCache,
  createRenderTargetPool,
} from '@nos/compositor';
import type { EffectRegistry } from '@nos/effects';
import { type GpuSemaphore, withGpu } from '@nos/generators';
import { buildMixPlan, createOfflineMixRenderer, encodeWav } from '@nos/audio';
import { createAudioBufferCache } from './audio-buffers.js';
import { fileUrl } from './file-url.js';
import { bridge } from './bridge.js';
import { createMediaTextures } from './media-textures.js';
import { prepareFrame } from './frame-render.js';
import type { MaskSource } from './mask-source.js';
import type { DesktopBridge, SidecarInfo } from '../main/ipc-contract.js';

/**
 * Running an export.
 *
 * The **same compositor** the preview uses, on the same decoded frames, into an offscreen target whose
 * pixels are streamed to the sidecar's ffmpeg. That is the spec's WYSIWYG guarantee stated as code:
 * there is no second render path that could disagree with what the user approved.
 *
 * Three decisions worth stating.
 *
 * **Frames are batched, one batch is always in flight, and they leave through the main process.** A
 * 1080p RGBA frame is 8 MB, so a request per frame would spend the export in overhead. Instrumenting a
 * run showed where the time actually went — decode 3%, render 1%, readback 3%, **upload 78%** — and a
 * direct comparison found the cause: a 16 MB body posted from a page took about 1.3 s, while the same
 * body from `curl` took 0.02 s. Chromium copies a large request body across its network-service
 * boundary. So the bytes go over IPC to the main process, which posts them with Node's client.
 *
 * One upload stays in flight, which keeps the ordering ffmpeg's stdin requires while overlapping it
 * with the next batch's render; awaiting the previous upload before starting the next is still the
 * backpressure that stops the renderer buffering the whole export in memory.
 *
 * **Every seek is waited for.** A skipped layer in a preview is a momentary blank; in a delivered file
 * it is a missing shot. The preview and the export share one decoder precisely so this is the only
 * difference between them.
 *
 * **Cancellation leaves no file.** A half-written mp4 has no moov atom and will not play, so it is worse
 * than none — the sidecar deletes its partial output on cancel, and this only has to ask.
 */

export interface ExportRun {
  readonly running: boolean;
  readonly progress: ExportProgress | undefined;
  readonly error: string | undefined;
  /** Where the time went, once a run has finished. */
  readonly timing: ExportTiming | undefined;
  start(settings: ExportSettings): void;
  cancel(): void;
}

/**
 * Where an export spends its time.
 *
 * Kept as a first-class result rather than a console line, because "the export is slow" is a report
 * with four plausible causes — decode, render, readback, upload — and guessing which costs a day.
 */
export interface ExportTiming {
  readonly decodeMs: number;
  readonly renderMs: number;
  readonly readbackMs: number;
  readonly uploadMs: number;
  readonly totalMs: number;
  readonly frames: number;
}

export function describeTiming(timing: ExportTiming): string {
  const share = (ms: number): string => `${Math.round((ms / Math.max(1, timing.totalMs)) * 100)}%`;
  return (
    `${timing.frames} frames in ${(timing.totalMs / 1000).toFixed(1)} s — ` +
    `decode ${share(timing.decodeMs)}, render ${share(timing.renderMs)}, ` +
    `readback ${share(timing.readbackMs)}, upload ${share(timing.uploadMs)}`
  );
}

export interface ExportRunOptions {
  readonly document: TimelineDocument;
  readonly sidecar: SidecarInfo | undefined;
  /**
   * The window's GPU semaphore.
   *
   * An export renders every frame through the same WebGL2 compositor the preview uses, for minutes at
   * a time, so it is a GPU consumer in exactly the sense §7 means — and it ran without ever taking the
   * lock, straight alongside whatever generation happened to be in flight.
   */
  readonly gpu: GpuSemaphore;
  /**
   * The effects the preview is using, project-local ones included.
   *
   * Passed in rather than rebuilt from the builtins. This used to construct its own registry from
   * `BUILTIN_EFFECTS` alone, so a clip carrying an effect from the project's `effects/` folder rendered
   * in the preview and fell back to passthrough in the delivered file — the effect simply absent, with
   * nothing reported. One registry for both paths is the same rule as one compositor for both.
   */
  readonly effects: EffectRegistry;
  /**
   * Where a bound mask's frame comes from, so an export masks what the preview masked.
   *
   * Optional because an export of a project with no masks needs none — but absent when there *are*
   * masks is exactly the divergence the WYSIWYG guarantee forbids, so the shell always passes it.
   */
  readonly masks?: MaskSource | undefined;
}

/** Bytes of frame data per request. Sixteen megabytes is two 1080p frames, or eight at 720p. */
export const FRAME_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * A number no other encode job in this window has used.
 *
 * The timestamp alone is not enough: two exports started inside the same millisecond would collide
 * again, and a counter alone would repeat across a reload while the sidecar — which outlives the
 * window — still remembers the earlier job.
 */
let jobSequence = 0;
function nextJobSequence(): string {
  jobSequence += 1;
  return `${Date.now().toString(36)}_${jobSequence}`;
}

export function useExportRun({ document, sidecar, masks, gpu, effects }: ExportRunOptions): ExportRun {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [timing, setTiming] = useState<ExportTiming | undefined>(undefined);
  const cancelled = useRef(false);

  const documentRef = useRef(document);
  documentRef.current = document;

  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  const start = useCallback(
    (settings: ExportSettings) => {
      if (running) return;

      const validation = validateExportSettings(settings);
      if (!validation.ok) {
        setError(validation.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
        return;
      }
      if (sidecar === undefined || !sidecar.available) {
        setError('the media sidecar is not running, so nothing can be encoded');
        return;
      }

      cancelled.current = false;
      setRunning(true);
      setError(undefined);

      setTiming(undefined);
      /*
       * Queued behind the semaphore before a single frame is rendered, and said so rather than sitting
       * silently at zero: an export that waits for a generation to finish is correct behaviour, but an
       * export that appears frozen for four minutes is a bug report.
       */
      setProgress({
        phase: 'preparing',
        framesDone: 0,
        framesTotal: frameCountFor(settings.range),
        fraction: 0,
        fps: 0,
        message: 'waiting for the GPU',
      });
      void withGpu(gpu, 'export', settings.outputPath, () =>
        run(documentRef, settings, sidecar, cancelled, setProgress, setTiming, masks, effects),
      )
        .catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : String(failure));
        })
        .finally(() => setRunning(false));
    },
    [gpu, running, sidecar, masks, effects],
  );

  return { running, progress, error, timing, start, cancel };
}

async function run(
  documentRef: { readonly current: TimelineDocument },
  settings: ExportSettings,
  sidecar: SidecarInfo,
  cancelled: { current: boolean },
  report: (progress: ExportProgress) => void,
  reportTiming: (timing: ExportTiming) => void,
  masks: MaskSource | undefined,
  effects: EffectRegistry,
): Promise<void> {
  const { width, height } = settings.resolution;
  const total = frameCountFor(settings.range);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true });
  if (gl === null) throw new Error('this machine has no WebGL2 context, so nothing can be rendered');
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  const media = createMediaTextures(sidecar);
  const pool = createRenderTargetPool(gl);
  const compositor = createGlCompositor({
    gl,
    programs: createProgramCache(gl, effects),
    builtins: createBuiltinPrograms(gl),
    pool,
    textures: media.provider(gl),
  });

  // An 8-bit target, not the pool's: the pool hands out RGBA16F for intermediate passes, and reading
  // `UNSIGNED_BYTE` back from a half-float framebuffer is not a supported combination on every driver.
  // Reading from the default framebuffer is out too — its contents are undefined after compositing
  // unless `preserveDrawingBuffer` is set, which would cost a copy on every preview frame as well.
  const target = createReadbackTarget(gl, width, height);
  /*
   * Unique per run, not per output.
   *
   * It used to be the output path and the frame count, both of which are identical every time the same
   * sequence is exported — so the second export of a session reused the first one's id and the encoder
   * refused it as a duplicate. Exporting, watching it finish, then exporting again is not an unusual
   * thing to do; it was simply broken, and the run counter is what makes each attempt its own job.
   */
  const jobId = `export_${settings.outputPath.replace(/[^a-z0-9]+/gi, '_')}_${nextJobSequence()}`;
  const call = sidecarCall(sidecar);

  const tracker = createProgressTracker(total, performance.now());
  tracker.setPhase('preparing');
  report(tracker.snapshot(performance.now()));

  /*
   * The mix, rendered before a single frame is drawn.
   *
   * The export used to send an audio codec and a bitrate and never an audio *stream*, so ffmpeg muxed
   * the picture alone and every delivered file was silent — whatever was on the audio tracks. It is
   * rendered from the same `MixPlan` the preview schedules, so what is delivered is what was
   * auditioned; that is the WYSIWYG guarantee applied to sound rather than only to pixels.
   *
   * A failure here does not stop the export. A cut delivered silent is bad; a cut not delivered at all
   * because its music would not decode is worse, and the reason is carried into the progress message
   * rather than lost.
   */
  tracker.setPhase('preparing');
  report(tracker.snapshot(performance.now()));
  const mixdown = await renderMixdown(documentRef.current, settings, sidecar).catch((failure: unknown) => {
    report({
      ...tracker.snapshot(performance.now()),
      message: `the mix could not be rendered: ${failure instanceof Error ? failure.message : String(failure)}`,
    });
    return undefined;
  });

  const started = await call('/export/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      output: settings.outputPath,
      width,
      height,
      frame_rate: formatFrameRate(settings.frameRate),
      codec: settings.videoCodec,
      crf: crfFor(settings.videoCodec, settings.quality),
      speed: settings.speed,
      expected_frames: total,
      // Omitted rather than null when there is nothing to mix: a range with no audible clip in it is a
      // legitimate export, and an empty stream would make the encoder wait for samples that never come.
      ...(mixdown !== undefined ? { audio: mixdown } : {}),
      audio_codec: settings.audioCodec,
      audio_bitrate_kbps: settings.audioBitrateKbps,
    }),
  });
  if (!started.ok) throw new Error(`the encoder refused to start: ${await started.text()}`);

  const frameBytes = width * height * 4;
  const perBatch = Math.max(1, Math.floor(FRAME_BATCH_BYTES / frameBytes));
  let batch: Uint8Array[] = [];
  /** The upload in flight. At most one, so frames reach ffmpeg in the order it needs them. */
  let inFlight: Promise<void> | undefined;

  const spent = { decodeMs: 0, renderMs: 0, readbackMs: 0, uploadMs: 0 };
  const startedAt = performance.now();
  let frames = 0;

  /**
   * Sends the accumulated batch, without waiting for it.
   *
   * Awaits the *previous* upload first: ffmpeg reads its stdin as a stream, so batches must arrive in
   * order, and that await is also the backpressure that stops the renderer buffering the whole export.
   * What it does not do is wait for its own request — that is the whole point, and it is worth roughly
   * a threefold speed-up.
   */
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const body = concat(batch);
    batch = [];

    const previous = inFlight;
    inFlight = (async () => {
      if (previous !== undefined) await previous;

      const uploadStart = performance.now();
      const response = await sendFrames(`/export/${jobId}/frames`, body, sidecar);
      spent.uploadMs += performance.now() - uploadStart;
      if (!response.ok) throw new Error(`the encoder rejected a batch: ${response.body}`);
    })();
  }

  /** Waits for the pipeline to drain, so a rejected upload is observed rather than swallowed. */
  async function settle(): Promise<void> {
    const pending = inFlight;
    inFlight = undefined;
    if (pending !== undefined) await pending;
  }

  tracker.setPhase('rendering');

  try {
    for (const frame of exportFrames(settings.range)) {
      if (cancelled.current) break;

      // The same preparation the preview runs, which is what the spec's WYSIWYG guarantee actually
      // rests on: one compositor is necessary and was not sufficient — this path used to build its own
      // plan without a text cache key and never rasterize a title, so every one was silently absent
      // from the delivered file.
      //
      // Waited, unlike the preview: a skipped layer here is a missing shot rather than a blink.
      const decodeStart = performance.now();
      const { plan } = await prepareFrame(media, {
        document: documentRef.current,
        frame,
        effects,
        ...(masks !== undefined ? { masks } : {}),
        wait: true,
      });
      spent.decodeMs += performance.now() - decodeStart;

      const renderStart = performance.now();
      compositor.render(plan, target.framebuffer);
      spent.renderMs += performance.now() - renderStart;

      const readbackStart = performance.now();
      const pixels = new Uint8Array(frameBytes);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      spent.readbackMs += performance.now() - readbackStart;
      batch.push(pixels);
      frames += 1;

      tracker.frameDone(performance.now());
      if (batch.length >= perBatch) await flush();

      report(tracker.snapshot(performance.now()));
    }

    if (cancelled.current) {
      // Dropped rather than awaited: the job is about to be cancelled, and a rejected in-flight upload
      // would surface as an error for something the user asked to stop.
      inFlight = undefined;
      await call(`/export/${jobId}/cancel`, { method: 'POST' });
      tracker.setPhase('cancelled');
      report(tracker.snapshot(performance.now()));
      return;
    }

    await flush();
    await settle();
    // The encoder still has frames in its pipe when the last batch lands, so this phase is honest about
    // what is happening rather than showing 100% while ffmpeg finishes.
    tracker.setPhase('encoding');
    report(tracker.snapshot(performance.now()));

    const finished = await call(`/export/${jobId}/finish`, { method: 'POST' });
    if (!finished.ok) throw new Error(`the encoder failed to finish: ${await finished.text()}`);

    tracker.setPhase('complete');
    report(tracker.snapshot(performance.now()));
    reportTiming({ ...spent, totalMs: performance.now() - startedAt, frames });
  } finally {
    target.dispose();
    pool.dispose();
    compositor.dispose();
    media.dispose();
  }
}

/**
 * Sends a frame batch.
 *
 * Through the desktop bridge when there is one, which is the fast path and the reason the export is not
 * upload-bound any more. The direct `fetch` remains for the visual harness, which runs the same code in
 * a plain browser with no main process to route through.
 */
async function sendFrames(
  path: string,
  body: Uint8Array,
  sidecar: SidecarInfo,
): Promise<{ readonly ok: boolean; readonly body: string }> {
  const api = (globalThis as { nos?: { exportFrames?: DesktopBridge['exportFrames'] } }).nos;
  if (api?.exportFrames !== undefined) {
    return api.exportFrames(path, body.buffer as ArrayBuffer);
  }

  const response = await fetch(`${sidecar.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-nos-token': sidecar.token },
    body: body.buffer as ArrayBuffer,
  });
  return { ok: response.ok, body: response.ok ? '' : await response.text() };
}

/** Authenticated calls to the sidecar. The token is a header everywhere except the media endpoint. */
function sidecarCall(sidecar: SidecarInfo) {
  return (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${sidecar.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-nos-token': sidecar.token },
    });
}

/** One buffer from many, so a batch is a single request body. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * An 8-bit render target to read back from.
 *
 * Separate from the compositor's pool by necessity: intermediate passes want RGBA16F for headroom, and
 * `readPixels(UNSIGNED_BYTE)` from a half-float attachment is not universally supported.
 */
function createReadbackTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): { readonly framebuffer: WebGLFramebuffer; dispose(): void } {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (texture === null || framebuffer === null) throw new Error('could not allocate an export target');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`the export target is incomplete (0x${status.toString(16)})`);
  }

  return {
    framebuffer,
    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    },
  };
}

/**
 * The range an export defaults to: the in/out range when one is marked, the whole sequence
 * otherwise.
 *
 * Delegated to `renderRange` rather than derived again here. The core function exists exactly so
 * that export and looped playback share one definition — two of them would agree until someone
 * marked an in point, and then the preview and the file would quietly disagree about what was being
 * rendered.
 */
export function defaultRange(document: TimelineDocument): ExportSettings['range'] {
  return renderRange(document);
}

/**
 * Renders the export's audio and leaves it where the encoder can find it.
 *
 * `undefined` when the range holds nothing audible, which is a normal outcome — a title card over
 * black has no mix — and is why the caller omits the field rather than sending an empty stream.
 *
 * The whole range is planned in **one** plan rather than the rolling window playback uses. The window
 * exists so the scheduler can stay ahead of a moving clock; an offline render has no clock, and one
 * plan means no seams to get wrong at the boundaries.
 */
async function renderMixdown(
  document: TimelineDocument,
  settings: ExportSettings,
  sidecar: SidecarInfo,
): Promise<string | undefined> {
  const api = bridge();
  if (api === undefined) return undefined;

  const plan = buildMixPlan({ document, span: settings.range });
  if (plan.sources.length === 0) return undefined;

  const sampleRate = MIXDOWN_SAMPLE_RATE;
  const channels = 2;

  // Its own context, disposed with the render: the preview's belongs to the transport and reusing it
  // would tie an export to whether the user happened to be playing.
  const context = new AudioContext();
  try {
    const buffers = createAudioBufferCache({ context, urlFor: (asset) => fileUrl(sidecar, asset) });
    const renderer = createOfflineMixRenderer({
      buffers,
      createContext: (count, length, rate) => new OfflineAudioContext(count, length, rate),
    });

    const rendered = await renderer.render([plan], sampleRate, channels);
    return await api.writeMixdown(encodeWav(rendered));
  } finally {
    void context.close().catch(() => undefined);
  }
}

/**
 * Sample rate of the rendered mix.
 *
 * 48 kHz because that is what video carries; resampling once here, deliberately, beats letting the
 * encoder resample from whatever the first decoded file happened to be.
 */
const MIXDOWN_SAMPLE_RATE = 48_000;
