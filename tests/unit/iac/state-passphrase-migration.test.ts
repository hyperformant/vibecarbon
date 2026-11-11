/**
 * The one-time migration of a legacy stack, one written with the empty
 * passphrase every stack had before the per-project passphrase, on its first
 * open in a process (getOrCreateStack; remove with it after 2027-02-11).
 *
 * The probe is a full export: `stack output` and a plain export succeed under
 * a wrong passphrase. Only a passphrase refusal sends the stack through
 * `pulumi stack change-secrets-provider passphrase`, with '' in the child's
 * environment and the project's passphrase on its stdin, never in its argv.
 * The probe's export is then what the up path reads instead of exporting
 * again.
 *
 * The iac layer runs for real over the shared fake Pulumi workspace, with the
 * migration child routed to its fake spawn. The real engine's answer is
 * tests/integration/iac/state-passphrase.test.ts.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_PULUMI_COMMAND,
  fakePulumi,
  fakeWorkDir,
} from '../../_shared/fake-pulumi-workspace.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { STATE_ERROR_CORPUS } from './fixtures/state-error-corpus.js';

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);
vi.mock('node:child_process', async (orig) =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeChildProcessModule(
    await orig<typeof import('node:child_process')>(),
  ),
);

const infos: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = await orig<typeof import('@clack/prompts')>();
  return { ...actual, log: { ...actual.log, info: (m: string) => infos.push(m) } };
});

// The perf spans each step opens, in order.
const spans: string[] = [];
vi.mock('../../../src/lib/perf.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/perf.js')>();
  return {
    ...actual,
    perfAsync: (name: string, fn: () => unknown) => {
      spans.push(name);
      return actual.perfAsync(name, fn as () => Promise<unknown>);
    },
  };
});

const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const refusal = (id: string) => () => {
  const found = STATE_ERROR_CORPUS.find((c) => c.id === id);
  if (!found) throw new Error(`no corpus entry '${id}'`);
  return new Error(found.message);
};
const exportRefusal = refusal('passphrase-incorrect-on-export');

const { destroyStack, getOrCreateStack, getStackOutputs, removeStackState, upStack } = await import(
  '../../../src/lib/iac/index.js'
);
const { __resetStateProbesForTests } = await import('../../../src/lib/iac/index.js');
const { StateUndecryptableError } = await import('../../../src/lib/iac/state-error.js');
const { __resetStatePassphraseForTests } = await import('../../../src/lib/state-passphrase.js');

const S3 = {
  bucket: 'proj-storage',
  stateBucket: 'proj-state',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  accessKey: 'AKIASTATE',
  secretKey: 'state-secret',
};
const BASE = { projectName: 'proj', s3Config: S3 };
const MIGRATED =
  "Your Pulumi state for e1 was stored with an empty passphrase. vibecarbon re-encrypted it with this project's passphrase.";

/** A server in the state, so the up path's refresh has something to reconcile. */
const POPULATED = {
  deployment: {
    resources: [
      { urn: 'urn:pulumi:e1::proj::pulumi:pulumi:Stack::proj-e1', type: 'pulumi:pulumi:Stack' },
      {
        urn: 'urn:pulumi:e1::proj::hcloud:index/server:Server::master',
        type: 'hcloud:index/server:Server',
        id: '21',
      },
    ],
  },
};

let logged: string[];

