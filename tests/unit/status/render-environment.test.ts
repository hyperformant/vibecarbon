import { describe, expect, it } from 'vitest';
import {
  formatHealthLines,
  formatServerLines,
  isEnvironmentUnhealthy,
  storageSettleLine,
} from '../../../src/status.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const row = (container: string, health: string, label = health, detail = '') => ({
  name: container,
  container,
  health,
  label,
  detail,
  latencyMs: 0,
});
const servers = [
  { id: 'a', name: 'prod-primary', ip: '1.1.1.1', serverType: 'cpx31' },
  { id: 'b', name: 'prod-standby', ip: '2.2.2.2', serverType: 'cpx31' },
];

describe('formatServerLines', () => {
  it('healthy compose servers collapse to one rollup line each', () => {
    const lines = formatServerLines(servers, {
      containers: {
        'prod-primary': {
          kind: 'compose',
          ip: '1.1.1.1',
          rows: [row('db', 'healthy'), row('app', 'healthy')],
        },
        'prod-standby': {
          kind: 'compose',
          ip: '2.2.2.2',
          rows: [row('db', 'healthy'), row('app', 'healthy')],
        },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    containers ● 2/2 healthy',
      '  prod-standby     2.2.2.2         cpx31',
      '    containers ● 2/2 healthy',
    ]);
  });

  it('non-healthy rows expand under the rollup; done rows are neither counted nor shown', () => {
    const lines = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': {
          kind: 'compose',
          ip: '1.1.1.1',
          rows: [
            row('db', 'healthy'),
            row('app', 'unhealthy', 'exited', 'Exited (128) 3 hours ago'),
            row('x-setup', 'done'),
            row('traefik', 'starting'),
          ],
        },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    containers ● 1/3 healthy',
      '      app                         ● exited  Exited (128) 3 hours ago',
      '      traefik                     ● starting  ',
    ]);
  });

  it('k8s rollup carries nodes and platform namespaces; a short namespace is an exception line', () => {
    const lines = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': {
          kind: 'k8s',
          ip: '1.1.1.1',
          rows: [row('app', 'healthy'), row('db-0', 'healthy')],
          platform: {
            'flux-system': { healthy: 4, total: 4 },
            'cert-manager': { healthy: 2, total: 3 },
          },
          nodes: { ready: 3, total: 3 },
        },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    pods ● 2/2 healthy · nodes 3/3 ready · flux-system 4/4 · cert-manager 2/3',
      '      cert-manager                ○ 2/3 healthy  ',
    ]);
  });

  it('an ssh failure renders as unreachable in red', () => {
    const lines = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': { kind: 'compose', ip: '1.1.1.1', rows: [], error: 'ssh timeout' },
      },
    });
    expect(strip(lines[1])).toBe('    containers ● unreachable  ssh timeout');
    expect(lines[1]).toContain('\x1b[31m');
  });

  it('without containers data the server line stands alone (unchanged behaviour)', () => {
    expect(formatServerLines([servers[0]], {}).map(strip)).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
    ]);
  });

  it('keeps the provider status when serverInfo is present', () => {
    const lines = formatServerLines([servers[0]], {
      serverInfo: { a: { status: 'running', serverType: 'cpx31' } },
      containers: {
        'prod-primary': { kind: 'compose', ip: '1.1.1.1', rows: [row('db', 'healthy')] },
      },
    }).map(strip);
    expect(lines[0]).toBe('  prod-primary     1.1.1.1         ● running  cpx31');
  });

  it('colours the rollup green when all healthy, yellow otherwise', () => {
    const ok = formatServerLines([servers[0]], {
      containers: { 'prod-primary': { kind: 'compose', ip: '', rows: [row('db', 'healthy')] } },
    });
    const bad = formatServerLines([servers[0]], {
      containers: { 'prod-primary': { kind: 'compose', ip: '', rows: [row('db', 'starting')] } },
    });
    expect(ok[1]).toContain('\x1b[32m');
    expect(bad[1]).toContain('\x1b[33m');
    const nodesShort = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': {
          kind: 'k8s',
          ip: '',
          rows: [row('app', 'healthy')],
          platform: {},
          nodes: { ready: 2, total: 3 },
        },
      },
    });
    expect(nodesShort[1]).toContain('\x1b[33m');
  });
});

describe('formatHealthLines', () => {
  it('renders the db detail from the real /ready shape', () => {
    const lines = formatHealthLines({
      url: 'https://x/api/health/ready',
      ok: true,
      status: 200,
      latencyMs: 42,
      data: {
        status: 'ready',
        timestamp: 't',
        services: { database: 'connected' },
      },
    }).map(strip);
    expect(lines).toEqual([
      'Health',
      '  https://x/api/health/ready',
      '  ● healthy  42ms  (db: connected, ready)',
    ]);
  });
  it('renders a failed probe with its error or status', () => {
    expect(
      formatHealthLines({ url: 'u', ok: false, status: 503, latencyMs: 0 }).map(strip)[2],
    ).toBe('  ● unhealthy  (HTTP 503)');
    expect(
      formatHealthLines({ url: 'u', ok: false, error: 'timeout', latencyMs: 0 }).map(strip)[2],
    ).toBe('  ● unhealthy  (timeout)');
  });
});

