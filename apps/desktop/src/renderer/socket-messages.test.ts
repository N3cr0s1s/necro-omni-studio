import { describe, expect, it } from 'vitest';
import { type MessageSocket, socketMessages } from './socket-messages.js';

/**
 * Reading a socket to its end.
 *
 * Every test here is about *ending*, because that is where the damage was. A stream that never ends
 * leaves the run driving it "running" forever: no error, no collection, and nothing on screen to say
 * the backend it was waiting on had gone.
 */

/** A socket a test drives by hand. */
function fakeSocket(): MessageSocket & {
  send(data: unknown): void;
  fire(type: 'close' | 'error'): void;
  readonly listenerCount: number;
  state: number;
} {
  const listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  const self = {
    state: 1,
    get readyState() {
      return self.state;
    },
    get listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      listeners.get(type)?.delete(listener);
    },
    close() {
      self.state = 3;
      self.fire('close');
    },
    send(data: unknown) {
      for (const listener of listeners.get('message') ?? []) listener({ data });
    },
    fire(type: 'close' | 'error') {
      for (const listener of listeners.get(type) ?? []) listener({});
    },
  };
  return self;
}

/** Collects the stream in the background so a test can drive the socket while it reads. */
function collect(stream: AsyncIterable<unknown>): { readonly seen: unknown[]; done: Promise<void> } {
  const seen: unknown[] = [];
  const done = (async () => {
    for await (const message of stream) seen.push(message);
  })();
  return { seen, done };
}

/** Lets pending microtasks run, which is what a real await between messages does. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('reading messages', () => {
  it('yields them in the order they arrived', async () => {
    const socket = fakeSocket();
    const reader = collect(socketMessages(socket).messages());

    await settle();
    socket.send('a');
    socket.send('b');
    await settle();
    socket.close();
    await reader.done;

    expect(reader.seen).toEqual(['a', 'b']);
  });

  it('holds on to messages that arrive while nothing is waiting', async () => {
    // Two events in the same tick: the consumer is awaiting one promise, not two.
    const socket = fakeSocket();
    const reader = collect(socketMessages(socket).messages());

    await settle();
    socket.send(1);
    socket.send(2);
    socket.send(3);
    await settle();
    socket.close();
    await reader.done;

    expect(reader.seen).toEqual([1, 2, 3]);
  });
});

describe('ending', () => {
  it('ends when the socket closes', async () => {
    // The case that hung. Nothing woke the loop on a close, so a run whose backend went away stayed
    // "running" for the rest of the session.
    const socket = fakeSocket();
    const reader = collect(socketMessages(socket).messages());

    await settle();
    socket.close();

    await expect(reader.done).resolves.toBeUndefined();
  });

  it('ends when the socket errors', async () => {
    const socket = fakeSocket();
    const reader = collect(socketMessages(socket).messages());

    await settle();
    socket.fire('error');

    await expect(reader.done).resolves.toBeUndefined();
  });

  it('ends immediately for a socket that has already closed', async () => {
    const socket = fakeSocket();
    socket.state = 3;

    const reader = collect(socketMessages(socket).messages());
    await expect(reader.done).resolves.toBeUndefined();
    expect(reader.seen).toEqual([]);
  });

  it('delivers what was queued before it ends', async () => {
    // A close usually arrives with messages still queued, and the last of them is often the one
    // saying the job finished. Dropping it would lose the outputs.
    const socket = fakeSocket();
    const reader = collect(socketMessages(socket).messages());

    await settle();
    socket.send('last event');
    socket.close();
    await reader.done;

    expect(reader.seen).toEqual(['last event']);
  });
});

describe('cleaning up', () => {
  it('lets go of the socket when the stream ends', async () => {
    const socket = fakeSocket();
    const reader = collect(socketMessages(socket).messages());

    await settle();
    expect(socket.listenerCount).toBe(3);
    socket.close();
    await reader.done;

    expect(socket.listenerCount).toBe(0);
  });

  it('lets go when the consumer stops early', async () => {
    // Every job opens one of these. Three listeners left behind per run accumulate for the session.
    const socket = fakeSocket();
    const stream = socketMessages(socket).messages();

    const reading = (async () => {
      for await (const message of stream) {
        void message;
        break;
      }
    })();

    await settle();
    socket.send('one');
    await reading;

    expect(socket.listenerCount).toBe(0);
  });
});