beforeEach(() => {
  fakePulumi.reset();
  infos.length = 0;
  spans.length = 0;
  __resetStatePassphraseForTests();
  __resetStateProbesForTests();
  const dir = createTempDir('state-passphrase-migration-');
  writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
  // A shell export for another project: the migration child must see neither.
  vi.stubEnv('PULUMI_CONFIG_PASSPHRASE', 'another-projects-passphrase');
  vi.stubEnv('PULUMI_CONFIG_PASSPHRASE_FILE', '/home/someone/other-passphrase');
  // progressLog's line when no spinner is running.
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('first open of a stack: a full export, and a migration only on a passphrase refusal', () => {
  it('a state the project passphrase reads: one export, no migration, nothing said', async () => {
    await getStackOutputs('e1', async () => ({}), BASE);

    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'outputs']);
    expect(fakePulumi.migrations).toEqual([]);
    expect(spans).toEqual(['state.passphraseProbe']);
    expect(infos).toEqual([]);
  });

  it('a legacy stack: re-encrypted by the CLI with the passphrase on stdin only, then read', async () => {
    fakePulumi.legacy('e1', exportRefusal);

    await expect(getStackOutputs('e1', async () => ({}), BASE)).resolves.toEqual({});

    // Probe, migrate, probe again, then the caller's own read.
    expect(fakePulumi.calls).toEqual([
      'select:e1',
      'exportStack',
      'migrate:e1',
      'exportStack',
      'outputs',
    ]);
    const [m, ...more] = fakePulumi.migrations;
    expect(more).toEqual([]);
    expect(m.command).toBe(FAKE_PULUMI_COMMAND);
    expect(m.args).toEqual([
      'stack',
      'change-secrets-provider',
      'passphrase',
      '--stack',
      'e1',
      '--non-interactive',
    ]);
    // SECURITY: the new passphrase travels on stdin, never in argv (a process
    // listing shows argv to every local user).
    expect(m.stdin).toBe(PASSPHRASE);
    expect(m.args.join(' ')).not.toContain(PASSPHRASE);
    // The old passphrase is the empty one, and nothing inherited overrides it.
    expect(m.env.PULUMI_CONFIG_PASSPHRASE).toBe('');
    expect('PULUMI_CONFIG_PASSPHRASE_FILE' in m.env).toBe(false);
    expect(Object.values(m.env)).not.toContain(PASSPHRASE);
    // Same workspace, same backend and credentials as the stack it migrates.
    expect(m.cwd).toBe(fakeWorkDir('e1'));
    expect(m.env.AWS_ACCESS_KEY_ID).toBe('AKIASTATE');
    expect(m.env.PULUMI_SKIP_UPDATE_CHECK).toBe('true');

    expect(spans).toEqual([
      'state.passphraseProbe',
      'state.passphraseMigrate',
      'state.passphraseProbe',
    ]);
    expect(infos).toEqual([MIGRATED]);
    expect([...infos, ...logged].join('\n')).not.toContain(PASSPHRASE);
  });

  it('once per process per stack: a second open reads nothing first, and migrates nothing again', async () => {
    fakePulumi.legacy('e1', exportRefusal);
    await getStackOutputs('e1', async () => ({}), BASE);
    fakePulumi.calls.length = 0;

    await getStackOutputs('e1', async () => ({}), BASE);

    expect(fakePulumi.calls).toEqual(['select:e1', 'outputs']);
    expect(fakePulumi.migrations).toHaveLength(1);
    expect(infos).toEqual([MIGRATED]);
  });

  it('the memo is per stack and per backend: another stack, or the same name elsewhere, is probed', async () => {
    await getStackOutputs('e1', async () => ({}), BASE);
    await getStackOutputs('e2', async () => ({}), BASE);
    await getStackOutputs('e1', async () => ({}), {
      ...BASE,
      s3Config: { ...S3, stateBucket: 'other-state' },
    });
    await getStackOutputs('e1', async () => ({}), { ...BASE, projectName: 'other' });

    expect(fakePulumi.calls.filter((c) => c === 'exportStack')).toHaveLength(4);
  });

  it('first opens at the same time share one probe and one migration', async () => {
    fakePulumi.legacy('e1', exportRefusal);

    await Promise.all([
      getStackOutputs('e1', async () => ({}), BASE),
      getStackOutputs('e1', async () => ({}), BASE),
    ]);

    expect(fakePulumi.migrations).toHaveLength(1);
    expect(fakePulumi.calls.filter((c) => c === 'exportStack')).toHaveLength(2);
    expect(infos).toEqual([MIGRATED]);
  });

  it("a state '' does not open either: the typed error, Pulumi's line logged once, and the next open tries again", async () => {
    const raw = exportRefusal();
    fakePulumi.behaviour.exportStack = () => {
      throw raw;
    };

    const err = await getStackOutputs('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect((err as Error).message).toContain("can't decrypt the Pulumi state for e1");
    expect((err as Error).message).toContain('`vibecarbon destroy e1`');
    // The refusal of the project's own passphrase is what the error is about.
    expect((err as Error & { cause?: unknown }).cause).toBe(raw);
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1']);
    expect(logged.filter((l) => l.includes('refused the state passphrase'))).toHaveLength(1);
    expect(logged.join('\n')).toContain('could not deserialize deployment');
    expect(logged.join('\n')).not.toContain(PASSPHRASE);
    expect(infos).toEqual([]);

    // A failure is not remembered: a later open asks again.
    fakePulumi.calls.length = 0;
    await getStackOutputs('e1', async () => ({}), BASE).catch(() => {});
    expect(fakePulumi.calls.slice(0, 2)).toEqual(['select:e1', 'exportStack']);
  });

  it('a migration that reports success but leaves the state unreadable is the typed error', async () => {
    fakePulumi.behaviour.exportStack = () => {
      throw exportRefusal();
    };
    fakePulumi.behaviour.migrate = () => ({ code: 0 });

    const err = await getStackOutputs('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateUndecryptableError);
    // The second probe is what found out.
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1', 'exportStack']);
    expect(infos).toEqual([]);
  });

  it('any other read failure is not a passphrase question: no migration, thrown as it is', async () => {
    const other = new Error('error: could not read bucket: blob (code=Unknown): connection reset');
    fakePulumi.behaviour.exportStack = () => {
      throw other;
    };

    await expect(getStackOutputs('e1', async () => ({}), BASE)).rejects.toBe(other);
    expect(fakePulumi.migrations).toEqual([]);
    expect(fakePulumi.calls).not.toContain('outputs');
  });

  it('a caller that decrypts nothing never probes: removing a record needs no passphrase', async () => {
    fakePulumi.legacy('e1', exportRefusal);

    await removeStackState('e1', BASE);

    expect(fakePulumi.calls).toEqual(['select:e1', 'removeStack:e1:{"force":true}']);
    expect(fakePulumi.migrations).toEqual([]);
  });

  it('every opener goes through it, getOrCreateStack itself included', async () => {
    fakePulumi.legacy('e1', exportRefusal);

    await getOrCreateStack('e1', async () => ({}), { ...BASE, requireExisting: true });

    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1', 'exportStack']);
  });
});

describe('destroy of a legacy stack: migrated, then destroyed through Pulumi', () => {
  it('the record goes with the destroy, never through the unreadable path', async () => {
    fakePulumi.legacy('e1', refusal('passphrase-incorrect-on-refresh'));

    const result = await destroyStack('e1', async () => ({}), BASE);

    expect(result).toMatchObject({ destroyed: true });
    expect(fakePulumi.calls).toEqual([
      'select:e1',
      'exportStack',
      'migrate:e1',
      'exportStack',
      'refresh',
      'exportStack',
      'destroy',
      // Pulumi's own removal of a destroyed stack, not `stack rm --force`.
      'removeStack:e1:undefined',
    ]);
    expect(infos).toEqual([MIGRATED]);
  });
});

describe('upStack and prepareStackForUp: a refused passphrase is the typed error, never raw text', () => {
  it('an unreadable stack stops at the open: no refresh, no up', async () => {
    fakePulumi.refuseReads(exportRefusal);

    const err = await upStack('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1']);
  });

  it('a refresh that refuses it stops the up with the typed error', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(POPULATED);
    fakePulumi.behaviour.refresh = () => {
      throw refusal('passphrase-incorrect-on-refresh')();
    };

    const err = await upStack('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect(fakePulumi.calls).not.toContain('up');
    expect(logged.filter((l) => l.includes('refused the state passphrase'))).toHaveLength(1);
  });

  it('an up that refuses it is the typed error', async () => {
    fakePulumi.behaviour.up = () => {
      throw refusal('passphrase-incorrect-on-up')();
    };

    const err = await upStack('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect((err as Error).message).toContain('Pulumi state for e1');
  });

  it('a legacy stack migrates on the open and the up goes ahead', async () => {
    fakePulumi.legacy('e1', exportRefusal);

    await upStack('e1', async () => ({}), BASE);

    expect(fakePulumi.calls).toContain('up');
    expect(fakePulumi.migrations).toHaveLength(1);
  });
});

describe("the probe's export is the up path's read", () => {
  it('Hetzner: the refresh check reads the probe, no second export', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(POPULATED);

    await upStack('e1', async () => ({}), { ...BASE, provider: 'hetzner', providerToken: 't' });

    const beforeRefresh = fakePulumi.calls.slice(0, fakePulumi.calls.indexOf('refresh'));
    expect(beforeRefresh).toEqual(['select:e1', 'exportStack']);
  });

  it('DigitalOcean: one export serves the probe, the retired-resource surgery and the refresh check', async () => {
    const urn = (type: string, name: string) => `urn:pulumi:e1::proj::${type}::${name}`;
    fakePulumi.behaviour.exportStack = () => ({
      deployment: {
        resources: [
          ...POPULATED.deployment.resources,
          {
            urn: urn('digitalocean:index/reservedIp:ReservedIp', 'ingress'),
            type: 'digitalocean:index/reservedIp:ReservedIp',
            id: '203.0.113.9',
            outputs: { ipAddress: '203.0.113.9' },
          },
        ],
      },
    });

    await upStack('e1', async () => ({}), {
      ...BASE,
      provider: 'digitalocean',
      providerToken: 't',
    });

    const beforeRefresh = fakePulumi.calls.slice(0, fakePulumi.calls.indexOf('refresh'));
    expect(beforeRefresh).toEqual(['select:e1', 'exportStack', 'importStack']);
  });

  it('only the open that probed reuses it: a later up in the process reads the state afresh', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(POPULATED);
    await upStack('e1', async () => ({}), BASE);
    fakePulumi.calls.length = 0;

    await upStack('e1', async () => ({}), BASE);

    // No probe this time (memo), so the refresh check exports for itself.
    const beforeRefresh = fakePulumi.calls.slice(0, fakePulumi.calls.indexOf('refresh'));
    expect(beforeRefresh).toEqual(['select:e1', 'exportStack']);
    expect(spans.filter((s) => s === 'state.passphraseProbe')).toHaveLength(1);
  });
});
