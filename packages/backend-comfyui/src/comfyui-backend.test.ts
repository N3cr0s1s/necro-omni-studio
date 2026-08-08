import { describe, expect, it } from 'vitest';
import { assetPath } from '@nos/core';
import {
  type ComfyUiBackendOptions,
  type ComfyUiSocket,
  type ComfyUiTransport,
  createComfyUiBackend,
  enumOptionsOf,
  parseSocketEvent,
  viewQuery,
} from './comfyui-backend.js';

/** A transport whose responses the test scripts, so no server is needed. */
function fakeTransport(
  routes: Record<string, unknown>,
  messages: readonly unknown[] = [],
): ComfyUiTransport & {
  readonly calls: string[];
  /** Request bodies, so a test can assert what was actually submitted rather than only where. */
  readonly bodies: string[];
  readonly closed: number;
} {
  const calls: string[] = [];
  const bodies: string[] = [];
  const state = { closed: 0 };

  const socket: ComfyUiSocket = {
    async *messages() {
      for (const message of messages) yield message;
    },
    close() {
      state.closed += 1;
    },
  };

  return {
    calls,
    bodies,
    get closed() {
      return state.closed;
    },
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (typeof init?.body === 'string') bodies.push(init.body);
      const key = Object.keys(routes).find((route) => url.includes(route));
      if (key === undefined) {
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
      }
      const value = routes[key];
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
    }) as unknown as typeof globalThis.fetch,
    openSocket: () => socket,
  };
}

/** Records what the backend asked to be downloaded, since that is the step outputs depend on. */
const downloads: { query: string; destination: string }[] = [];

type Download = ComfyUiBackendOptions['download'];
type Upload = ComfyUiBackendOptions['upload'];

/** Records what the backend asked to be uploaded, since the graph is rewritten from the answer. */
const uploads: { path: string; key: string }[] = [];

const backendWith = (
  transport: ComfyUiTransport,
  download: Download = defaultDownload,
  upload: Upload = defaultUpload,
) =>
  createComfyUiBackend({
    endpoint: { baseUrl: 'http://localhost:8188' },
    transport,
    clientId: 'client-1',
    download,
    upload,
  });

const defaultDownload: Download = async (query, destination) => {
  downloads.push({ query, destination });
  return { ok: true, value: undefined };
};

const defaultUpload: Upload = async ({ path, key }) => {
  uploads.push({ path, key });
  // ComfyUI files an upload under its own name, which is what a graph must reference.
  return { ok: true, value: { name: `stored_${path.split('/').pop() ?? path}` } };
};

describe('reading an enum input’s options', () => {
  // ComfyUI declares them two ways, and only the older was understood. Against a current ComfyUI the
  // consequence was quiet and total: every live dropdown in the application was empty, so a manifest
  // deferring its options to the backend produced a control with nothing in it. The report was that a
  // generator's resolution could not be set; the cause was that no live enum anywhere could be.
  it('reads the long-standing shape, where the options stand in for the type', () => {
    expect(enumOptionsOf([['euler', 'dpmpp_2m'], { default: 'euler' }])).toEqual(['euler', 'dpmpp_2m']);
  });

  it('reads the newer shape, where the type is named and the options are metadata', () => {
    const spec = ['COMBO', { tooltip: 'The aspect ratio', options: ['1:1 (Square)', '16:9 (Widescreen)'] }];
    expect(enumOptionsOf(spec)).toEqual(['1:1 (Square)', '16:9 (Widescreen)']);
  });

  it('is nothing for a scalar input', () => {
    expect(enumOptionsOf(['FLOAT', { default: 1, min: 0.1, max: 16 }])).toBeUndefined();
    expect(enumOptionsOf(['INT', { default: 8 }])).toBeUndefined();
  });

  it('is nothing for an input that is not a declaration at all', () => {
    expect(enumOptionsOf(undefined)).toBeUndefined();
    expect(enumOptionsOf('IMAGE')).toBeUndefined();
    expect(enumOptionsOf([])).toBeUndefined();
  });

  it('refuses a mixed list rather than passing non-strings to a select', () => {
    expect(enumOptionsOf([['a', 3], {}])).toBeUndefined();
    expect(enumOptionsOf(['COMBO', { options: ['a', null] }])).toBeUndefined();
  });
});

