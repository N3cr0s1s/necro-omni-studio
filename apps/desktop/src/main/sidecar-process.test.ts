import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_START_TIMEOUT_MS,
  baseUrl,
  describeLaunchFailure,
  generateToken,
  healthUrl,
  pickPort,
  sidecarCommand,
  waitForSidecar,
} from './sidecar-process.js';

const options = { projectRoot: '/home/u/My Project', port: 51234, token: 'secret-token' };

describe('the launch command', () => {
  it('passes the token in the environment, never in argv', () => {
    // A command line is visible to every process on the machine through the process table. This is the
    // single most important assertion in this file.
    const { args, env } = sidecarCommand(options);

    expect(args.join(' ')).not.toContain('secret-token');
    expect(env['NOS_SIDECAR_TOKEN']).toBe('secret-token');
  });

  it('binds to loopback explicitly', () => {
    // The sidecar serves arbitrary project files. Relying on a default that could change in a future
    // version would silently publish the user's project folder to the network.
    const { args } = sidecarCommand(options);
    expect(args).toContain('--host');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
  });

  it('passes the project root as one argument, spaces and all', () => {
    // Splitting on whitespace here would open "/home/u/My" — which usually does not exist, producing a
    // failure that looks like a permissions problem.
    const { args } = sidecarCommand(options);
    expect(args).toContain('/home/u/My Project');
  });

  it('runs the sidecar as a module', () => {
    const { args } = sidecarCommand(options);
    expect(args.slice(0, 2)).toEqual(['-m', 'nos_sidecar']);
  });

  it('uses the interpreter it is given', () => {
    expect(sidecarCommand({ ...options, python: '/venv/bin/python' }).command).toBe('/venv/bin/python');
  });

  it('tells the sidecar to end itself if this process dies', () => {
    // `before-quit` and `window-all-closed` cover every ordinary close and none of the others. Without
    // this a killed or crashed shell leaves a sidecar holding its port, its memory and whatever the
    // segmenter left in VRAM — a session that killed the shell repeatedly left twenty-two behind, one
    // of them squatting on a port an unrelated tool then failed to bind.
    expect(sidecarCommand(options).args).toContain('--exit-with-parent');
  });

  it('unbuffers python output, so a crash message arrives before the process dies', () => {
    expect(sidecarCommand(options).env['PYTHONUNBUFFERED']).toBe('1');
  });
});

describe('tokens', () => {
  it('is different every launch', () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it('is URL-safe, since it also travels as a query parameter for media elements', () => {
    // `<video src>` cannot send a header, so the token reaches `/media/file` in the URL. A `+` or `/`
    // in it would be mangled by the time it arrived.
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries enough entropy to be worth having', () => {
    expect(generateToken().length).toBeGreaterThanOrEqual(40);
  });
});

describe('addresses', () => {
  it('always names loopback by address, never by hostname', () => {
    // `localhost` can resolve to an IPv6 address the sidecar is not listening on, which presents as an
    // intermittent connection refusal on some machines and not others.
    expect(healthUrl(1234)).toBe('http://127.0.0.1:1234/health');
    expect(baseUrl(1234)).toBe('http://127.0.0.1:1234');
  });

  it('picks a port from the ephemeral range', () => {
    for (const random of [0, 0.5, 0.999_999]) {
      const port = pickPort(() => random);
      expect(port).toBeGreaterThanOrEqual(49_152);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });
});

describe('waiting for readiness', () => {
  const sleep = () => Promise.resolve();

  it('returns as soon as health answers', async () => {
    const fetch = vi.fn(async () => ({ ok: true }) as Response);
    await expect(waitForSidecar(1234, { fetch, sleep })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps trying while the connection is refused', async () => {
    // Expected, not exceptional: the process is up but the socket is not bound yet.
    let attempts = 0;
    const fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return { ok: true } as Response;
    });

    await expect(waitForSidecar(1234, { fetch, sleep })).resolves.toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up at the deadline rather than hanging the launch', async () => {
    let clock = 0;
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const ready = await waitForSidecar(1234, {
      fetch,
      sleep: async () => {
        clock += 150;
      },
      now: () => clock,
      timeoutMs: 600,
    });

    expect(ready).toBe(false);
  });

  it('treats a non-ok response as not ready yet', async () => {
    let clock = 0;
    const fetch = vi.fn(async () => ({ ok: false }) as Response);
    const ready = await waitForSidecar(1234, {
      fetch,
      sleep: async () => {
        clock += 150;
      },
      now: () => clock,
      timeoutMs: 300,
    });
    expect(ready).toBe(false);
  });

  it('polls health, which needs no token', async () => {
    // Deliberate: an authenticated readiness check would make a token mismatch look like a dead
    // sidecar, and the two need very different responses.
    const fetch = vi.fn(async () => ({ ok: true }) as Response);
    await waitForSidecar(51_234, { fetch, sleep });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:51234/health');
  });

  it('waits long enough for a cold Python start', () => {
    // Importing FastAPI and probing ffmpeg is seconds on a cold filesystem cache.
    expect(DEFAULT_START_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('failure messages', () => {
  it('says what to check rather than only that something failed', () => {
    expect(describeLaunchFailure('timeout')).toContain('Python');
  });

  it('carries the child´s own diagnostics through', () => {
    // The difference between "it didn't start" and "ffmpeg is missing" is this string.
    expect(describeLaunchFailure('exited', 'ffmpeg not found')).toContain('ffmpeg not found');
  });

  it('reads sensibly with no detail', () => {
    expect(describeLaunchFailure('spawn-failed')).not.toContain(':');
  });
});
