/**
 * The state passphrase reaches every Pulumi call that decrypts.
 *
 * Every stack is encrypted with the project's passphrase, so a call that
 * reaches Pulumi without it either fails or, worse, uses the wrong key. The
 * property has one choke point: `getOrCreateStack` awaits
 * `ensureStatePassphrase` and builds the workspace env through `buildEnv`.
 * (a) and (b) pin that nothing goes around it; (c) proves, for each public
 * entry point, that the workspace really receives the project's passphrase and
 * that the project recorded its fingerprint on the way.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const SRC = join(import.meta.dirname, '..', '..', '..', 'src');
const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';

const srcFiles = readdirSync(SRC, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.js'))
  .map((d) => join(d.parentPath, d.name));

/** Source with comments blanked out, so prose cannot count as a call. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('state passphrase census: structure', () => {
  it('(a) only iac/index.js drives Pulumi under src/', () => {
    // preflight.js runs `pulumi version`, which opens no state.
    const allowed = new Set(['lib/iac/index.js', 'lib/deploy/preflight.js']);
    const drivers: string[] = [];
    for (const file of srcFiles) {
      const text = code(file);
      const imports = /from\s+['"]@pulumi\/pulumi\/automation/.test(text);
      const spawns =
        /\[\s*['"]pulumi['"]\s*,|(spawn|spawnSync|exec|execSync|execFile|execFileSync|run)\w*\(\s*['"]pulumi['"]/.test(
          text,
        );
      if (imports || spawns) drivers.push(file.slice(SRC.length + 1));
    }
    expect(drivers.length).toBeGreaterThan(0);
    expect(drivers.filter((f) => !allowed.has(f))).toEqual([]);
    expect(drivers).toContain('lib/iac/index.js');
  });

  it('(b) every LocalWorkspace call in iac/index.js sits in getOrCreateStack or a non-decrypting opener', () => {
    const lines = code(join(SRC, 'lib/iac/index.js')).split('\n');
    // Openers that decrypt nothing: `stack ls` and `whoami` read no secret.
    const allowed: Record<string, string[]> = {
      getOrCreateStack: ['selectStack', 'createStack'],
      listStacks: ['create'],
      openStateBackend: ['create'],
    };
    const calls: { fn: string; method: string }[] = [];
    let fn = '';
    for (const line of lines) {
      const decl = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (decl) fn = decl[1];
      for (const m of line.matchAll(/LocalWorkspace\.(\w+)\(/g)) {
        calls.push({ fn, method: m[1] });
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const stray = calls.filter((c) => !allowed[c.fn]?.includes(c.method));
    expect(stray).toEqual([]);
  });

  it('(b) `decrypts` is set only by the openers that decrypt nothing', () => {
    const text = code(join(SRC, 'lib/iac/index.js'));
    const lines = text.split('\n');
    const where: { fn: string; value: string }[] = [];
    let fn = '';
    for (const line of lines) {
      const decl = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (decl) fn = decl[1];
      for (const m of line.matchAll(/\bdecrypts\s*:\s*([^,}\s]+)/g)) {
        where.push({ fn, value: m[1] });
      }
    }
    expect(where.length).toBeGreaterThanOrEqual(3);
    expect(where.every((w) => w.value === 'false')).toBe(true);
    expect(where.map((w) => w.fn).sort()).toEqual([
      'listStacks',
      'openStateBackend',
      'removeStackState',
    ]);
    // No other file may pass it either.
    for (const file of srcFiles) {
      if (file === join(SRC, 'lib/iac/index.js')) continue;
      expect(code(file), file).not.toMatch(/\bdecrypts\s*:/);
    }
  });

  it('(b) getOrCreateStack awaits the passphrase check before any workspace call', () => {
    const text = code(join(SRC, 'lib/iac/index.js'));
    const start = text.indexOf('export async function getOrCreateStack');
    const body = text.slice(start, text.indexOf('\nexport ', start + 1));
    const ensure = body.indexOf('await ensureStatePassphrase(');
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(body.indexOf('LocalWorkspace.'));
    expect(ensure).toBeLessThan(body.indexOf('buildEnv('));
  });
});

// (c) behavioral: the real iac layer over a mocked LocalWorkspace.
const seenEnvs: Record<string, string | undefined>[] = [];
const fakeStack = () => ({
  preview: async () => ({ changeSummary: {} }),
  up: async () => ({ outputs: { masterIp: { value: '1.2.3.4' } }, summary: {} }),
  refresh: async () => undefined,
  cancel: async () => undefined,
  destroy: async () => ({ summary: { result: 'succeeded', resourceChanges: { delete: 1 } } }),
  outputs: async () => ({ masterIp: { value: '1.2.3.4' } }),
  exportStack: async () => ({
    version: 3,
    deployment: {
      manifest: {},
      resources: [
        {
          urn: 'urn:pulumi:prod::proj::hcloud:index/server:Server::server',
          type: 'hcloud:index/server:Server',
          id: 'old',
          inputs: { serverType: 'cx22' },
          outputs: { id: 'old', serverType: 'cx22', ipv4Address: '9.9.9.9' },
        },
      ],
    },
  }),
  importStack: async () => undefined,
  workspace: { removeStack: async () => undefined },
});
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: async (_args: unknown, ws: { envVars: Record<string, string | undefined> }) => {
      seenEnvs.push(ws.envVars);
      return fakeStack();
    },
    createStack: async () => {
      throw new Error('createStack must not be called');
    },
    create: async (ws: { envVars: Record<string, string | undefined> }) => {
      seenEnvs.push(ws.envVars);
      return { listStacks: async () => [], whoAmI: async () => 'me' };
    },
  },
}));

const { upStack, getStackOutputs, destroyStack, removeStackState, listStacks, openStateBackend } =
  await import('../../../src/lib/iac/index.js');
const { syncServerState } = await import('../../../src/lib/iac/server-state.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { __resetStatePassphraseForTests } = await import('../../../src/lib/state-passphrase.js');

/**
 * What the pulumi child receives: the Automation SDK spawns it with
 * {...process.env, ...envVars}, so an inherited value survives unless the
 * workspace env overrides it with undefined. Node drops undefined at spawn.
 */
