import { describe, expect, it } from 'vitest';
import {
  findOrphanStacks,
  formatStackPath,
  listVibecarbonStacks,
} from '../../../src/lib/local-stacks.js';

type Fake = {
  name: string;
  project: string;
  dir: string;
  files: string;
  net: string;
  state?: string;
};

function inspectJson(cs: Fake[]) {
  return JSON.stringify(
    cs.map((c) => ({
      Name: `/${c.name}`,
      State: { Status: c.state ?? 'running' },
      Config: {
        Labels: {
          'com.docker.compose.project': c.project,
          'com.docker.compose.project.working_dir': c.dir,
          'com.docker.compose.project.config_files': c.files,
        },
      },
      NetworkSettings: { Networks: { [c.net]: {} } },
    })),
  );
}

/** ps returns ids; inspect returns the JSON. */
function fakeDocker(cs: Fake[]) {
  const calls: string[][] = [];
  const fn = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') return cs.map((_, i) => `id${i}`).join('\n');
    if (args[0] === 'inspect') return inspectJson(cs);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { fn, calls };
}

const yippy: Fake = {
  name: 'yippy-db',
  project: 'yippy',
  dir: '/home/u/repos/yippy',
  files: '/home/u/repos/yippy/docker-compose.yml,/home/u/repos/yippy/docker-compose.override.yml',
  net: 'yippy_vibecarbon-network',
};

describe('listVibecarbonStacks', () => {
  it('groups containers by compose project', () => {
    const { fn } = fakeDocker([yippy, { ...yippy, name: 'yippy-auth', state: 'restarting' }]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([
      {
        project: 'yippy',
        workingDir: '/home/u/repos/yippy',
        configFiles: [
          '/home/u/repos/yippy/docker-compose.yml',
          '/home/u/repos/yippy/docker-compose.override.yml',
        ],
        containers: [
          { name: 'yippy-db', state: 'running' },
          { name: 'yippy-auth', state: 'restarting' },
        ],
      },
    ]);
  });

  it('ignores compose projects that are not on a vibecarbon network', () => {
    const other = { ...yippy, name: 'pg-1', project: 'pg', net: 'pg_default' };
    const { fn } = fakeDocker([other]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('matches the network name exactly, not by suffix', () => {
    const lookalike = { ...yippy, net: 'yippy_other_vibecarbon-network' };
    const { fn } = fakeDocker([lookalike]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('returns [] without calling inspect when there are no compose containers', () => {
    const { fn, calls } = fakeDocker([]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
    expect(calls.map((a) => a[0])).toEqual(['ps']);
  });

  it('returns [] when docker is missing or the daemon is down', () => {
    const fn = () => {
      throw new Error('spawn docker ENOENT');
    };
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('returns [] on unparseable inspect output', () => {
    const fn = (_c: string, args: string[]) => (args[0] === 'ps' ? 'id0' : '{not json');
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('passes a timeout to every docker call', () => {
    const { fn, calls } = fakeDocker([yippy]);
    const seen: unknown[] = [];
    listVibecarbonStacks({
      execFile: (c: string, a: string[], o: { timeout?: number }) => {
        seen.push(o.timeout);
        return fn(c, a);
      },
      timeoutMs: 1234,
    });
    expect(calls.length).toBe(2);
    expect(seen).toEqual([1234, 1234]);
  });
});

describe('findOrphanStacks', () => {
  const stack = {
    project: 'yippy',
    workingDir: '/gone',
    configFiles: ['/gone/docker-compose.yml'],
    containers: [],
  };

  it('flags a stack whose folder is gone', () => {
    const out = findOrphanStacks([stack], { exists: () => false });
    expect(out).toEqual([{ ...stack, reason: 'folder-missing' }]);
  });

  it('flags a stack whose folder exists but a compose file it was started with is gone', () => {
    const s = {
      ...stack,
      workingDir: '/repo/carbon',
      configFiles: ['/repo/carbon/docker-compose.yml', '/repo/carbon/docker-compose.dev-init.yml'],
    };
    const exists = (p: string) => p !== '/repo/carbon/docker-compose.dev-init.yml';
    expect(findOrphanStacks([s], { exists })).toEqual([{ ...s, reason: 'files-missing' }]);
  });

  it('does not flag files-missing while a container is running', () => {
    const s = {
      ...stack,
      workingDir: '/repo',
      configFiles: ['/repo/docker-compose.yml', '/repo/docker-compose.n8n.yml'],
      containers: [
        { name: 'a', state: 'exited' },
        { name: 'b', state: 'running' },
      ],
    };
    const exists = (p: string) => p !== '/repo/docker-compose.n8n.yml';
    expect(findOrphanStacks([s], { exists })).toEqual([]);
  });

  it('flags files-missing when every container is stopped or restarting', () => {
    const s = {
      ...stack,
      workingDir: '/repo',
      configFiles: ['/repo/docker-compose.yml', '/repo/docker-compose.n8n.yml'],
      containers: [
        { name: 'a', state: 'exited' },
        { name: 'b', state: 'restarting' },
      ],
    };
    const exists = (p: string) => p !== '/repo/docker-compose.n8n.yml';
    expect(findOrphanStacks([s], { exists })).toEqual([{ ...s, reason: 'files-missing' }]);
  });

  it('still flags folder-missing even when containers are running', () => {
    const s = { ...stack, containers: [{ name: 'a', state: 'running' }] };
    expect(findOrphanStacks([s], { exists: () => false })).toEqual([
      { ...s, reason: 'folder-missing' },
    ]);
  });

  it('leaves healthy stacks alone', () => {
    expect(findOrphanStacks([stack], { exists: () => true })).toEqual([]);
  });
});

describe('formatStackPath', () => {
  it('abbreviates the home directory', () => {
    expect(formatStackPath('/home/u/repos/yippy', '/home/u')).toBe('~/repos/yippy');
    expect(formatStackPath('/srv/app', '/home/u')).toBe('/srv/app');
  });
});
