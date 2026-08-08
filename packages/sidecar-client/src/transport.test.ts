import { describe, expect, it, vi } from 'vitest';
import {
  type FetchLike,
  type FetchLikeResponse,
  createTransport,
  describeTransportError,
} from './transport.js';

const endpoint = { baseUrl: 'http://127.0.0.1:43101', token: 'secret-token' };

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function binaryResponse(status: number, bytes: Uint8Array): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => '',
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

describe('request shape', () => {
  it('sends the token header and a JSON body', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { ok: 1 }));
    const transport = createTransport(endpoint, fetchImpl);

    await transport.postJson('/media/probe', { asset: 'media/a.mp4' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:43101/media/probe');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.['X-Nos-Token']).toBe('secret-token');
    expect(init?.headers?.['content-type']).toBe('application/json');
    expect(init?.body).toBe('{"asset":"media/a.mp4"}');
  });

  it('omits the content-type header when there is no body', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const transport = createTransport(endpoint, fetchImpl);

    await transport.getJson('/cache/stats');

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe('GET');
    expect(init?.headers?.['content-type']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('returns the parsed payload on success', async () => {
    const transport = createTransport(endpoint, async () => jsonResponse(200, { size_bytes: 42 }));
    const result = await transport.getJson<{ size_bytes: number }>('/cache/stats');
    expect(result).toEqual({ ok: true, value: { size_bytes: 42 } });
  });

  it('reads a binary payload', async () => {
    const transport = createTransport(endpoint, async () =>
      binaryResponse(200, new Uint8Array([1, 2, 3, 4])),
    );
    const result = await transport.getBinary('/media/file?asset=x');
    expect(result.ok).toBe(true);
    if (result.ok) expect(new Uint8Array(result.value)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('error mapping', () => {
  it('maps 401 to unauthorized before attempting to read a body', async () => {
    const transport = createTransport(endpoint, async () => jsonResponse(401, { detail: 'nope' }));
    const result = await transport.getJson('/cache/stats');
    expect(result).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('preserves the structured error body so callers can branch on kind', async () => {
    const transport = createTransport(endpoint, async () =>
      jsonResponse(404, { kind: 'not-found', detail: 'media/x.mp4 does not exist' }),
    );
    const result = await transport.postJson('/media/probe', {});
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'rejected') {
      expect(result.error.status).toBe(404);
      expect(result.error.body.kind).toBe('not-found');
      expect(result.error.body.detail).toContain('does not exist');
    }
  });

  it('keeps a FastAPI validation body, which names the offending field', async () => {
    // FastAPI uses `detail` as an array for its own validation errors. Discarding it would lose the
    // only information that says which field was wrong.
    const transport = createTransport(endpoint, async () =>
      jsonResponse(422, { detail: [{ loc: ['body', 'asset'], msg: 'Field required' }] }),
    );
    const result = await transport.postJson('/media/probe', {});
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'rejected') {
      expect(result.error.body.kind).toBe('invalid-request');
      expect(result.error.body.detail).toContain('Field required');
    }
  });

  it('falls back when an error body is not readable', async () => {
    const transport = createTransport(endpoint, async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('empty');
      },
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const result = await transport.getJson('/cache/stats');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'rejected') {
      expect(result.error.body.detail).toBe('HTTP 500');
    }
  });

  it('reports a dead sidecar as unreachable', async () => {
    const transport = createTransport(endpoint, async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await transport.getJson('/health');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'unreachable') {
      expect(result.error.detail).toContain('ECONNREFUSED');
    }
  });

  it('reports an unparseable success body as malformed', async () => {
    const transport = createTransport(endpoint, async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected token');
      },
      text: async () => 'not json',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const result = await transport.getJson('/health');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('malformed-response');
  });
});

describe('cancellation and timeout', () => {
  it('reports a caller abort as aborted, not as a failure', async () => {
    const controller = new AbortController();
    const transport = createTransport(endpoint, async (_url, init) => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      void init;
      throw error;
    });

    const result = await transport.postJson('/media/derive', {}, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: { kind: 'aborted' } });
  });

  it('distinguishes a timeout from a cancellation', async () => {
    // Both arrive as an AbortError from fetch. Conflating them would make a hung ffmpeg look like
    // the user cancelled, and the UI would silently drop the operation instead of reporting it.
    const transport = createTransport(endpoint, async (_url, init) => {
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    const result = await transport.getJson('/health', { timeoutMs: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'unreachable') {
      expect(result.error.detail).toContain('timed out');
    } else {
      throw new Error(`expected a timeout, got ${JSON.stringify(result)}`);
    }
  });

  it('passes an abort signal through to fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const transport = createTransport(endpoint, fetchImpl);

    await transport.postJson('/media/derive', {}, { signal: controller.signal });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.signal).toBeDefined();
    expect(init?.signal?.aborted).toBe(false);
  });

  it('does not leave a timer running after a fast success', async () => {
    // A leaked timer would keep the Node event loop alive and hang a CLI or a test run.
    vi.useFakeTimers();
    try {
      const transport = createTransport(endpoint, async () => jsonResponse(200, {}));
      await transport.getJson('/health', { timeoutMs: 1_000 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fileUrl', () => {
  it('builds a URL carrying the token, since media elements cannot send headers', () => {
    const transport = createTransport(endpoint, async () => jsonResponse(200, {}));
    const url = new URL(transport.fileUrl('media/interview_a.mp4'));
    expect(url.pathname).toBe('/media/file');
    expect(url.searchParams.get('asset')).toBe('media/interview_a.mp4');
    expect(url.searchParams.get('token')).toBe('secret-token');
  });

  it('escapes paths with spaces and non-ASCII characters', () => {
    const transport = createTransport(endpoint, async () => jsonResponse(200, {}));
    const url = new URL(transport.fileUrl('media/felvétel a.mp4'));
    expect(url.searchParams.get('asset')).toBe('media/felvétel a.mp4');
    expect(url.href).not.toContain(' ');
  });
});

describe('describeTransportError', () => {
  it('produces a message for every kind', () => {
    for (const error of [
      { kind: 'unreachable', detail: 'ECONNREFUSED' },
      { kind: 'aborted' },
      { kind: 'unauthorized' },
      { kind: 'rejected', status: 404, body: { kind: 'not-found', detail: 'gone' } },
      { kind: 'malformed-response', detail: 'bad json' },
    ] as const) {
      expect(describeTransportError(error).length).toBeGreaterThan(0);
    }
  });

  it('surfaces the sidecar detail verbatim for a rejection', () => {
    expect(
      describeTransportError({
        kind: 'rejected',
        status: 400,
        body: { kind: 'invalid-path', detail: 'path must not escape the project folder' },
      }),
    ).toBe('path must not escape the project folder');
  });
});
