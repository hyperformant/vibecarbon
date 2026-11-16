import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake API server: the TCP probe connects at once and https.request answers
// with the status and body the test sets.
const server = vi.hoisted(() => ({ status: 200, body: '{}' }));
const probe = vi.hoisted(() => ({ fail: false }));

vi.mock('node:fs', () => {
  const readFileSync = () => 'x';
  return { default: { readFileSync }, readFileSync };
});
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    setTimeout() {}
    connect(_port: number, _host: string, cb: () => void) {
      if (probe.fail) queueMicrotask(() => this.emit('error', new Error('refused')));
      else queueMicrotask(cb);
    }
    destroy() {}
  }
  return { default: { Socket }, Socket };
});
vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  const request = (_opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout() {},
      destroy() {},
      end() {
        const res = Object.assign(new EventEmitter(), { statusCode: server.status });
        cb(res);
        res.emit('data', Buffer.from(server.body));
        res.emit('end');
      },
    });
    return req;
  };
  return { default: { request }, request };
});

describe('k8sGetJson', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.43.0.1');
  });
  afterEach(() => {
    probe.fail = false;
    vi.unstubAllEnvs();
  });

  it('parses a 200 body', async () => {
    server.status = 200;
    server.body = '{"items":[]}';
    const { k8sGetJson } = await import('@server/lib/k8s-api');
    await expect(k8sGetJson('/api/v1/nodes')).resolves.toEqual({ items: [] });
  });

  it('rejects a 403 with its status, though the body is valid JSON', async () => {
    server.status = 403;
    server.body = '{"kind":"Status","code":403}';
    const { k8sGetJson, K8sApiError } = await import('@server/lib/k8s-api');
    const err = await k8sGetJson('/api/v1/nodes').catch((e) => e);
    expect(err).toBeInstanceOf(K8sApiError);
    expect(err.status).toBe(403);
  });

  it('retries the endpoint probe after a failed one', async () => {
    server.status = 200;
    server.body = '{"ok":true}';
    probe.fail = true;
    const { k8sGetJson } = await import('@server/lib/k8s-api');
    await expect(k8sGetJson('/api/v1/nodes')).rejects.toThrow();
    probe.fail = false;
    await expect(k8sGetJson('/api/v1/nodes')).resolves.toEqual({ ok: true });
  });
});