describe('isEnvironmentUnhealthy', () => {
  const healthyEntry = {
    config: {},
    checks: {
      remoteHealth: { ok: true },
      containers: {
        p: {
          kind: 'k8s',
          ip: '',
          rows: [row('app', 'healthy'), row('job', 'done')],
          platform: { 'flux-system': { healthy: 1, total: 1 } },
          nodes: { ready: 1, total: 1 },
        },
      },
    },
  };
  it('is false when the probe is ok and every server is clean', () => {
    expect(isEnvironmentUnhealthy(healthyEntry)).toBe(false);
  });
  it('is true on probe failure', () => {
    expect(
      isEnvironmentUnhealthy({
        ...healthyEntry,
        checks: { ...healthyEntry.checks, remoteHealth: { ok: false } },
      }),
    ).toBe(true);
  });
  it('is true on a non-healthy row, a platform shortfall, a node shortfall, or an ssh error', () => {
    const with_ = (server: object) => ({
      ...healthyEntry,
      checks: { ...healthyEntry.checks, containers: { p: server } },
    });
    expect(
      isEnvironmentUnhealthy(with_({ kind: 'compose', ip: '', rows: [row('db', 'starting')] })),
    ).toBe(true);
    expect(
      isEnvironmentUnhealthy(
        with_({
          kind: 'k8s',
          ip: '',
          rows: [],
          platform: { 'cert-manager': { healthy: 2, total: 3 } },
          nodes: { ready: 1, total: 1 },
        }),
      ),
    ).toBe(true);
    expect(
      isEnvironmentUnhealthy(
        with_({ kind: 'k8s', ip: '', rows: [], platform: {}, nodes: { ready: 0, total: 1 } }),
      ),
    ).toBe(true);
    expect(
      isEnvironmentUnhealthy(with_({ kind: 'compose', ip: '', rows: [], error: 'ssh timeout' })),
    ).toBe(true);
  });
  it('is false with no containers data and an ok probe (pre-existing behaviour)', () => {
    expect(isEnvironmentUnhealthy({ config: {}, checks: { remoteHealth: { ok: true } } })).toBe(
      false,
    );
    expect(isEnvironmentUnhealthy({ config: {}, checks: {} })).toBe(false);
  });
});

describe('storageSettleLine (R5: age-based, no network)', () => {
  const MIN = 60_000;
  const now = Date.parse('2026-10-20T12:00:00Z');
  const env = (provider: string, ageMs: number | null) => ({
    provider,
    s3: {
      bucket: 'p-abc-storage',
      bucketCreatedAt: ageMs === null ? null : new Date(now - ageMs).toISOString(),
    },
  });

  it('a Hetzner bucket 4 minutes old shows the minutes left', async () => {
    await expect(storageSettleLine(env('hetzner', 4 * MIN), now)).resolves.toBe(
      'storage settling (about 16 min left)',
    );
  });

  it('a Hetzner bucket 30 minutes old shows no row', async () => {
    await expect(storageSettleLine(env('hetzner', 30 * MIN), now)).resolves.toBeNull();
  });

  it('a Hetzner bucket of unknown age shows settling with no estimate', async () => {
    await expect(storageSettleLine(env('hetzner', null), now)).resolves.toBe('storage settling');
  });

  it('a DigitalOcean bucket 1 minute old shows no row (0 window)', async () => {
    await expect(storageSettleLine(env('digitalocean', MIN), now)).resolves.toBeNull();
  });

  it('a Hetzner env deployed before creation times were recorded (no key) shows no row', async () => {
    await expect(
      storageSettleLine({ provider: 'hetzner', s3: { bucket: 'p-abc-storage' } }, now),
    ).resolves.toBeNull();
  });

  it('an env with no bucket shows no row', async () => {
    await expect(storageSettleLine({ provider: 'hetzner' }, now)).resolves.toBeNull();
  });
});

/**
 * Add-ons start in the background after the core stack (services/
 * addon-start.js), so a deploy can finish with one still starting or failed.
 * status shows each one's state, and a failed one with its reason; a failed
 * add-on makes the environment need attention, a starting one does not.
 */
describe('formatServerLines: background add-ons', () => {
  const sc = (addons: Array<{ name: string; state: string; reason: string }>) => ({
    containers: {
      'prod-primary': {
        kind: 'compose',
        ip: '1.1.1.1',
        rows: [row('db', 'healthy'), row('app', 'healthy')],
        addons,
      },
    },
  });

  it('all running: one rollup line', () => {
    const lines = formatServerLines(
      [servers[0]],
      sc([
        { name: 'observability', state: 'running', reason: '' },
        { name: 'n8n', state: 'running', reason: '' },
      ]),
    ).map(strip);
    expect(lines).toContain('    add-ons ● 2/2 running');
  });

  it('starting and failed add-ons get their own line, a failure with its reason', () => {
    const checks = sc([
      { name: 'observability', state: 'starting', reason: '' },
      { name: 'n8n', state: 'failed', reason: 'did not become healthy: n8n exited (1)' },
    ]);
    const lines = formatServerLines([servers[0]], checks).map(strip);
    expect(lines).toContain('    add-ons ● 0/2 running');
    expect(lines).toContain('      observability               ● starting  ');
    expect(lines).toContain(
      '      n8n                         ● failed  did not become healthy: n8n exited (1)',
    );
    expect(isEnvironmentUnhealthy({ checks })).toBe(true);
  });

  it('starting alone does not make the environment unhealthy', () => {
    const checks = sc([{ name: 'observability', state: 'starting', reason: '' }]);
    expect(isEnvironmentUnhealthy({ checks })).toBe(false);
  });
});