const childEnv = (env: Record<string, string | undefined>) => ({ ...process.env, ...env });

const S3 = {
  bucket: 'b',
  stateBucket: 'b-pulumi-state',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  accessKey: 'AKIATEST',
  secretKey: 'secret',
};
const BASE = { projectName: 'proj', provider: 'hetzner', providerToken: 'tok', s3Config: S3 };

describe('state passphrase census: every decrypting entry point carries the passphrase', () => {
  let dir: string;

  beforeEach(() => {
    seenEnvs.length = 0;
    __resetStatePassphraseForTests();
    dir = createTempDir('state-passphrase-census-');
    writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
    // A shell export for another project must never win.
    vi.stubEnv('PULUMI_CONFIG_PASSPHRASE', 'another-projects-passphrase');
    vi.stubEnv('PULUMI_CONFIG_PASSPHRASE_FILE', '/nonexistent/other-passphrase');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function expectPassphraseEverywhere() {
    expect(seenEnvs.length).toBeGreaterThan(0);
    for (const env of seenEnvs) {
      const child = childEnv(env);
      expect(child.PULUMI_CONFIG_PASSPHRASE).toBe(PASSPHRASE);
      expect(child.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    }
    // The check ran: the project recorded its fingerprint.
    const manifest = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf8'));
    expect(manifest.stateEncryption?.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
  }

  it('upStack', async () => {
    await upStack('prod', async () => ({}), { ...BASE, requiredOutputs: ['masterIp'] });
    expectPassphraseEverywhere();
  });

  it('getStackOutputs', async () => {
    await getStackOutputs('prod', async () => ({}), BASE);
    expectPassphraseEverywhere();
  });

  it('destroyStack', async () => {
    await destroyStack('prod', async () => ({}), BASE);
    expectPassphraseEverywhere();
  });

  it('syncServerState', async () => {
    await syncServerState('prod', { serverId: '1', serverType: 'cx23', ip: '1.2.3.4' }, BASE);
    expectPassphraseEverywhere();
  });

  it('converge preview and up', async () => {
    mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
    const Provider = {
      getK8sProgram: async () => async () => ({}),
      promptObjectStorageCredentials: async () => ({ accessKey: 'AK', secretKey: 'SK' }),
      assertAmd64ServerType: (type: string, source: string) =>
        HetznerProvider.assertAmd64ServerType(type, source),
    };
    await convergeClusterInfra({
      projectConfig: { projectName: 'proj', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
      envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cx23', provider: 'hetzner' },
      apiToken: 'tok',
      clusterEnv: 'census-cluster',
      clusterRegion: 'fsn1',
      environment: 'census-cluster',
      isHA: false,
      overrides: {},
      s3Creds: null,
      Provider,
    });
    // probe + preview + up: three workspaces, all with the passphrase.
    expect(seenEnvs.length).toBeGreaterThanOrEqual(3);
    expectPassphraseEverywhere();
  });

  describe('callers that decrypt nothing work with no passphrase at all', () => {
    beforeEach(() => {
      vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', undefined);
      delete process.env.VIBECARBON_STATE_PASSPHRASE;
    });

    it('listStacks, openStateBackend and removeStackState need none, and never invent an empty one', async () => {
      await listStacks(BASE);
      await openStateBackend(BASE);
      await removeStackState('prod', BASE);
      expect(seenEnvs).toHaveLength(3);
      for (const env of seenEnvs) {
        const child = childEnv(env);
        expect(child.PULUMI_CONFIG_PASSPHRASE).toBeUndefined();
        expect(child.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
      }
      // Nothing was generated or recorded.
      expect(existsSync(join(dir, '.env.local'))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf8'))).toEqual({});
    });
  });
});