describe('submit', () => {
  it('posts the graph and returns the prompt id', async () => {
    const transport = fakeTransport({ '/prompt': { prompt_id: 'abc123' } });
    const result = await backendWith(transport).submit({ graph: { '1': {} }, assets: [] });

    expect(result).toEqual({ ok: true, value: 'abc123' });
    expect(transport.calls.some((call) => call.startsWith('POST http://localhost:8188/prompt'))).toBe(true);
  });

  it('uploads an asset and points the graph at the name the backend stored it under', async () => {
    // Both halves were broken. The upload read the project file *through the backend transport*,
    // which in the desktop proxies to ComfyUI — so it asked the render server for a file on the
    // local disk, and the run died with `a backend path must start with "/"`. And the returned name
    // was never written into the graph, so even a working upload left the node loading whatever the
    // graph's author last saved: a run that looks like it used your image and did not.
    uploads.length = 0;
    const transport = fakeTransport({ '/prompt': { prompt_id: 'p1' } });
    const result = await backendWith(transport).submit({
      graph: { '114': { inputs: { image: 'placeholder.png' } } },
      assets: [
        {
          key: 'first_frame',
          path: assetPath('media/stills/take_000089.png'),
          transport: 'upload_image',
          bind: '/114/inputs/image',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(uploads).toEqual([{ path: 'media/stills/take_000089.png', key: 'first_frame' }]);
    const posted = transport.bodies.join('');
    expect(posted).toContain('stored_take_000089.png');
    expect(posted).not.toContain('placeholder.png');
  });

  it('does not submit at all when an upload fails', async () => {
    // A prompt referencing a file that never arrived fails deep inside the backend, where the reason
    // is a validation error about a missing input rather than the upload that actually broke.
    const transport = fakeTransport({ '/prompt': { prompt_id: 'p1' } });
    const result = await backendWith(transport, defaultDownload, async () => ({
      ok: false,
      error: { kind: 'upload-failed', key: 'first_frame', detail: 'disk on fire' },
    })).submit({
      graph: {},
      assets: [
        {
          key: 'first_frame',
          path: assetPath('media/a.png'),
          transport: 'upload_image',
          bind: '/1/inputs/image',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(transport.calls.some((call) => call.includes('/prompt'))).toBe(false);
  });

  it('leaves the graph alone for an asset the manifest never bound', async () => {
    // An unbound manifest is a legitimate state — a contract written before its graph exists — and
    // patching a null pointer would throw where nothing is wrong.
    const transport = fakeTransport({ '/prompt': { prompt_id: 'p1' } });
    const result = await backendWith(transport).submit({
      graph: { '1': { inputs: { image: 'kept.png' } } },
      assets: [{ key: 'first_frame', path: assetPath('media/a.png'), transport: 'upload_image', bind: null }],
    });

    expect(result.ok).toBe(true);
    expect(transport.bodies.join('')).toContain('kept.png');
  });

  it('treats a 200 with no prompt id as a rejection', async () => {
    // ComfyUI answers 200 with a validation error body for a bad graph, so HTTP success is not proof the
    // job was accepted.
    const transport = fakeTransport({ '/prompt': { error: { type: 'prompt_outputs_failed_validation' } } });
    const result = await backendWith(transport).submit({ graph: {}, assets: [] });

    expect(result.ok).toBe(false);
    // Narrowed on the discriminant before reading `detail`: not every BackendError carries one, and the
    // union is what makes that impossible to get wrong at a call site.
    if (!result.ok && result.error.kind === 'rejected') {
      expect(result.error.detail).toContain('validation');
    } else {
      throw new Error('expected a rejection');
    }
  });

  it('reports an unreachable server distinctly from a rejection', async () => {
    const transport = fakeTransport({ '/prompt': new Error('ECONNREFUSED') });
    const result = await backendWith(transport).submit({ graph: {}, assets: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unreachable');
  });
});

describe('progress', () => {
  it('converts sampler steps into a fraction', async () => {
    const transport = fakeTransport({}, [
      { type: 'progress', data: { value: 5, max: 20, prompt_id: 'job1' } },
      { type: 'executing', data: { node: null, prompt_id: 'job1' } },
    ]);

    const events = [];
    for await (const event of backendWith(transport).progress('job1')) events.push(event);

    expect(events[0]).toEqual({ fraction: 0.25, stage: 'sampling' });
  });

  it('ignores events belonging to another prompt', async () => {
    // ComfyUI multiplexes every client's events onto one socket; without filtering, a second window's job
    // would drive this one's progress bar.
    const transport = fakeTransport({}, [
      { type: 'progress', data: { value: 9, max: 10, prompt_id: 'someone-else' } },
      { type: 'progress', data: { value: 1, max: 10, prompt_id: 'job1' } },
      { type: 'executing', data: { node: null, prompt_id: 'job1' } },
    ]);

    const events = [];
    for await (const event of backendWith(transport).progress('job1')) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]!.fraction).toBeCloseTo(0.1, 6);
  });

  it('stops on the end-of-execution signal', async () => {
    const transport = fakeTransport({}, [
      { type: 'executing', data: { node: null, prompt_id: 'job1' } },
      { type: 'progress', data: { value: 1, max: 2, prompt_id: 'job1' } },
    ]);

    const events = [];
    for await (const event of backendWith(transport).progress('job1')) events.push(event);
    expect(events).toHaveLength(0);
  });

  it('closes the socket even when the consumer breaks out early', async () => {
    // A leaked socket per job would accumulate for the session.
    const transport = fakeTransport({}, [
      { type: 'progress', data: { value: 1, max: 10, prompt_id: 'job1' } },
      { type: 'progress', data: { value: 2, max: 10, prompt_id: 'job1' } },
    ]);

    for await (const event of backendWith(transport).progress('job1')) {
      void event;
      break;
    }
    expect(transport.closed).toBe(1);
  });
});

describe('collect', () => {
  const history = {
    job1: {
      status: { status_str: 'success', completed: true },
      outputs: { '57': { audio: [{ filename: 'bed_0031.flac', type: 'output' }] } },
    },
  };

  it('maps history outputs onto project-relative paths', async () => {
    // Prefixed with the job: ComfyUI names by prefix and counter, so two runs of one generator both
    // produce `bed_0031.flac` and the second would overwrite the first in `generated/`.
    const result = await backendWith(fakeTransport({ '/history/': history })).collect('job1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ key: '57', type: 'audio', path: 'generated/job1_bed_0031.flac' }]);
    }
  });

  it('downloads every output into the project, which is what makes one reachable', async () => {
    // ComfyUI writes into its own output directory. Without this a job completes, reports its files
    // and shows its variants, while none of them exist anywhere the application can read.
    downloads.length = 0;
    await backendWith(fakeTransport({ '/history/': history })).collect('job1');

    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.query).toContain('filename=bed_0031.flac');
    expect(downloads[0]?.destination).toBe('generated/job1_bed_0031.flac');
  });

  it('reports a download that failed rather than a file that is not there', async () => {
    const failing: Download = async () => ({
      ok: false,
      error: { kind: 'unreachable', detail: 'connection refused' },
    });
    const result = await backendWith(fakeTransport({ '/history/': history }), failing).collect('job1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unreachable');
      expect('detail' in result.error && result.error.detail).toContain('connection refused');
    }
  });

  it('reports an execution error from the history status', async () => {
    const failed = { job1: { status: { status_str: 'error' }, outputs: {} } };
    const result = await backendWith(fakeTransport({ '/history/': failed })).collect('job1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('execution-failed');
  });

  it('reports a job that finished with no files', async () => {
    const empty = { job1: { status: { status_str: 'success' }, outputs: {} } };
    const result = await backendWith(fakeTransport({ '/history/': empty })).collect('job1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('no-outputs');
  });

  it('reports a missing history entry', async () => {
    const result = await backendWith(fakeTransport({ '/history/': {} })).collect('job1');
    expect(result.ok).toBe(false);
  });
});

describe('capabilities', () => {
  it('reports installed node classes for the registry requires check', async () => {
    const transport = fakeTransport({
      '/object_info': {
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] } },
        },
        KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } },
      },
    });

    const result = await backendWith(transport).capabilities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect([...result.value.nodeClasses].sort()).toEqual(['CheckpointLoaderSimple', 'KSampler']);
  });

  it('extracts enum options, so model lists reflect reality', async () => {
    // The spec's mechanism for `options: { from: "capabilities" }` — a manifest written six months ago must
    // not dictate today's checkpoint list.
    const transport = fakeTransport({
      '/object_info': {
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] } },
        },
      },
    });

    const result = await backendWith(transport).capabilities();
    if (!result.ok) throw new Error('expected capabilities');
    expect(result.value.enumOptions.get('CheckpointLoaderSimple/ckpt_name')).toEqual([
      'a.safetensors',
      'b.safetensors',
    ]);
  });

  it('does not treat a scalar input as an enum', async () => {
    const transport = fakeTransport({
      '/object_info': { KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } } },
    });
    const result = await backendWith(transport).capabilities();
    if (!result.ok) throw new Error('expected capabilities');
    expect(result.value.enumOptions.size).toBe(0);
  });
});

