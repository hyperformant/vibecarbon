import { describe, expect, it, vi } from 'vitest';
import {
  checkDockerContainers,
  classifyContainer,
  formatDockerServiceLines,
  parseKongHostPort,
} from '../../../src/status.js';

describe('classifyContainer', () => {
  it('maps a running container with a passing healthcheck to healthy', () => {
    expect(classifyContainer('auth', 'running', 'Up 15 minutes (healthy)')).toEqual({
      health: 'healthy',
      label: 'healthy',
      detail: '',
    });
  });

  it('maps a running container with a failing healthcheck to unhealthy', () => {
    expect(classifyContainer('auth', 'running', 'Up 15 minutes (unhealthy)')).toEqual({
      health: 'unhealthy',
      label: 'unhealthy',
      detail: '',
    });
  });

  it('maps a running container whose healthcheck is still starting to starting', () => {
    expect(classifyContainer('db', 'running', 'Up 3 seconds (health: starting)')).toEqual({
      health: 'starting',
      label: 'starting',
      detail: '',
    });
  });

  it('counts a running container with no healthcheck as healthy, labelled running', () => {
    expect(classifyContainer('traefik', 'running', 'Up 15 minutes')).toEqual({
      health: 'healthy',
      label: 'running',
      detail: '',
    });
  });

  it('reports an exited container as unhealthy with the Docker status as detail', () => {
    expect(classifyContainer('kong', 'exited', 'Exited (128) 24 minutes ago')).toEqual({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 24 minutes ago',
    });
  });

  it('treats a *-setup one-shot container that exited 0 as done', () => {
    expect(classifyContainer('metabase-setup', 'exited', 'Exited (0) 2 hours ago')).toEqual({
      health: 'done',
      label: 'done',
      detail: '',
    });
  });

  it('treats a *-setup one-shot container that exited non-zero as unhealthy', () => {
    expect(classifyContainer('n8n-setup', 'exited', 'Exited (1) 2 hours ago')).toEqual({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (1) 2 hours ago',
    });
  });

  it('does not treat a core service that exited 0 as done', () => {
    expect(classifyContainer('db', 'exited', 'Exited (0) 5 minutes ago').health).toBe('unhealthy');
  });

  it('reports restarting as unhealthy with the Docker status as detail', () => {
    expect(classifyContainer('realtime', 'restarting', 'Restarting (1) 5 seconds ago')).toEqual({
      health: 'unhealthy',
      label: 'restarting',
      detail: 'Restarting (1) 5 seconds ago',
    });
  });

  it('reports any other state (created, paused, dead) as unhealthy labelled by state', () => {
    expect(classifyContainer('app', 'created', 'Created')).toEqual({
      health: 'unhealthy',
      label: 'created',
      detail: 'Created',
    });
    expect(classifyContainer('app', 'paused', 'Up 2 minutes (Paused)').label).toBe('paused');
  });

  it('reports a line with no state as unknown instead of an empty label', () => {
    expect(classifyContainer('foo', '', '')).toEqual({
      health: 'unknown',
      label: 'unknown',
      detail: '',
    });
  });
});

describe('parseKongHostPort', () => {
  it('returns the host port from docker port output', () => {
    expect(parseKongHostPort('0.0.0.0:8000\n[::]:8000\n')).toBe(8000);
  });

  it('honours a non-default binding', () => {
    expect(parseKongHostPort('0.0.0.0:8100\n')).toBe(8100);
  });

  it('returns null for empty output (container not running)', () => {
    expect(parseKongHostPort('')).toBeNull();
    expect(parseKongHostPort(null)).toBeNull();
  });

  it('returns null for unparseable output', () => {
    expect(parseKongHostPort('Error: No such container: letsgo-kong')).toBeNull();
  });
});

// Build a runCommand stub keyed on the docker subcommand. `docker ps -a`
// returns the tab-separated listing; `docker port` returns the binding.
function fakeDocker({ ps = '', port = '' }: { ps?: string; port?: string }) {
  return vi.fn((argv: string[]) => {
    if (argv[1] === 'ps') return ps;
    if (argv[1] === 'port') return port;
    throw new Error(`unexpected docker call: ${argv.join(' ')}`);
  });
}

function okFetch(status = 200) {
  return vi.fn(async () => ({ status })) as unknown as typeof fetch;
}

const LETSGO_PS = [
  'letsgo-storage\trunning\tUp 15 minutes (healthy)',
  'letsgo-studio\trunning\tUp 15 minutes (healthy)',
  'letsgo-auth\trunning\tUp 15 minutes (healthy)',
  'letsgo-realtime\trunning\tUp 15 minutes (healthy)',
  'letsgo-meta\trunning\tUp 15 minutes',
  'letsgo-app\trunning\tUp 15 minutes',
  'letsgo-rest\trunning\tUp 15 minutes',
  'letsgo-imgproxy\trunning\tUp 15 minutes (healthy)',
  'letsgo-kong\texited\tExited (128) 24 minutes ago',
  'letsgo-db\trunning\tUp 15 minutes (healthy)',
  'letsgo-traefik\trunning\tUp 15 minutes',
  // A different project sharing the host — must be ignored.
  'vibecarbon-kong\trunning\tUp 20 minutes (healthy)',
  'vibecarbon-auth\trunning\tUp 20 minutes (healthy)',
].join('\n');

