/**
 * .vibecarbon.json writes are atomic and never stale (backup/restore
 * integrity M6).
 *
 * Every write is one locked read-modify-write: take `.vibecarbon.json.lock`
 * (O_EXCL, works across processes), reload the file, apply the caller's
 * mutator, write `.vibecarbon.json.tmp`, fsync, rename. Two CLI invocations in
 * two terminals (a failover in one, a destroy of another env in the other)
 * can no longer clobber each other's fields, and a crash mid-write never
 * leaves a truncated config.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Test seam: make the next rename throw, simulating a crash after the tmp write. */
const crash = vi.hoisted(() => ({ onRename: false }));
vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as typeof import('node:fs');
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (crash.onRename) throw new Error('simulated crash between the tmp write and the rename');
      return actual.renameSync(from, to);
    },
  };
});

const { updateProjectConfig } = await import('../../../src/lib/config.js');
const { swapHaRoles } = await import('../../../src/failover.js');
const { writeWriteFenceMarker, writeScaleCutoverJournal } = await import(
  '../../../src/lib/deploy/write-fence.js'
);
const { recordPendingServerState } = await import(
  '../../../src/lib/deploy/compose/server-state-sync.js'
);

const CONFIG_JS = pathToFileURL(resolve('src/lib/config.js')).href;

let dir: string;
const configPath = () => join(dir, '.vibecarbon.json');
const readConfig = () => JSON.parse(readFileSync(configPath(), 'utf-8'));
const seed = (config: unknown) => writeFileSync(configPath(), JSON.stringify(config, null, 2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
    await sleep(10);
  }
}

/**
 * A second CLI process: it takes the config lock through updateProjectConfig,
 * applies `body` (a mutator body over `config`), signals `locked` from INSIDE
 * the lock, then holds it for `holdMs` before its write lands. Without a real
 * cross-process lock, anything the test process writes meanwhile is lost.
 */
function holderProcess(body: string, holdMs: number) {
  const signal = join(dir, 'locked.signal');
  const script = join(dir, 'holder.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
const { updateProjectConfig } = await import(${JSON.stringify(CONFIG_JS)});
updateProjectConfig((config) => {
  ${body}
  writeFileSync(${JSON.stringify(signal)}, 'x');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
}, ${JSON.stringify(dir)});
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise<void>((res, rej) => {
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`holder exited ${code}: ${stderr}`)),
    );
  });
  return { locked: waitForFile(signal), exited };
}

