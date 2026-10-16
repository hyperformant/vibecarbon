import { describe, expect, it, vi } from 'vitest';
import {
  checkDockerContainers,
  classifyContainer,
  formatDockerServiceLines,
} from '../../../src/status.js';

describe('classifyContainer', () => {
  it('maps a running container with a passing healthcheck to healthy', () => {
    expect(classifyContainer('app', 'running', 'Up 15 minutes (healthy)')).toEqual({
      health: 'healthy',
      label: 'healthy',
      detail: '',
    });
  });

  it('maps a running container with a failing healthcheck to unhealthy', () => {
    expect(classifyContainer('app', 'running', 'Up 15 minutes (unhealthy)')).toEqual({
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
    expect(classifyContainer('app', 'exited', 'Exited (128) 24 minutes ago')).toEqual({
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
    expect(classifyContainer('app', 'restarting', 'Restarting (1) 5 seconds ago')).toEqual({
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

// `docker ps -a` returns the tab-separated listing; nothing else is called.
function fakeDocker({ ps = '' }: { ps?: string }) {
  return vi.fn((argv: string[]) => {
    if (argv[1] === 'ps') return ps;
    throw new Error(`unexpected docker call: ${argv.join(' ')}`);
  });
}

const LETSGO_PS = [
  'letsgo-socket-proxy\trunning\tUp 15 minutes',
  'letsgo-app\texited\tExited (128) 24 minutes ago',
  'letsgo-db\trunning\tUp 15 minutes (healthy)',
  'letsgo-traefik\trunning\tUp 15 minutes',
  // A different project sharing the host — must be ignored.
  'vibecarbon-db\trunning\tUp 20 minutes (healthy)',
  'vibecarbon-app\trunning\tUp 20 minutes',
].join('\n');

describe('checkDockerContainers', () => {
  it('lists every container of the project, including exited ones, in core order', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS }),
    });
    expect(rows.map((r) => [r.container, r.name])).toEqual([
      ['traefik', 'Traefik'],
      ['app', 'App'],
      ['db', 'PostgreSQL'],
      ['socket-proxy', 'Docker socket proxy'],
    ]);
    expect(rows.find((r) => r.container === 'app')).toMatchObject({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 24 minutes ago',
    });
    expect(rows.find((r) => r.container === 'db')).toMatchObject({ health: 'healthy' });
  });

  it('takes health from Docker alone and runs only docker ps', async () => {
    const run = fakeDocker({ ps: LETSGO_PS });
    const rows = await checkDockerContainers('letsgo', { runCommand: run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => r.container === 'traefik')).toMatchObject({
      health: 'healthy',
      label: 'running',
      latencyMs: 0,
    });
  });

  it('ignores containers belonging to other projects', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS }),
    });
    expect(rows.filter((r) => r.container === 'db')).toHaveLength(1);
    expect(rows.filter((r) => r.container === 'app')).toHaveLength(1);
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
      runCommand: fakeDocker({ ps }),
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
    });
    expect(rows).toEqual([]);
  });

  it('returns an empty list when docker is unavailable', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: vi.fn(() => {
        throw new Error('docker: command not found');
      }),
    });
    expect(rows).toEqual([]);
  });

  it('returns an empty list without a project name', async () => {
    const run = fakeDocker({ ps: LETSGO_PS });
    const rows = await checkDockerContainers(undefined, { runCommand: run });
    expect(rows).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts an async runCommand (the real default is runCommandAsync)', async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[1] === 'ps') return 'letsgo-db\trunning\tUp 1 hour (healthy)\n';
      throw new Error(`unexpected docker call: ${argv.join(' ')}`);
    });
    const rows = await checkDockerContainers('letsgo', { runCommand: run });
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
        name: 'App',
        container: 'app',
        health: 'unhealthy',
        label: 'exited',
        detail: 'Exited (128) 24 minutes ago',
        latencyMs: 0,
      },
      {
        name: 'grafana',
        container: 'grafana',
        health: 'unknown',
        label: 'unknown',
        detail: 'no status',
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
    expect(lines[2]).toBe('  App                         ● exited  Exited (128) 24 minutes ago');
    expect(lines[3]).toBe('  grafana                     ○ unknown  no status');
    expect(lines[4]).toBe('  Traefik                     ● running  ');
    expect(lines[5]).toBe('  metabase-setup              ○ done  ');
  });

  it('shows latency for probed rows', () => {
    const lines = formatDockerServiceLines([
      {
        name: 'App',
        container: 'app',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 17,
      },
    ]).map(stripAnsi);
    expect(lines[1]).toBe('  App                         ● healthy  17ms');
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
        name: 'App',
        container: 'app',
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