describe('checkDockerContainers', () => {
  it('lists every container of the project, including exited ones, in core order', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.map((r) => r.container)).toEqual([
      'traefik',
      'db',
      'kong',
      'auth',
      'rest',
      'realtime',
      'storage',
      'imgproxy',
      'meta',
      'studio',
      'app',
    ]);
    const kong = rows.find((r) => r.container === 'kong');
    expect(kong).toMatchObject({
      name: 'Kong Gateway',
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 24 minutes ago',
    });
    expect(rows.find((r) => r.container === 'auth')).toMatchObject({
      name: 'Auth (GoTrue)',
      health: 'healthy',
    });
  });

  it('ignores containers belonging to other projects', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS }),
      fetch: okFetch(),
    });
    expect(rows.some((r) => r.name.includes('vibecarbon'))).toBe(false);
    expect(rows.filter((r) => r.container === 'kong')).toHaveLength(1);
  });

  it('marks gateway-probed services unknown when kong is not running', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unknown',
      label: 'unknown',
      detail: 'gateway down',
    });
    expect(rows.find((r) => r.container === 'meta')).toMatchObject({ health: 'unknown' });
  });

  it('probes rest and meta through the host port kong actually bound', async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
    );
    const fetchSpy = okFetch(401);
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8100\n[::]:8100\n' }),
      fetch: fetchSpy,
    });
    const urls = fetchSpy.mock.calls.map((call) => call[0]).sort();
    expect(urls).toEqual(['http://localhost:8100/pg/', 'http://localhost:8100/rest/v1/']);
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'healthy',
      label: 'healthy',
    });
    expect(rows.find((r) => r.container === 'rest')?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('marks a gateway-probed service unhealthy on an unexpected status code', async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
    );
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: okFetch(503),
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unhealthy',
      label: 'unhealthy',
      detail: 'HTTP 503',
    });
  });

  it('marks a gateway-probed service unhealthy when the probe throws', async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
    );
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(rows.find((r) => r.container === 'meta')).toMatchObject({
      health: 'unhealthy',
      detail: 'ECONNREFUSED',
    });
  });

  it('does not probe rest/meta when they are not running, even if kong is up', async () => {
    const ps = [
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
      'letsgo-rest\texited\tExited (1) 3 minutes ago',
    ].join('\n');
    const fetchSpy = okFetch();
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: fetchSpy,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unhealthy',
      label: 'exited',
    });
  });

  it('renders add-on containers under their compose service name, after core services', async () => {
    const ps = [
      'letsgo-db\trunning\tUp 1 hour (healthy)',
      'letsgo-redis\trunning\tUp 1 hour (healthy)',
      'letsgo-grafana\trunning\tUp 1 hour (health: starting)',
      'letsgo-metabase-setup\texited\tExited (0) 1 hour ago',
      'letsgo-promtail\trunning\tUp 1 hour',
    ].join('\n');
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.map((r) => [r.container, r.name, r.health, r.label])).toEqual([
      ['db', 'PostgreSQL', 'healthy', 'healthy'],
      ['grafana', 'grafana', 'starting', 'starting'],
      ['metabase-setup', 'metabase-setup', 'done', 'done'],
      ['promtail', 'promtail', 'healthy', 'running'],
      ['redis', 'redis', 'healthy', 'healthy'],
    ]);
  });

  it('returns an empty list when no containers of the project exist', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: 'vibecarbon-db\trunning\tUp 1 hour (healthy)\n' }),
      fetch: okFetch(),
    });
    expect(rows).toEqual([]);
  });

  it('returns an empty list when docker is unavailable', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: vi.fn(() => {
        throw new Error('docker: command not found');
      }),
      fetch: okFetch(),
    });
    expect(rows).toEqual([]);
  });

  it('returns an empty list without a project name', async () => {
    const run = fakeDocker({ ps: LETSGO_PS });
    const rows = await checkDockerContainers(undefined, { runCommand: run, fetch: okFetch() });
    expect(rows).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps Docker's own verdict for rest/meta and skips the gateway probe", async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-meta\trunning\tUp 15 minutes',
      'letsgo-meta\trunning\tUp 15 minutes (healthy)',
    ).replace(
      'letsgo-rest\trunning\tUp 15 minutes',
      'letsgo-rest\trunning\tUp 15 minutes (unhealthy)',
    );
    const fetchSpy = okFetch(200);
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '' }), // kong exited in LETSGO_PS
      fetch: fetchSpy,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows.find((r) => r.container === 'meta')).toMatchObject({
      health: 'healthy',
      label: 'healthy',
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unhealthy',
      label: 'unhealthy',
    });
  });

  it('accepts an async runCommand (the real default is runCommandAsync)', async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[1] === 'ps') return 'letsgo-db\trunning\tUp 1 hour (healthy)\n';
      if (argv[1] === 'port') return '';
      throw new Error(`unexpected docker call: ${argv.join(' ')}`);
    });
    const rows = await checkDockerContainers('letsgo', { runCommand: run, fetch: okFetch() });
    expect(rows).toEqual([
      {
        name: 'PostgreSQL',
        container: 'db',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 0,
      },
    ]);
  });

  it('renders a malformed docker ps line (no tab fields) as unknown rather than crashing', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: 'letsgo-weird\n' }),
      fetch: okFetch(),
    });
    expect(rows).toEqual([
      {
        name: 'weird',
        container: 'weird',
        health: 'unknown',
        label: 'unknown',
        detail: '',
        latencyMs: 0,
      },
    ]);
  });

  it('says "gateway port not published" when kong runs but 8000/tcp is not bound', async () => {
    const ps = [
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
      'letsgo-rest\trunning\tUp 1 minute',
    ].join('\n');
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unknown',
      label: 'unknown',
      detail: 'gateway port not published',
    });
  });

  it('reports a probe that exceeds timeoutMs as a timeout, not a generic error', async () => {
    const ps = [
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
      'letsgo-rest\trunning\tUp 1 minute',
    ].join('\n');
    const hangingFetch = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        }),
    ) as unknown as typeof fetch;
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: hangingFetch,
      timeoutMs: 10,
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unhealthy',
      label: 'unhealthy',
      detail: 'timeout after 10ms',
    });
  });
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatDockerServiceLines', () => {
  it('renders "not running" when there are no rows', () => {
    const lines = formatDockerServiceLines([]).map(stripAnsi);
    expect(lines).toEqual(['Docker Services               not running']);
  });

  it('counts healthy over non-done rows and shows exited rows with their Docker status', () => {
    const lines = formatDockerServiceLines([
      {
        name: 'PostgreSQL',
        container: 'db',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 0,
      },
      {
        name: 'Kong Gateway',
        container: 'kong',
        health: 'unhealthy',
        label: 'exited',
        detail: 'Exited (128) 24 minutes ago',
        latencyMs: 0,
      },
      {
        name: 'REST (PostgREST)',
        container: 'rest',
        health: 'unknown',
        label: 'unknown',
        detail: 'gateway down',
        latencyMs: 0,
      },
      {
        name: 'Traefik',
        container: 'traefik',
        health: 'healthy',
        label: 'running',
        detail: '',
        latencyMs: 0,
      },
      {
        name: 'metabase-setup',
        container: 'metabase-setup',
        health: 'done',
        label: 'done',
        detail: '',
        latencyMs: 0,
      },
    ]).map(stripAnsi);

    expect(lines[0]).toBe('Docker Services               ● 2/4 healthy');
    expect(lines[1]).toBe('  PostgreSQL                  ● healthy  ');
    expect(lines[2]).toBe('  Kong Gateway                ● exited  Exited (128) 24 minutes ago');
    expect(lines[3]).toBe('  REST (PostgREST)            ○ unknown  gateway down');
    expect(lines[4]).toBe('  Traefik                     ● running  ');
    expect(lines[5]).toBe('  metabase-setup              ○ done  ');
  });

  it('shows latency for probed rows', () => {
    const lines = formatDockerServiceLines([
      {
        name: 'Meta',
        container: 'meta',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 17,
      },
    ]).map(stripAnsi);
    expect(lines[1]).toBe('  Meta                        ● healthy  17ms');
  });

  it('colours the summary green only when every counted row is healthy', () => {
    const allGood = formatDockerServiceLines([
      {
        name: 'PostgreSQL',
        container: 'db',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 0,
      },
      {
        name: 'x-setup',
        container: 'x-setup',
        health: 'done',
        label: 'done',
        detail: '',
        latencyMs: 0,
      },
    ]);
    expect(allGood[0]).toContain('\x1b[32m'); // green
    const oneBad = formatDockerServiceLines([
      {
        name: 'PostgreSQL',
        container: 'db',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 0,
      },
      {
        name: 'Kong Gateway',
        container: 'kong',
        health: 'unhealthy',
        label: 'exited',
        detail: 'Exited (1) 1s ago',
        latencyMs: 0,
      },
    ]);
    expect(oneBad[0]).toContain('\x1b[33m'); // yellow
  });

  it('does not claim 0/0 healthy when only one-shot jobs exist', () => {
    const lines = formatDockerServiceLines([
      {
        name: 'x-setup',
        container: 'x-setup',
        health: 'done',
        label: 'done',
        detail: '',
        latencyMs: 0,
      },
    ]).map(stripAnsi);
    expect(lines[0]).toBe('Docker Services               no long-running services');
    expect(lines[1]).toBe('  x-setup                     ○ done  ');
  });
});
