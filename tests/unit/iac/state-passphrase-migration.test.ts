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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
const { isStatePassphraseFailure, StateUndecryptableError } = await import(
  '../../../src/lib/iac/state-error.js'
);
const { StackHeldError } = await import('../../../src/lib/iac/stack-lock.js');
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
    // Read, '' refused, and read once more in case another run re-encrypted
    // it in between: still refused.
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1', 'exportStack']);
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

/**
 * `change-secrets-provider` writes the state, so it takes the stack's lock
 * (`stack export` does not), and it writes through the same store as every
 * other state call. CLI 3.259.0's lock refusal, for a holder this machine
 * cannot see.
 */
const lockRefusal = (holder: { host: string; pid: number; at: string }) =>
  'error: the stack is currently locked by 1 lock(s). Either wait for the other process(es) ' +
  'to end or delete the lock file with `pulumi cancel`.\n' +
  `  s3://proj-state/.pulumi/locks/organization/proj/e1/0b1c2d3e.json: created by someone@${holder.host} (pid ${holder.pid}) at ${holder.at}\n`;
// Past the two-hour expiry: gone, whoever held it.
const STALE = { host: 'ci-runner-long-gone', pid: 4321, at: '2026-01-01T00:00:00Z' };
// This very process, just now: alive.
const live = () => ({ host: hostname(), pid: process.pid, at: new Date().toISOString() });
const THROTTLED =
  'error: could not import deployment: 503 SlowDown: Please reduce your request rate\n';
const STORE_FAULT =
  'error: could not import deployment: write s3://proj-state/.pulumi/stacks/proj/e1.json: ' +
  'RequestError: send request failed\ncaused by: connection reset by peer\n';
// What change-secrets-provider prints for a wrong old passphrase.
const MIGRATION_REFUSAL =
  'error: could not deserialize deployment: failed to decrypt: incorrect passphrase, please set ' +
  'PULUMI_CONFIG_PASSPHRASE to the correct passphrase or set PULUMI_CONFIG_PASSPHRASE_FILE to a ' +
  'file containing the passphrase\n';

/**
 * A legacy stack whose first migration runs end with `failures`, in order;
 * the run after them re-encrypts it.
 */
function legacyMigratingAfter(...failures: string[]) {
  fakePulumi.legacy('e1', exportRefusal);
  let run = 0;
  fakePulumi.behaviour.migrate = (name) => {
    const stderr = failures[run++];
    if (stderr !== undefined) return { code: 1, stderr };
    fakePulumi.legacyStacks.delete(name);
    return { code: 0 };
  };
}

describe('a migration that fails for any reason but the passphrase is never ruled unreadable', () => {
  it('a lock a dead run left: cleared, migrated on the next run, then read', async () => {
    legacyMigratingAfter(lockRefusal(STALE));

    await expect(getStackOutputs('e1', async () => ({}), BASE)).resolves.toEqual({});

    expect(fakePulumi.calls).toEqual([
      'select:e1',
      'exportStack',
      'migrate:e1',
      'cancel',
      'migrate:e1',
      'exportStack',
      'outputs',
    ]);
    expect(infos).toEqual([MIGRATED]);
  });

  it('a lock a live run holds: StackHeldError, the lock left alone, and the next open tries again', async () => {
    legacyMigratingAfter(lockRefusal(live()));

    const err = await getStackOutputs('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StackHeldError);
    expect(err).not.toBeInstanceOf(StateUndecryptableError);
    expect((err as Error).message).toContain('Stack "e1" is in use by another run');
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1']);
    expect(infos).toEqual([]);

    fakePulumi.calls.length = 0;
    await getStackOutputs('e1', async () => ({}), BASE);
    expect(fakePulumi.calls).toEqual([
      'select:e1',
      'exportStack',
      'migrate:e1',
      'exportStack',
      'outputs',
    ]);
  });

  it("the store pushing back: retried on the state backend's backoff, then migrated", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      legacyMigratingAfter(THROTTLED);

      const open = getStackOutputs('e1', async () => ({}), BASE);
      // The backoff starts once the first run has exited and been logged.
      await vi.waitFor(() => expect(logged.join('\n')).toContain('attempt 1/5'));
      await vi.advanceTimersByTimeAsync(2000);
      await expect(open).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }

    expect(fakePulumi.calls.filter((c) => c === 'migrate:e1')).toHaveLength(2);
    expect(fakePulumi.calls).not.toContain('cancel');
    expect(logged.join('\n')).toContain(
      're-encrypting the Pulumi state for e1: state backend throttle (attempt 1/5)',
    );
    expect(infos).toEqual([MIGRATED]);
  });

  it("anything else: a plain error naming the step with Pulumi's line, never the typed one", async () => {
    legacyMigratingAfter(STORE_FAULT);

    const err = await getStackOutputs('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StateUndecryptableError);
    expect(err).not.toBeInstanceOf(StackHeldError);
    expect(isStatePassphraseFailure(err)).toBe(false);
    expect((err as Error).message).toBe(
      'Stopped while re-encrypting the Pulumi state for e1: error: could not import deployment: ' +
        'write s3://proj-state/.pulumi/stacks/proj/e1.json: RequestError: send request failed. ' +
        'Running this again is safe.',
    );
    // One run, not retried, and no read after it: '' was never refused.
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1']);
    expect(logged.join('\n')).not.toContain('refused the state passphrase');
    expect(infos).toEqual([]);
  });

  it("this run's own migration finished before its child exited non-zero: the retry is refused, the re-read opens it, and it says so once", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      fakePulumi.legacy('e1', exportRefusal);
      let run = 0;
      fakePulumi.behaviour.migrate = (name) => {
        if (run++ === 0) {
          // The state was written; the store's answer to the child was not.
          fakePulumi.legacyStacks.delete(name);
          return { code: 1, stderr: THROTTLED };
        }
        return { code: 1, stderr: MIGRATION_REFUSAL };
      };

      const open = getStackOutputs('e1', async () => ({}), BASE);
      await vi.waitFor(() => expect(logged.join('\n')).toContain('attempt 1/5'));
      await vi.advanceTimersByTimeAsync(2000);
      await expect(open).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }

    expect(fakePulumi.calls.filter((c) => c === 'migrate:e1')).toHaveLength(2);
    expect(infos).toEqual([MIGRATED]);
  });

  it('a migration that finished but stopped the open with an error: the next open in this process says so once, then stays quiet', async () => {
    fakePulumi.legacy('e1', exportRefusal);
    fakePulumi.behaviour.migrate = (name) => {
      fakePulumi.legacyStacks.delete(name);
      return { code: 1, stderr: STORE_FAULT };
    };

    await expect(getStackOutputs('e1', async () => ({}), BASE)).rejects.toThrow(
      'Stopped while re-encrypting',
    );
    expect(infos).toEqual([]);

    await getStackOutputs('e1', async () => ({}), BASE);
    expect(infos).toEqual([MIGRATED]);

    await getStackOutputs('e1', async () => ({}), BASE);
    expect(infos).toEqual([MIGRATED]);
  });

  it("another run re-encrypted it first: '' is refused, the project's passphrase reads it now, and the open goes on", async () => {
    let reads = 0;
    fakePulumi.behaviour.exportStack = () => {
      reads += 1;
      if (reads === 1) throw exportRefusal();
      return structuredClone(POPULATED);
    };
    // Not marked legacy: the fake child refuses '', as the CLI does once the
    // other run has re-encrypted it.

    await expect(
      upStack('e1', async () => ({}), { ...BASE, provider: 'hetzner', providerToken: 't' }),
    ).resolves.toBeDefined();

    // The read after the refusal is what the up path reads: no third export
    // before the refresh.
    const beforeRefresh = fakePulumi.calls.slice(0, fakePulumi.calls.indexOf('refresh'));
    expect(beforeRefresh).toEqual(['select:e1', 'exportStack', 'migrate:e1', 'exportStack']);
    expect(fakePulumi.calls).toContain('up');
    expect(logged.join('\n')).not.toContain('refused the state passphrase');
    // The run that re-encrypted it said so; this one has nothing to add.
    expect(infos).toEqual([]);
  });
});

