import { describe, expect, it } from 'vitest';
import {
  type ComfyUiSocket,
  type ComfyUiTransport,
  createComfyUiBackend,
  parseSocketEvent,
} from './comfyui-backend.js';

/** A transport whose responses the test scripts, so no server is needed. */
function fakeTransport(
  routes: Record<string, unknown>,
  messages: readonly unknown[] = [],
): ComfyUiTransport & { readonly calls: string[]; readonly closed: number } {
  const calls: string[] = [];
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
    get closed() {
      return state.closed;
    },
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
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

const backendWith = (transport: ComfyUiTransport) =>
  createComfyUiBackend({
    endpoint: { baseUrl: 'http://localhost:8188' },
    transport,
    clientId: 'client-1',
  });

describe('submit', () => {
  it('posts the graph and returns the prompt id', async () => {
    const transport = fakeTransport({ '/prompt': { prompt_id: 'abc123' } });
    const result = await backendWith(transport).submit({ graph: { '1': {} }, assets: [] });

    expect(result).toEqual({ ok: true, value: 'abc123' });
    expect(transport.calls.some((call) => call.startsWith('POST http://localhost:8188/prompt'))).toBe(true);
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
    const result = await backendWith(fakeTransport({ '/history/': history })).collect('job1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ key: '57', type: 'audio', path: 'generated/bed_0031.flac' }]);
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
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] } } },
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
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] } } },
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