/** A pid that is guaranteed dead: a child that already exited. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid as number;
}

const haEnv = () => ({
  deployMode: 'k8s-ha',
  region: 'fsn1',
  secondaryRegion: 'nbg1',
  replication: 'streaming',
  servers: [
    { name: 'myapp-prod-primary', role: 'primary', ip: '10.0.0.1' },
    { name: 'myapp-prod-standby', role: 'standby', ip: '10.0.0.2' },
  ],
  ha: {
    enabled: true,
    primary: { stack: 'prod-primary', region: 'fsn1' },
    standby: { stack: 'prod-standby', region: 'nbg1' },
    failoverInFlight: { id: 'j1', target: 'standby' },
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-update-config-'));
  crash.onRename = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('updateProjectConfig', () => {
  it('reloads the file, applies the mutator, writes it, and releases the lock', () => {
    seed({ projectName: 'myapp', environments: { prod: { region: 'fsn1' } } });
    const result = updateProjectConfig((config) => {
      config.environments.prod.region = 'nbg1';
    }, dir);
    expect(readConfig()).toEqual({
      projectName: 'myapp',
      environments: { prod: { region: 'nbg1' } },
    });
    expect(result.environments.prod.region).toBe('nbg1');
    expect(readFileSync(configPath(), 'utf-8').endsWith('}\n')).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['.vibecarbon.json']);
  });

  it('a mutator may return a replacement object instead of mutating in place', () => {
    seed({ projectName: 'myapp' });
    updateProjectConfig((config) => ({ ...config, environments: { dev: {} } }), dir);
    expect(readConfig()).toEqual({ projectName: 'myapp', environments: { dev: {} } });
  });

  it('a mutator that throws writes nothing and releases the lock', () => {
    seed({ projectName: 'myapp' });
    expect(() =>
      updateProjectConfig((config) => {
        config.projectName = 'changed';
        throw new Error('refused');
      }, dir),
    ).toThrow('refused');
    expect(readConfig()).toEqual({ projectName: 'myapp' });
    expect(readdirSync(dir)).toEqual(['.vibecarbon.json']);
  });

  it('reads the raw file, never the synthesized fields loadProjectConfig adds', () => {
    // No .vibecarbon.json, a .env.local with a secret: the write must not
    // carry `secrets` (or a synthesized projectName) into the JSON.
    writeFileSync(join(dir, '.env.local'), 'PROJECT_NAME=myapp\nSOME_SECRET=hunter2\n');
    updateProjectConfig((config) => {
      config.environments = { dev: {} };
    }, dir);
    expect(readConfig()).toEqual({ environments: { dev: {} } });
  });

  it('refuses an async mutator: the lock cannot be held across an await', () => {
    seed({ projectName: 'myapp' });
    expect(() => updateProjectConfig(async () => {}, dir)).toThrow(/synchronous/);
    expect(readdirSync(dir)).toEqual(['.vibecarbon.json']);
  });
});

describe('two interleaved writers in two processes both survive', () => {
  it("swapHaRoles' patch on environments.prod and a delete of environments.staging", async () => {
    seed({ projectName: 'myapp', environments: { prod: haEnv(), staging: { region: 'fsn1' } } });
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    // The other terminal deletes staging and holds the lock mid-write.
    const holder = holderProcess('delete config.environments.staging;', 400);
    await holder.locked;
    // This terminal persists a failover's role swap while that write is pending.
    swapHaRoles('prod');
    await holder.exited;

    const saved = readConfig();
    expect(saved.environments.staging).toBeUndefined();
    const prod = saved.environments.prod;
    expect(prod.ha.primary.stack).toBe('prod-standby');
    expect(prod.ha.standby.stack).toBe('prod-primary');
    expect(prod.ha.failoverInFlight).toBeUndefined();
    expect(prod.region).toBe('nbg1');
    expect(prod.replication).toBe('degraded');
  });

  it('a failoverInFlight journal and a destroyedEnvironments record', async () => {
    seed({ projectName: 'myapp', environments: { prod: { ha: { enabled: true } }, staging: {} } });

    const holder = holderProcess(
      `config.environments.prod.ha.failoverInFlight = { id: 'j2', target: 'standby' };`,
      400,
    );
    await holder.locked;
    updateProjectConfig((config) => {
      delete config.environments.staging;
      config.destroyedEnvironments = { staging: { destroyedAt: '2026-10-21T00:00:00.000Z' } };
    }, dir);
    await holder.exited;

    const saved = readConfig();
    expect(saved.environments.prod.ha.failoverInFlight).toEqual({ id: 'j2', target: 'standby' });
    expect(saved.destroyedEnvironments.staging.destroyedAt).toBe('2026-10-21T00:00:00.000Z');
    expect(saved.environments.staging).toBeUndefined();
  });
});

describe('the safety-critical records go through the locked path', () => {
  it('a write-fence marker, its cutover journal and a pending state sync survive a concurrent writer', async () => {
    seed({
      projectName: 'myapp',
      environments: { prod: { servers: [{ id: 1, ip: '1.1.1.1' }] }, staging: {} },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const ctx = { environment: 'prod' };

    // Each record is written while another terminal is mid-write on the file.
    let holder = holderProcess('delete config.environments.staging;', 300);
    await holder.locked;
    writeWriteFenceMarker(ctx, { ip: '1.1.1.1', source: 'scale' });
    await holder.exited;
    rmSync(join(dir, 'locked.signal'));

    holder = holderProcess(`config.destroyedEnvironments = { qa: { destroyedAt: 'x' } };`, 300);
    await holder.locked;
    writeScaleCutoverJournal(ctx, {
      oldId: 1,
      oldIp: '1.1.1.1',
      newServerId: 2,
      newIp: '2.2.2.2',
      stopped: ['app'],
      cronRemoved: true,
    });
    await holder.exited;
    rmSync(join(dir, 'locked.signal'));

    holder = holderProcess(`config.operatorCidrs = [{ cidr: '9.9.9.9/32' }];`, 300);
    await holder.locked;
    recordPendingServerState('prod', { stack: 'myapp-prod', serverId: 2, ip: '2.2.2.2' });
    await holder.exited;

    const saved = readConfig();
    expect(saved.environments.staging).toBeUndefined();
    expect(saved.destroyedEnvironments).toEqual({ qa: { destroyedAt: 'x' } });
    expect(saved.operatorCidrs).toEqual([{ cidr: '9.9.9.9/32' }]);
    const prod = saved.environments.prod;
    expect(prod.ha.writeFence).toMatchObject({ ip: '1.1.1.1', source: 'scale' });
    expect(prod.ha.writeFence.cutover).toMatchObject({ newIp: '2.2.2.2', done: [] });
    expect(prod.pendingServerState).toEqual([
      expect.objectContaining({ stack: 'myapp-prod', serverId: 2, ip: '2.2.2.2' }),
    ]);
  });
});

describe('crash safety', () => {
  it('keeps the file mode, whatever the umask', () => {
    seed({ projectName: 'myapp' });
    chmodSync(configPath(), 0o664);
    const umask = process.umask(0o077);
    try {
      updateProjectConfig((config) => {
        config.projectName = 'next';
      }, dir);
    } finally {
      process.umask(umask);
    }
    expect(statSync(configPath()).mode & 0o777).toBe(0o664);
  });

  it('a crash between the tmp write and the rename leaves the original file intact', () => {
    const original = { projectName: 'myapp', environments: { prod: { region: 'fsn1' } } };
    seed(original);
    const before = readFileSync(configPath(), 'utf-8');
    crash.onRename = true;
    expect(() =>
      updateProjectConfig((config) => {
        config.environments.prod.region = 'nbg1';
      }, dir),
    ).toThrow(/simulated crash/);
    crash.onRename = false;
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    // The lock is released, so the next write is not blocked by the crash.
    updateProjectConfig((config) => {
      config.environments.prod.region = 'hel1';
    }, dir);
    expect(readConfig().environments.prod.region).toBe('hel1');
  });
});

describe('the lock', () => {
  it('breaks a stale lock whose holder pid is dead', async () => {
    seed({ projectName: 'myapp' });
    writeFileSync(join(dir, '.vibecarbon.json.lock'), `${await deadPid()}\n`);
    updateProjectConfig((config) => {
      config.projectName = 'next';
    }, dir);
    expect(readConfig().projectName).toBe('next');
    expect(existsSync(join(dir, '.vibecarbon.json.lock'))).toBe(false);
  });

  it('waits out a live holder only up to the budget, then names the lock and its pid', async () => {
    seed({ projectName: 'myapp' });
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeFileSync(join(dir, '.vibecarbon.json.lock'), `${live.pid}\n`);
      const started = Date.now();
      expect(() =>
        updateProjectConfig(
          (config) => {
            config.projectName = 'never';
          },
          dir,
          { lockTimeoutMs: 300 },
        ),
      ).toThrow(new RegExp(`\\.vibecarbon\\.json\\.lock.*pid ${live.pid}`));
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(readConfig().projectName).toBe('myapp');
      // Never removes a lock it does not own.
      expect(existsSync(join(dir, '.vibecarbon.json.lock'))).toBe(true);
    } finally {
      live.kill();
    }
  });

  it('four processes racing read-modify-writes, after breaking the same stale lock, lose none', async () => {
    seed({ projectName: 'myapp', counter: 0 });
    writeFileSync(join(dir, '.vibecarbon.json.lock'), `${await deadPid()}\n`);
    const script = join(dir, 'racer.mjs');
    writeFileSync(
      script,
      `const { updateProjectConfig } = await import(${JSON.stringify(CONFIG_JS)});
for (let i = 0; i < 25; i++) {
  updateProjectConfig((config) => {
    config.counter += 1;
    config[\`racer\${process.argv[2]}\`] = (config[\`racer\${process.argv[2]}\`] ?? 0) + 1;
  }, ${JSON.stringify(dir)});
}
`,
    );
    const racers = [0, 1, 2, 3].map(
      (n) =>
        new Promise<number | null>((res) => {
          spawn(process.execPath, [script, String(n)], { stdio: 'ignore' }).on('exit', res);
        }),
    );
    expect(await Promise.all(racers)).toEqual([0, 0, 0, 0]);
    const saved = readConfig();
    expect(saved.counter).toBe(100);
    expect([saved.racer0, saved.racer1, saved.racer2, saved.racer3]).toEqual([25, 25, 25, 25]);
    expect(readdirSync(dir).filter((f) => f.startsWith('.vibecarbon.json.'))).toEqual([]);
  });

  it('a wait past a second prints one stderr line naming the lock and its holder', async () => {
    seed({ projectName: 'myapp' });
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      writeFileSync(join(dir, '.vibecarbon.json.lock'), `${live.pid}\n`);
      expect(() =>
        updateProjectConfig(() => undefined as never, dir, { lockTimeoutMs: 1300 }),
      ).toThrow(/held by pid/);
    } finally {
      write.mockRestore();
      live.kill();
    }
    const notices = lines.filter((l) => l.includes('waiting for'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(join(dir, '.vibecarbon.json.lock'));
    expect(notices[0]).toContain(`pid ${live.pid}`);
  });

  it('a quick wait prints nothing', async () => {
    seed({ projectName: 'myapp' });
    const write = vi.spyOn(process.stderr, 'write');
    const holder = holderProcess('config.projectName = "held";', 200);
    await holder.locked;
    updateProjectConfig((config) => {
      config.after = true;
    }, dir);
    await holder.exited;
    expect(write.mock.calls.filter(([c]) => String(c).includes('waiting for'))).toEqual([]);
    expect(readConfig()).toMatchObject({ projectName: 'held', after: true });
  });

  it('refuses a nested call instead of deadlocking on its own lock', () => {
    seed({ projectName: 'myapp' });
    expect(() =>
      updateProjectConfig(() => {
        updateProjectConfig(() => {}, dir);
      }, dir),
    ).toThrow(/nested/);
    expect(existsSync(join(dir, '.vibecarbon.json.lock'))).toBe(false);
  });
});
