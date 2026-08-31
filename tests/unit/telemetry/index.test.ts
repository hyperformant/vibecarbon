import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordCommandStart,
  reportCrash,
  settlePendingTelemetry,
} from '../../../src/lib/telemetry/index.js';

let stateDir: string;
let cwd: string;
const fetchImpl = vi.fn();

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'vc-t-state-'));
  cwd = mkdtempSync(join(tmpdir(), 'vc-t-proj-'));
  fetchImpl.mockReset();
  fetchImpl.mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const manifest = {
  version: '1',
  projectName: 'secret-name',
  services: {},
  environments: { prod: { provider: 'hetzner', region: 'ash', deployMode: 'k8s-ha' } },
};

const opts = () => ({ env: {} as NodeJS.ProcessEnv, cwd, stateDir, fetchImpl });

describe('recordCommandStart', () => {
  it('POSTs the exact event payload — and nothing more', async () => {
    writeFileSync(join(cwd, '.vibecarbon.json'), JSON.stringify(manifest));
    recordCommandStart('deploy', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://vibecarbon.com/api/v1/telemetry/events');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual([
      'arch',
      'cli_version',
      'command',
      'deploy_target',
      'machine_id',
      'node_version',
      'platform',
      'project_id',
      'provider',
    ]);
    expect(body.command).toBe('deploy');
    expect(body.provider).toBe('hetzner');
    expect(body.deploy_target).toBe('k8s-ha');
    expect(body.node_version).toMatch(/^\d+\.\d+$/);
    expect(init.body).not.toContain('secret-name'); // project name never leaves
  });

  it('lazily writes a projectId into .vibecarbon.json and reuses it', async () => {
    writeFileSync(join(cwd, '.vibecarbon.json'), JSON.stringify(manifest));
    recordCommandStart('status', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(readFileSync(join(cwd, '.vibecarbon.json'), 'utf-8'));
    expect(saved.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).project_id).toBe(saved.projectId);
  });

  it('sends null project fields outside a project', async () => {
    recordCommandStart('create', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.project_id).toBeNull();
    expect(body.provider).toBeNull();
    expect(body.deploy_target).toBeNull();
  });

  it('sends nothing when analytics is disabled', async () => {
    recordCommandStart('deploy', { ...opts(), env: { DO_NOT_TRACK: '1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is silent when fetch rejects', async () => {
    fetchImpl.mockRejectedValue(new Error('offline'));
    expect(() => recordCommandStart('deploy', opts())).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('reportCrash', () => {
  it('POSTs a sanitized error payload to /errors', async () => {
    await reportCrash('deploy', new Error('boom'), opts());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://vibecarbon.com/api/v1/telemetry/errors');
    const body = JSON.parse(init.body);
    expect(body.error_name).toBe('Error');
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('resolves even when fetch hangs (2s cap)', async () => {
    // Real fetch() eventually settles a hung request once its AbortSignal
    // fires (post()'s own signal or, before that, this abort listener) —
    // mimic that here rather than a promise that never settles at all,
    // which would otherwise leak into pendingPosts across tests.
    fetchImpl.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const start = Date.now();
    await reportCrash('deploy', new Error('boom'), opts());
    expect(Date.now() - start).toBeLessThan(2500);
    // reportCrash's own 2s race gave up on the post but left it running,
    // same as it always has — clean it up the way cli.js's finally block
    // does in real usage, so it doesn't linger into later tests/assertions.
    await settlePendingTelemetry({ graceMs: 0 });
  }, 4000);

  it('does nothing when analytics is disabled', async () => {
    await reportCrash('deploy', new Error('boom'), { ...opts(), env: { CI: '1' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('settlePendingTelemetry', () => {
  it('aborts a hung post within ~graceMs and resolves', async () => {
    fetchImpl.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    recordCommandStart('deploy', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const start = Date.now();
    await settlePendingTelemetry({ graceMs: 50 });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('resolves promptly (without waiting the full grace) when the post already finished', async () => {
    recordCommandStart('deploy', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // Let the fast, already-resolved fetch settle before we call settle.
    await new Promise((r) => setTimeout(r, 10));

    const start = Date.now();
    await settlePendingTelemetry({ graceMs: 250 });
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('is a no-op (resolves immediately) when nothing is in flight', async () => {
    const start = Date.now();
    await settlePendingTelemetry();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('never rejects', async () => {
    fetchImpl.mockImplementation(() => new Promise(() => {}));
    recordCommandStart('deploy', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await expect(settlePendingTelemetry({ graceMs: 10 })).resolves.toBeUndefined();
  });
});
