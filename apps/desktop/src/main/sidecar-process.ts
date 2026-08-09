import { randomBytes } from 'node:crypto';

/**
 * Sidecar launch policy.
 *
 * Separated from the spawning itself so every decision here is testable without starting a process:
 * how the token is generated, how it reaches the child, what the health URL is, and how long the
 * renderer waits before giving up.
 *
 * The security posture, restated because it is easy to erode by accident:
 *
 * - The sidecar binds **loopback only**. It serves arbitrary project files, so a port on any other
 *   interface would publish the user's project folder to the network.
 * - The token travels in the **environment**, never in argv. A command line is visible to every process
 *   on the machine through the process table; an environment variable is not.
 * - The token is generated per launch and never written to disk.
 */

/** Bytes of entropy in a sidecar token. 32 bytes is well past any brute-force concern on loopback. */
export const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface SidecarLaunchOptions {
  readonly projectRoot: string;
  readonly port: number;
  readonly token: string;
  /** Python to run. Defaults to the sidecar's own virtualenv when present. */
  readonly python?: string;
}

export interface SidecarCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The command that starts the sidecar.
 *
 * `--host 127.0.0.1` is passed explicitly rather than relied on as a default: a default that changes in
 * a future version would silently expose the project folder, and this is the one place that decision
 * should be visible.
 */
export function sidecarCommand(options: SidecarLaunchOptions): SidecarCommand {
  return {
    command: options.python ?? 'python3',
    args: [
      '-m',
      'nos_sidecar',
      '--project-root',
      options.projectRoot,
      '--host',
      '127.0.0.1',
      '--port',
      String(options.port),
      /*
       * The sidecar ends itself if this process dies without stopping it.
       *
       * `before-quit` and `window-all-closed` cover every ordinary close, and neither runs when the
       * shell is killed or crashes — after which the sidecar keeps its port, its memory and anything
       * the segmenter left in VRAM, forever. A development session that killed the shell repeatedly
       * left twenty-two of them behind, one holding a port an unrelated tool then failed to bind.
       *
       * It watches the stdin pipe for end-of-file, which the operating system produces when this
       * process goes away regardless of how it went. That is why `stdio` gives it a pipe it never
       * writes to rather than `ignore`.
       */
      '--exit-with-parent',
    ],
    env: {
      // Never argv: the process table is world-readable on every platform this runs on.
      NOS_SIDECAR_TOKEN: options.token,
      // Unbuffered, so a crash message reaches the log before the process dies.
      PYTHONUNBUFFERED: '1',
    },
  };
}

export function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export interface WaitOptions {
  /** Total time to wait before declaring the sidecar dead. */
  readonly timeoutMs?: number;
  /** Gap between attempts. */
  readonly intervalMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export const DEFAULT_START_TIMEOUT_MS = 15_000;

/**
 * Waits for the sidecar to answer.
 *
 * Polls rather than parsing stdout: the port being *listening* is the condition that matters, and a
 * readiness line printed before the socket is bound would produce a race that appears once a week on a
 * slow machine.
 *
 * `/health` is unauthenticated by design, so this needs no token and a failure here is unambiguous —
 * either the process is up or it is not.
 */
export async function waitForSidecar(port: number, options: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 150;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const response = await doFetch(healthUrl(port));
      if (response.ok) return true;
    } catch {
      // Connection refused while the process is still starting. Expected, not exceptional.
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * A port to try.
 *
 * Chosen from the ephemeral range rather than a fixed number so two projects can be open at once, and
 * so a stale sidecar from a crashed session does not make the next launch fail with a confusing
 * "address in use". The caller retries with a fresh pick if the bind fails.
 */
export function pickPort(random: () => number = Math.random): number {
  const low = 49_152;
  const high = 65_535;
  return low + Math.floor(random() * (high - low + 1));
}

/** A one-line reason a launch failed, fit to show in the window rather than only in a log. */
export function describeLaunchFailure(reason: 'timeout' | 'exited' | 'spawn-failed', detail = ''): string {
  switch (reason) {
    case 'timeout':
      return 'the media sidecar did not start in time — check that Python and ffmpeg are installed';
    case 'exited':
      return `the media sidecar exited during startup${detail === '' ? '' : `: ${detail}`}`;
    case 'spawn-failed':
      return `the media sidecar could not be started${detail === '' ? '' : `: ${detail}`}`;
    default: {
      const unreachable: never = reason;
      throw new Error(`Unhandled reason ${String(unreachable)}`);
    }
  }
}
