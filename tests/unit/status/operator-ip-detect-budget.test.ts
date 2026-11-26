/**
 * `status` detects the operator's address on a short budget: one attempt
 * per detector, each cut off by a timeout. fetchWithRetry's five attempts
 * with backoff per detector made an unreachable detector cost status about
 * 30 s before its first read. A deploy keeps the full retry: it cannot go on
 * without the address, while status only warns.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadProjectConfig } from '../../../src/lib/config.js';
import { ensureOperatorIpAccessWarnAll } from '../../../src/lib/operator-ip.js';
import { createTempDir } from '../../_shared/temp-dir.js';

let dir: string;
const fetchMock = vi.fn();

beforeEach(() => {
  dir = createTempDir('vc-status-detect-');
  const at = '2026-11-01T00:00:00.000Z';
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({
      projectName: 'demo',
      operatorCidrs: [{ cidr: '198.51.100.1/32', addedAt: at, lastUsedAt: at }],
      environments: {
        prod: {
          provider: 'hetzner',
          deployMode: 'compose',
          servers: [{ name: 'prod', ip: '192.0.2.1' }],
        },
      },
    }),
  );
  // Auto-detect, as on an operator's machine (the unit tier runs with CI=true).
  vi.stubEnv('CI', '');
  // Every detector unreachable, the way a transient network failure looks:
  // fetchWithRetry retries this one.
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new TypeError('fetch failed'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('status tries each detector once, with a timeout, and never waits out a backoff', async () => {
  const started = Date.now();
  await ensureOperatorIpAccessWarnAll({
    projectConfig: loadProjectConfig(dir),
    environments: ['prod'],
    yes: true,
    cwd: dir,
    tokenFor: () => 'token-hetzner',
    quickDetect: true,
  });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    'https://api.ipify.org',
    'https://icanhazip.com',
  ]);
  for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  // fetchWithRetry's first backoff alone is 1 s.
  expect(Date.now() - started).toBeLessThan(900);
});
