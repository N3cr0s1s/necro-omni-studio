/**
 * A WebSocket, read as a stream of messages.
 *
 * Written out rather than inlined because getting it wrong is invisible until it matters. The first
 * version woke only on a `message` event, so when the far end went away the loop parked on a promise
 * nothing would ever resolve. The consequence was not an error — it was a generator run that stayed
 * "running · 100%" for the rest of the session while ComfyUI, having restarted underneath it, sat idle
 * with an empty queue. No failure, no collection attempt, no way to clear it but cancelling.
 *
 * So the rule is: **every event that can end the stream must be able to wake it.** A close and an error
 * are as much a reason to return as a message is a reason to yield.
 *
 * Ending here is not the same as failing. The caller attempts collection afterwards either way, because
 * a socket that dropped after the last node ran is a job whose outputs are sitting in the backend's
 * history — and a run failed on the strength of a dropped socket would throw away work that finished.
 */

/** The part of a `WebSocket` this needs, so a test can supply one without a server. */
export interface MessageSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  close(): void;
}

export interface SocketMessages {
  messages(): AsyncIterable<unknown>;
  close(): void;
}

/** `WebSocket.CLOSED`, named rather than imported so this module does not need the DOM lib. */
const CLOSED = 3;

export function socketMessages(socket: MessageSocket): SocketMessages {
  return {
    async *messages(): AsyncIterable<unknown> {
      const pending: unknown[] = [];
      let done = false;
      // A single waiter, because there is a single consumer. Messages that arrive while it is not
      // waiting are held in `pending`, so nothing is dropped between iterations.
      let wake: (() => void) | undefined;

      const push = (event: { readonly data?: unknown }): void => {
        pending.push(event.data);
        wake?.();
      };
      const finish = (): void => {
        done = true;
        wake?.();
      };

      socket.addEventListener('message', push);
      socket.addEventListener('close', finish);
      socket.addEventListener('error', finish);

      try {
        for (;;) {
          // Drained before checking whether it is over: a close event usually arrives with messages
          // still queued, and the last of them is often the one saying the job finished.
          while (pending.length > 0) yield pending.shift();
          if (done || socket.readyState === CLOSED) return;

          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        // Also on an early `break` by the consumer. Without this every job would leave three listeners
        // on a socket that outlives it.
        socket.removeEventListener('message', push);
        socket.removeEventListener('close', finish);
        socket.removeEventListener('error', finish);
      }
    },
    close: () => socket.close(),
  };
}
