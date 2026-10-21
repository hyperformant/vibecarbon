/**
 * One primary resolver (backup/restore integrity H4). After a failover the
 * persisted roles say which node is live; array order does not.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(),
}));

const { AmbiguousPrimaryError, resolvePrimary } = await import(
  '../../../src/lib/cli/resolve-primary.js'
);
const { resolveEnvContext } = await import('../../../src/lib/cli/env-context.js');
const { swapHaRoles } = await import('../../../src/failover.js');
const { swapComposeHaRoles } = await import('../../../src/lib/deploy/compose/ha.js');

const A = '10.0.0.1';
const B = '10.0.0.9';

const k8sHa = () => ({
  deployMode: 'kubernetes',
  region: 'nbg1',
  secondaryRegion: 'ash',
  ha: {
    enabled: true,
    primary: { masterIp: A, stack: 'e-primary' },
    standby: { masterIp: B, stack: 'e-standby' },
  },
  servers: [
    { name: 'primary', role: 'primary', ip: A, region: 'nbg1' },
    { name: 'standby', role: 'standby', ip: B, region: 'ash' },
  ],
});

const composeHa = () => ({
  deployMode: 'compose-ha',
  region: 'nbg1',
  secondaryRegion: 'ash',
  ha: { enabled: true, failoverRegion: 'ash' },
  servers: [
    { name: 'app-prod-primary', role: 'primary', ip: A, region: 'nbg1' },
    { name: 'app-prod-standby', role: 'standby', ip: B, region: 'ash' },
  ],
});

describe('resolvePrimary', () => {
  it('k8s-ha: ha.primary.masterIp', () => {
    expect(resolvePrimary(k8sHa())).toMatchObject({ ip: A, name: 'primary' });
  });

  it('compose-ha: the role primary, whatever the array order', () => {
    const env = composeHa();
    env.servers.reverse();
    expect(resolvePrimary(env)).toMatchObject({ ip: A, name: 'app-prod-primary' });
  });

  it('single-node modes: the only server, or the k8s master', () => {
    expect(
      resolvePrimary({ deployMode: 'compose', servers: [{ name: 'master', ip: A }] }),
    ).toMatchObject({
      ip: A,
      name: 'master',
    });
    expect(
      resolvePrimary({
        deployMode: 'kubernetes',
        servers: [
          { name: 'db', role: 'db', ip: B },
          { name: 'master', role: 'master', ip: A },
        ],
      }),
    ).toMatchObject({ ip: A, name: 'master' });
  });

  it('nothing deployed yet is null, not a throw', () => {
    expect(resolvePrimary({ deployMode: 'compose-ha', servers: [] })).toBeNull();
    expect(resolvePrimary({ deployMode: 'compose' })).toBeNull();
  });

  it('two role primaries throw', () => {
    const env = composeHa();
    env.servers[1].role = 'primary';
    expect(() => resolvePrimary(env)).toThrow(AmbiguousPrimaryError);
    const k8s = k8sHa();
    k8s.servers[1].role = 'primary';
    expect(() => resolvePrimary(k8s)).toThrow(AmbiguousPrimaryError);
  });

  it('zero role primaries throw', () => {
    const env = composeHa();
    env.servers[0].role = 'standby';
    expect(() => resolvePrimary(env)).toThrow(AmbiguousPrimaryError);
  });

  it('servers[] disagreeing with ha.primary throws (a half-saved swap)', () => {
    const env = k8sHa();
    env.ha.primary.masterIp = B;
    env.ha.standby.masterIp = A;
    expect(() => resolvePrimary(env)).toThrow(/half saved/);
  });
});

describe('after a failover swap', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const seed = (env: object) => {
    dir = mkdtempSync(join(tmpdir(), 'vc-resolve-primary-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'app', environments: { prod: env } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  };
  const saved = () =>
    JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments.prod;

  const ctx = (envConfig: object) =>
    resolveEnvContext({
      actionVerb: 'back up',
      envRequirement: 'name an environment',
      values: { env: 'prod' },
      positional: {},
      projectConfig: { projectName: 'app', environments: { prod: envConfig } },
      serverIp: 'primary',
    });

  it('k8s-ha: swapHaRoles promotes the standby in servers[], ha and the env context', async () => {
    seed(k8sHa());
    swapHaRoles('prod');
    const env = saved();
    expect(resolvePrimary(env)?.ip).toBe(B);
    expect((await ctx(env)).serverIp).toBe(B);
  });

  it('compose-ha: swapComposeHaRoles promotes the standby (regression pin)', async () => {
    seed(composeHa());
    swapComposeHaRoles('prod');
    const env = saved();
    expect(resolvePrimary(env)?.ip).toBe(B);
    expect((await ctx(env)).serverIp).toBe(B);
  });
});
