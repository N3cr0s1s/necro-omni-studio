import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetPath, formatFrameRate } from '@nos/core';
import { DEFAULT_WAVEFORM } from '@nos/media';
import { type MediaClient, createMediaClient } from './media-client.js';
import { createTransport } from './transport.js';

/**
 * Integration test against the real Python sidecar and real ffmpeg.
 *
 * The unit tests cover the client's error mapping with an injected fetch; they cannot catch a
 * mismatch in the *contract* — a snake_case field renamed on one side, a spec key the sidecar
 * silently rejects, a rate string the parser will not accept. Only running both halves does, and
 * that class of bug is otherwise found by hand, at the UI, much later.
 *
 * Skipped when the sidecar venv or ffmpeg is absent, so a fresh checkout still has a green suite.
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const venvPython = join(repoRoot, 'apps/sidecar/.venv/bin/python');

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const runnable = existsSync(venvPython) && hasFfmpeg();

describe.skipIf(!runnable)('media client against the real sidecar', () => {
  let sidecar: ChildProcess;
  let client: MediaClient;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = join(tmpdir(), `nos-integration-${process.pid}`);
    for (const folder of ['media', 'notes']) {
      mkdirSync(join(projectRoot, folder), { recursive: true });
    }

    // 29.97 with audio: the rate whose exact rational must survive the round trip, and the case
    // that produces both a video and an audio stream.
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=30000/1001:duration=2',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.7*sin(2*PI*330*t)':d=2",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(projectRoot, 'media/clip.mp4'),
    ]);
    writeFileSync(join(projectRoot, 'notes/treatment.md'), '# Treatment\n', 'utf8');

    const token = 'integration-token';
    sidecar = spawn(venvPython, ['-m', 'nos_sidecar', '--project-root', projectRoot], {
      cwd: join(repoRoot, 'apps/sidecar'),
      env: { ...process.env, NOS_SIDECAR_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // The handshake line: the sidecar binds its own socket and reports the port before serving, so
    // there is no polling and no race against the bind.
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sidecar did not announce a port')), 30_000);
      let buffered = '';
      sidecar.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const newline = buffered.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(buffered.slice(0, newline)) as { event: string; port: number };
          if (parsed.event === 'listening') {
            clearTimeout(timer);
            resolve(parsed.port);
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      sidecar.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar exited early with code ${code}`));
      });
    });

    client = createMediaClient(
      createTransport({ baseUrl: `http://127.0.0.1:${port}`, token }, globalThis.fetch),
    );
  }, 60_000);

  afterAll(() => {
    sidecar?.kill();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reports health', async () => {
    const result = await client.health();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ffmpeg).toContain('ffmpeg');
      expect(result.value.projectRoot).toContain('nos-integration');
    }
  });

  it('probes a video into domain types, preserving the exact rate', async () => {
    const result = await client.probe(assetPath('media/clip.mp4'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metadata = result.value;
    expect(metadata.type).toBe('video');
    expect(metadata.video?.width).toBe(320);
    expect(metadata.video?.height).toBe(180);
    // The whole point of carrying rates as strings across the wire.
    expect(metadata.video && formatFrameRate(metadata.video.frameRate)).toBe('30000/1001');
    expect(metadata.video?.variableFrameRate).toBe(false);
    expect(metadata.audio?.channels).toBeGreaterThan(0);
    expect(metadata.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(metadata.durationSeconds).toBeGreaterThan(1.9);
  });

  it('probes a note without stream data', async () => {
    const result = await client.probe(assetPath('notes/treatment.md'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('text');
      expect(result.value.video).toBeUndefined();
    }
  });

  it('maps a missing asset to a not-found probe error', async () => {
    const result = await client.probe(assetPath('media/absent.mp4'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-found');
  });

  it('derives a proxy and reports the cache path', async () => {
    const spec = { kind: 'proxy', shortEdge: 90, frameRate: 30, quality: 28 } as const;
    const result = await client.ensure(assetPath('media/clip.mp4'), spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.path.startsWith('cache/proxy_90p30q28_')).toBe(true);
    expect(existsSync(join(projectRoot, result.value.path))).toBe(true);
  });

  it('agrees with the sidecar on the cache key, so peek finds the real file', async () => {
    // `peek` computes the key locally from the probed hash. If the two key formulas disagree, the
    // UI would look for a file that exists under a different name and re-derive forever.
    const spec = { kind: 'proxy', shortEdge: 90, frameRate: 30, quality: 28 } as const;
    const ensured = await client.ensure(assetPath('media/clip.mp4'), spec);
    const peeked = await client.peek(assetPath('media/clip.mp4'), spec);
    expect(ensured.ok).toBe(true);
    expect(peeked).toBeDefined();
    if (ensured.ok && peeked) expect(peeked.path).toBe(ensured.value.path);
  });

  it('derives a filmstrip', async () => {
    const result = await client.ensure(assetPath('media/clip.mp4'), {
      kind: 'filmstrip',
      thumbnailHeight: 20,
      thumbnailsPerSecond: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(existsSync(join(projectRoot, result.value.path))).toBe(true);
  });

  it('reads waveform peaks the Python side encoded', async () => {
    const result = await client.readWaveform(assetPath('media/clip.mp4'), DEFAULT_WAVEFORM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.channels).toBe(1);
    expect(result.value.bucketsPerSecond).toBe(DEFAULT_WAVEFORM.bucketsPerSecond);
    expect(result.value.peaks.length).toBeGreaterThan(0);
    // AAC round-trips the 0.7 tone with some loss, so this checks the order of magnitude rather
    // than an exact level — the exact-level assertion lives in the sidecar's own suite.
    const loudest = Math.max(...result.value.peaks);
    expect(loudest).toBeGreaterThan(0.3);
    expect(loudest).toBeLessThanOrEqual(1);
  });

  it('rejects a waveform for a source with no audio', async () => {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x64:rate=30:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(projectRoot, 'media/silent.mp4'),
    ]);
    const result = await client.readWaveform(assetPath('media/silent.mp4'), DEFAULT_WAVEFORM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('failed');
  });

  it('scans the project into FileEntry values with millisecond timestamps', async () => {
    const result = await client.scan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.value.map((entry) => entry.path);
    expect(paths).toContain('media/clip.mp4');
    expect(paths).toContain('notes/treatment.md');

    const clip = result.value.find((entry) => entry.path === 'media/clip.mp4');
    expect(clip?.isDirectory).toBe(false);
    expect(clip?.sizeBytes).toBeGreaterThan(0);
    // The sidecar reports seconds; the client converts, because every other timestamp in the
    // TypeScript codebase is milliseconds.
    expect(clip?.modifiedAt).toBeGreaterThan(1_600_000_000_000);
  });

  it('scopes a scan to a subtree', async () => {
    const result = await client.scan(assetPath('notes'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((entry) => entry.path)).toEqual(['notes/treatment.md']);
  });

  it('serves a file through a URL a media element can use', async () => {
    // The token travels as a query parameter here; this asserts the sidecar accepts that form.
    const url = client.fileUrl('notes/treatment.md');
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Treatment');
  });

  it('refuses a traversal path through the file URL', async () => {
    const response = await fetch(client.fileUrl('../../etc/passwd'));
    expect(response.status).toBe(400);
  });

  it('reports and clears the cache', async () => {
    await client.ensure(assetPath('media/clip.mp4'), {
      kind: 'proxy',
      shortEdge: 90,
      frameRate: 30,
      quality: 28,
    });
    expect(await client.cacheSize()).toBeGreaterThan(0);

    const cleared = await client.clearCache();
    expect(cleared.ok).toBe(true);
    expect(await client.cacheSize()).toBe(0);
    // Source media must be untouched by a cache clear.
    expect(readFileSync(join(projectRoot, 'notes/treatment.md'), 'utf8')).toContain('Treatment');
  });
});
