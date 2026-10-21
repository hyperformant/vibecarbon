/**
 * Pulumi state follows a compose scale: the record, the sync, the deploy's
 * repair (Task 7b). See src/lib/deploy/compose/server-state-sync.js.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: null as null | { environments: Record<string, Record<string, unknown>> },
  syncCalls: [] as unknown[][],
  syncError: null as null | string,
  logs: [] as string[],
}));

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: () => structuredClone(h.config),
    saveProjectConfig: (c: typeof h.config) => {
      h.config = structuredClone(c);
    },
  };
});

vi.mock('../../../src/lib/iac/server-state.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    syncServerState: async (...args: unknown[]) => {
      h.syncCalls.push(args);
      if (h.syncError) throw new Error(h.syncError);
      return { changed: true };
    },
  };
});

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    log: {
      info: (m: string) => h.logs.push(`info:${m}`),
      error: (m: string) => h.logs.push(`error:${m}`),
      warn() {},
    },
  };
});

const m = await import('../../../src/lib/deploy/compose/server-state-sync.js');

const OPTIONS = { provider: 'hetzner', providerToken: 'tok', projectName: 'myapp' };

beforeEach(() => {
  h.config = { environments: { prod: { deployMode: 'compose-ha' } } };
  h.syncCalls.length = 0;
  h.syncError = null;
  h.logs.length = 0;
});

describe('assertComposeScaleKeepsState', () => {
  for (const provider of ['hetzner', 'digitalocean', 'vultr', 'linode']) {
    it(`${provider}: allowed`, () => {
      expect(() =>
        m.assertComposeScaleKeepsState({ environment: 'prod', envConfig: { provider } }),
      ).not.toThrow();
    });
  }
  it('scaleway: refused, naming the console as the way to resize', () => {
    expect(() =>
      m.assertComposeScaleKeepsState({ environment: 'prod', envConfig: { provider: 'scaleway' } }),
    ).toThrow(/compose scale is not available on scaleway.*Resize prod in the scaleway console/);
  });
});

describe('composeServerStack', () => {
  it('single compose: the env itself', () => {
    expect(
      m.composeServerStack({ ha: false, environment: 'prod', projectName: 'myapp', server: {} }),
    ).toBe('prod');
  });
  it('compose-ha: the stack the node was born in, even after a failover swapped its role', () => {
    const swapped = { name: 'myapp-prod-standby', role: 'primary' };
    expect(
      m.composeServerStack({
        ha: true,
        environment: 'prod',
        projectName: 'myapp',
        server: swapped,
      }),
    ).toBe('prod-standby');
    expect(
      m.composeServerStack({
        ha: true,
        environment: 'prod',
        projectName: 'myapp',
        server: { role: 'primary' },
      }),
    ).toBe('prod-primary');
  });
});

describe('record, sync, clear (the scale side)', () => {
  const server = {
    name: 'myapp-prod-primary',
    role: 'primary',
    id: 'old',
    _replacement: { id: 'new', ip: '9.9.9.9', serverType: 'cpx41' },
  };
  const ctx = () =>
    ({
      tier: 'compose-ha',
      environment: 'prod',
      projectName: 'myapp',
      serverStateOptions: OPTIONS,
    }) as Record<string, unknown>;

  it('records the replacement under its stack, then the sync points state at it and clears the record', async () => {
    const c = ctx();
    const entry = m.scaledServerStateEntry(c, server);
    m.recordPendingServerState('prod', entry);
    expect(entry).toEqual({
      stack: 'prod-primary',
      serverId: 'new',
      serverType: 'cpx41',
      ip: '9.9.9.9',
    });
    expect(h.config?.environments.prod.pendingServerState).toMatchObject([entry]);
    await m.syncScaledServerState(c, entry);
    expect(h.syncCalls).toEqual([
      ['prod-primary', { serverId: 'new', serverType: 'cpx41', ip: '9.9.9.9' }, OPTIONS],
    ]);
    expect(h.config?.environments.prod.pendingServerState).toBeUndefined();
    expect(c.serverStateProblems).toBeUndefined();
  });

  it('a failed sync never throws: it keeps the record and names the recovery command', async () => {
    h.syncError = 'state bucket 503\nmore';
    const c = ctx();
    const entry = m.scaledServerStateEntry(c, server);
    m.recordPendingServerState('prod', entry);
    await expect(m.syncScaledServerState(c, entry)).resolves.toBeUndefined();
    expect(h.config?.environments.prod.pendingServerState).toMatchObject([entry]);
    expect(c.serverStateProblems).toEqual([
      'Pulumi stack prod-primary still names the server scale replaced (state bucket 503); ' +
        'run vibecarbon deploy prod: it points Pulumi state at the new server before anything else',
    ]);
  });

  it('a scale with no resolved backend options keeps the record as a problem', async () => {
    const c = { ...ctx(), serverStateOptions: undefined };
    const entry = m.scaledServerStateEntry(c, server);
    m.recordPendingServerState('prod', entry);
    await m.syncScaledServerState(c, entry);
    expect(h.syncCalls).toHaveLength(0);
    expect(c.serverStateProblems).toHaveLength(1);
    expect(h.config?.environments.prod.pendingServerState).toHaveLength(1);
  });

  it('a second record for the same stack replaces the first', () => {
    const c = ctx();
    m.recordPendingServerState('prod', m.scaledServerStateEntry(c, server));
    m.recordPendingServerState(
      'prod',
      m.scaledServerStateEntry(c, {
        ...server,
        _replacement: { id: 'newer', ip: '8.8.8.8', serverType: 'x' },
      }),
    );
    expect(h.config?.environments.prod.pendingServerState).toMatchObject([{ serverId: 'newer' }]);
  });
});

describe('repairPendingServerState (the deploy side)', () => {
  const pending = [
    { stack: 'prod-primary', serverId: 'new', serverType: 'cpx41', ip: '9.9.9.9' },
    { stack: 'prod-standby', serverId: 'new2', serverType: 'cpx41', ip: '8.8.8.8' },
  ];

  it('applies every pending sync, clears the records on disk and in memory', async () => {
    h.config = { environments: { prod: { pendingServerState: pending } } };
    const envConfig = { pendingServerState: pending } as Record<string, unknown>;
    const n = await m.repairPendingServerState({
      environment: 'prod',
      envConfig,
      options: OPTIONS,
    });
    expect(n).toBe(2);
    expect(h.syncCalls.map((c) => c[0])).toEqual(['prod-primary', 'prod-standby']);
    expect(h.config?.environments.prod.pendingServerState).toBeUndefined();
    expect(envConfig.pendingServerState).toBeUndefined();
  });

  it('nothing pending: no state is touched', async () => {
    expect(
      await m.repairPendingServerState({ environment: 'prod', envConfig: {}, options: OPTIONS }),
    ).toBe(0);
    expect(h.syncCalls).toHaveLength(0);
  });

  it('a repair that fails refuses the deploy and keeps the record', async () => {
    h.config = { environments: { prod: { pendingServerState: pending } } };
    h.syncError = 'NoSuchBucket';
    await expect(
      m.repairPendingServerState({
        environment: 'prod',
        envConfig: { pendingServerState: pending },
        options: OPTIONS,
      }),
    ).rejects.toThrow(
      /Refusing to deploy prod: Pulumi stack prod-primary still names a server scale replaced.*NoSuchBucket.*would build a second server/,
    );
    expect(h.config?.environments.prod.pendingServerState).toHaveLength(2);
  });
});