describe('cancel', () => {
  it('interrupts and dequeues, since ComfyUI distinguishes them', async () => {
    // `interrupt` alone would stop whatever is currently executing — possibly someone else's job — rather
    // than removing a queued one.
    const transport = fakeTransport({ '/interrupt': {}, '/queue': {} });
    await backendWith(transport).cancel('job1');

    expect(transport.calls.some((call) => call.includes('/interrupt'))).toBe(true);
    expect(transport.calls.some((call) => call.includes('/queue'))).toBe(true);
  });

  it('does not throw when the server is unreachable', async () => {
    // Cancellation is best-effort; failing here would leave the UI unable to cancel a job it already
    // considers gone.
    const transport = fakeTransport({ '/interrupt': new Error('down') });
    await expect(backendWith(transport).cancel('job1')).resolves.toBeUndefined();
  });
});

describe('parseSocketEvent', () => {
  it('parses a JSON string as well as an object', () => {
    const asString = parseSocketEvent(JSON.stringify({ type: 'progress', data: { value: 1, max: 4 } }));
    expect(asString).toMatchObject({ kind: 'progress', value: 1, max: 4 });
  });

  it('treats a null node as end of execution', () => {
    expect(parseSocketEvent({ type: 'executing', data: { node: null } })).toMatchObject({
      kind: 'executing',
      node: null,
    });
  });

  it('recognizes both error shapes', () => {
    for (const type of ['execution_error', 'execution_interrupted']) {
      expect(parseSocketEvent({ type, data: {} })?.kind).toBe('execution-error');
    }
  });

  it('ignores unknown event types rather than failing', () => {
    // ComfyUI emits types this client does not model and adds more across versions; treating those as
    // errors would break generation on a server upgrade.
    expect(parseSocketEvent({ type: 'b_preview', data: {} })).toBeUndefined();
    expect(parseSocketEvent({ type: 'status', data: {} })).toBeUndefined();
  });

  it('ignores malformed messages', () => {
    for (const raw of [null, 42, 'not json', {}, { data: {} }]) {
      expect(parseSocketEvent(raw)).toBeUndefined();
    }
  });

  it('defaults missing progress numbers rather than producing NaN', () => {
    // A NaN fraction would render an empty progress bar with no clue why.
    const event = parseSocketEvent({ type: 'progress', data: {} });
    expect(event).toMatchObject({ kind: 'progress', value: 0, max: 0 });
  });
});

describe('the view query', () => {
  it('names the file', () => {
    expect(viewQuery({ filename: 'bed_0031.flac' })).toContain('filename=bed_0031.flac');
  });

  it('defaults to the output root, which is where a finished render lands', () => {
    expect(viewQuery({ filename: 'a.flac' })).toContain('type=output');
  });

  it('carries the subfolder a preview node writes into', () => {
    // Omitting it returns a 404 for a file that is there.
    expect(viewQuery({ filename: 'a.png', subfolder: 'previews' })).toContain('subfolder=previews');
  });

  it('omits an empty subfolder rather than sending a blank one', () => {
    expect(viewQuery({ filename: 'a.png', subfolder: '' })).not.toContain('subfolder=');
  });

  it('honours a temp output, which is served from a different root', () => {
    expect(viewQuery({ filename: 'a.png', type: 'temp' })).toContain('type=temp');
  });

  it('escapes a filename that needs it', () => {
    expect(viewQuery({ filename: 'take one.flac' })).toContain('filename=take+one.flac');
  });
});