describe("a failed run never leaves a new salt in the stack's workspace", () => {
  const SALTED = 'encryptionsalt: v1:bmV3c2FsdA==:v1:written-by-the-failed-run\n';
  let settings: string;

  beforeEach(() => {
    fakePulumi.workDirRoot = createTempDir('fake-pulumi-workdirs-');
    settings = join(fakeWorkDir('e1'), 'Pulumi.e1.yaml');
  });

  /**
   * As the CLI does: a new salt in Pulumi.e1.yaml before it touches the
   * state, whatever comes after. Records what each run found there.
   */
  function migrateWritingSalt(endings: Array<{ code: number; stderr?: string }>) {
    const found: Array<string | null> = [];
    fakePulumi.behaviour.migrate = (name, child) => {
      const file = join(child.cwd ?? '', 'Pulumi.e1.yaml');
      found.push(existsSync(file) ? readFileSync(file, 'utf8') : null);
      writeFileSync(file, SALTED);
      const ending = endings[found.length - 1] ?? { code: 0 };
      if (ending.code === 0) fakePulumi.legacyStacks.delete(name);
      return ending;
    };
    return found;
  }

  it("put back before the stale lock's retry, and kept once a run succeeds", async () => {
    // Hetzner's workspace has a settings file of its own (IAC_STACK_CONFIG).
    const original = 'config:\n  hcloud:pollInterval: 1s\n';
    mkdirSync(fakeWorkDir('e1'), { recursive: true });
    writeFileSync(settings, original);
    fakePulumi.legacy('e1', exportRefusal);
    const found = migrateWritingSalt([{ code: 1, stderr: lockRefusal(STALE) }]);

    await getStackOutputs('e1', async () => ({}), BASE);

    expect(found).toEqual([original, original]);
    // The successful run's salt is the one the state now has.
    expect(readFileSync(settings, 'utf8')).toBe(SALTED);
  });

  it.each([
    ["'' refused (the typed error)", MIGRATION_REFUSAL, StateUndecryptableError],
    ['a live lock (StackHeldError)', null, StackHeldError],
    ['a store fault (a plain error)', STORE_FAULT, Error],
  ])('put back when the migration ends on %s', async (_label, stderr, kind) => {
    fakePulumi.legacy('e1', exportRefusal);
    migrateWritingSalt([{ code: 1, stderr: stderr ?? lockRefusal(live()) }]);

    const err = await getStackOutputs('e1', async () => ({}), BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(kind);
    // Absent before the run, absent after it.
    expect(existsSync(settings)).toBe(false);
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
    expect(fakePulumi.calls).toEqual(['select:e1', 'exportStack', 'migrate:e1', 'exportStack']);
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
