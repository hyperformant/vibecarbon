import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dnsSafeFetch } from '../../e2e/checks/health';

/** A request that never answers; `onSocket` drives what the socket reached. */
function hungRequest(onSocket: (req: EventEmitter) => void) {
  return (() => {
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => onSocket(req),
      destroy: () => {},
    });
    return req;
    // biome-ignore lint/suspicious/noExplicitAny: narrow stub for an injected seam
  }) as any;
}

function newSocket() {
  return Object.assign(new EventEmitter(), { connecting: true });
}

async function timeoutMessage(httpsRequest: unknown) {
  const pending = dnsSafeFetch(
    'https://app.example.com/api/health',
    {},
    // biome-ignore lint/suspicious/noExplicitAny: narrow stub for an injected seam
    { resolveIp: async () => '203.0.113.9', httpsRequest: httpsRequest as any },
  ).catch((err: Error) => err.message);
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

describe('a timed-out request says where it stalled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the connect when the socket never connected', async () => {
    const message = await timeoutMessage(
      hungRequest((req) => {
        req.emit('socket', newSocket());
      }),
    );
    expect(message).toBe('Request timed out after 10000ms (tcp connect)');
  });

  it('names the handshake when the socket connected but TLS never finished', async () => {
    const message = await timeoutMessage(
      hungRequest((req) => {
        const socket = newSocket();
        req.emit('socket', socket);
        socket.emit('connect');
      }),
    );
    expect(message).toBe('Request timed out after 10000ms (tls handshake)');
  });

  it('names the response when TLS finished and nothing came back', async () => {
    const message = await timeoutMessage(
      hungRequest((req) => {
        const socket = newSocket();
        req.emit('socket', socket);
        socket.emit('connect');
        socket.emit('secureConnect');
      }),
    );
    expect(message).toBe('Request timed out after 10000ms (response)');
  });

  it('names the response on a reused keep-alive socket, which emits neither event', async () => {
    const message = await timeoutMessage(
      hungRequest((req) => {
        req.emit('socket', Object.assign(new EventEmitter(), { connecting: false }));
      }),
    );
    expect(message).toBe('Request timed out after 10000ms (response)');
  });
});
