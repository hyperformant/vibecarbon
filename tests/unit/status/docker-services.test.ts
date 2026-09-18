import { describe, expect, it, vi } from 'vitest';
import {
  checkDockerContainers,
  classifyContainer,
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
});
