import { describe, expect, it } from 'vitest';
import {
  formatHealthLines,
  formatServerLines,
  isEnvironmentUnhealthy,
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
          rows: [row('db', 'healthy'), row('kong', 'healthy')],
        },
        'prod-standby': {
          kind: 'compose',
          ip: '2.2.2.2',
          rows: [row('db', 'healthy'), row('kong', 'healthy')],
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
            row('kong', 'unhealthy', 'exited', 'Exited (128) 3 hours ago'),
            row('x-setup', 'done'),
            row('rest', 'starting'),
          ],
        },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    containers ● 1/3 healthy',
      '      kong                        ● exited  Exited (128) 3 hours ago',
      '      rest                        ● starting  ',
    ]);
  });

  it('k8s rollup carries nodes and platform namespaces; a short namespace is an exception line', () => {
    const lines = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': {
          kind: 'k8s',
          ip: '1.1.1.1',
          rows: [row('app', 'healthy'), row('supabase-db-0', 'healthy')],
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
  it('renders the db/supabase detail from the real /ready shape', () => {
    const lines = formatHealthLines({
      url: 'https://x/api/health/ready',
      ok: true,
      status: 200,
      latencyMs: 42,
      data: {
        status: 'ready',
        timestamp: 't',
        services: { database: 'connected', supabase: 'connected' },
      },
    }).map(strip);
    expect(lines).toEqual([
      'Health',
      '  https://x/api/health/ready',
      '  ● healthy  42ms  (db: connected, supabase: connected, ready)',
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
