import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

// The contract tests at the end open stacks through the real getStackOutputs
// over this stand-in for the Automation SDK.
const sdk = vi.hoisted(() => ({ select: 'missing' as 'missing' | 'unreadable' }));
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: async (args: { stackName: string }) => {
      if (sdk.select === 'missing') throw new Error(`no stack named '${args.stackName}' found`);
      return {
        name: args.stackName,
        workspace: { workDir: '/nonexistent' },
        exportStack: async () => {
          throw new Error('error: could not read checkpoint: AccessDenied: Access Denied');
        },
      };
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

import {
  classifyK3sTokenProbe,
  getStackOutputs,
  K3sTokenProbeError,
} from '../../../src/lib/iac/index.js';
import { StackHeldError } from '../../../src/lib/iac/stack-lock.js';
import { StateMigrationError, StateUndecryptableError } from '../../../src/lib/iac/state-error.js';
import {
  __resetStatePassphraseForTests,
  StatePassphraseError,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';
import { STATE_ERROR_CORPUS } from './fixtures/state-error-corpus.js';

// classifyK3sTokenProbe is the seam that decides what `vibecarbon scale`
// (k8s mode) does after probing the prior stack outputs for a recoverable
// k3sToken. The probe-and-replay path was added in PR 1AM to keep
// userData hashes stable across deploy/scale; HA initially regressed
// (see /tmp/k8s-ha-matrix.log) because the probe path silently returned
// no token and the master-replace defense had to catch it. This file
// pins the observable outcomes so a future "loosen the catch" edit can't
// turn a failed read into a minted token again: recovered replays, empty and
// missing mint, and every other failure stops the command.
describe('classifyK3sTokenProbe', () => {
  it('recovered: outputs has a non-empty k3sToken — caller replays it', () => {
    const probe = classifyK3sTokenProbe({
      outputs: { k3sToken: 'deadbeef'.repeat(8), masterIp: '1.2.3.4' },
    });
    expect(probe.status).toBe('recovered');
    expect(probe.priorK3sToken).toBe('deadbeef'.repeat(8));
  });

  it('empty: outputs is null/undefined — fresh stack with no prior up', () => {
    const probeFromNull = classifyK3sTokenProbe({ outputs: null });
    const probeFromUndef = classifyK3sTokenProbe({});
    expect(probeFromNull.status).toBe('empty');
    expect(probeFromUndef.status).toBe('empty');
    // No priorK3sToken field — caller must mint a fresh one.
    expect(probeFromNull.priorK3sToken).toBeUndefined();
    expect(probeFromUndef.priorK3sToken).toBeUndefined();
  });

  it('empty: outputs is {} — Pulumi created the stack but no successful up landed', () => {
    const probe = classifyK3sTokenProbe({ outputs: {} });
    expect(probe.status).toBe('empty');
    expect(probe.priorK3sToken).toBeUndefined();
    // Reason must surface "fresh stack" so an operator triaging logs can
    // tell this from a deploy that wrote outputs but lost k3sToken.
    expect(probe.reason).toMatch(/fresh stack|empty/i);
  });

  it('empty: outputs has other keys but no k3sToken — schema drift, surface the keys', () => {
    const probe = classifyK3sTokenProbe({
      outputs: { masterIp: '1.2.3.4', floatingIp: '5.6.7.8' },
    });
    expect(probe.status).toBe('empty');
    expect(probe.priorK3sToken).toBeUndefined();
    // Reason must list the keys we DID see so an operator can spot a
    // missing-output bug at a glance.
    expect(probe.reason).toContain('masterIp');
    expect(probe.reason).toContain('floatingIp');
  });

  it('empty: k3sToken is the empty string — treat as missing, not recovered', () => {
    // Hetzner's stack output deserializer can return '' for a key that
    // serialized to `null`/`undefined` upstream. Replaying '' would
    // produce userData drift identical to "minted a fresh token", so
    // we explicitly fall through to the empty branch.
    const probe = classifyK3sTokenProbe({ outputs: { k3sToken: '' } });
    expect(probe.status).toBe('empty');
    expect(probe.priorK3sToken).toBeUndefined();
  });

  it('empty: k3sToken is a non-string (number, object) — defensive, treat as missing', () => {
    expect(classifyK3sTokenProbe({ outputs: { k3sToken: 42 } }).status).toBe('empty');
    expect(classifyK3sTokenProbe({ outputs: { k3sToken: { foo: 'bar' } } }).status).toBe('empty');
  });

  // The only failure that may mint a token: getStackOutputs' answer for a
  // stack the state backend doesn't have (getOrCreateStack with
  // requireExisting sets `stackNotFound`). A first deploy lands here.
  it('missing: the backend has no such stack — the fresh-stack path, no token', () => {
    const notFound = Object.assign(
      new Error(
        'Pulumi stack "e4-primary" was not found in the configured state backend (s3://b). Refusing to create an empty stack in its place.',
      ),
      { stackNotFound: true },
    );
    const probe = classifyK3sTokenProbe({ error: notFound, stackName: 'e4-primary' });
    expect(probe.status).toBe('missing');
    expect(probe.priorK3sToken).toBeUndefined();
    expect(probe.reason).toBe('no stack e4-primary in the state backend yet');
  });

  // Anything else leaves a stack that may exist, holding the token the live
  // cluster runs with, unread. A fresh token would reach every new node's
  // user data and none could join, so the command stops (R22).
  describe('any other probe failure stops the command, never mints', () => {
    it('names the stack and what failed (first line only), and says rerunning is safe', () => {
      const cause = new Error('S3 backend unreachable\n  retry attempt 3 failed\n  giving up');
      let thrown: unknown;
      try {
        classifyK3sTokenProbe({ error: cause, stackName: 'e4-primary' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(K3sTokenProbeError);
      const err = thrown as Error;
      expect(err.cause).toBe(cause);
      expect(err.message).toBe(
        "Couldn't read the k3s join token for e4-primary from its Pulumi state: S3 backend unreachable. " +
          'vibecarbon stopped before creating or changing any of its servers, because a new token would leave new nodes unable to join the cluster. ' +
          'Running this again is safe.',
      );
      expect(err.message).not.toContain('retry attempt 3');
      expect(err.message).not.toContain('—');
    });

    it.each([
      [
        'backpressure retries ran out',
        'error: blob (code=Unknown): SlowDown: Please reduce your request rate.',
      ],
      ['a non-backpressure backend error', 'error: could not read checkpoint: AccessDenied'],
      ['a plain string rejection', 'boom'],
    ])('%s', (_label, message) => {
      expect(() => classifyK3sTokenProbe({ error: new Error(message), stackName: 'e1' })).toThrow(
        K3sTokenProbeError,
      );
    });

    it("a 'no stack named' line without getOrCreateStack's flag is not proof the stack is missing", () => {
      expect(() =>
        classifyK3sTokenProbe({ error: new Error("error: no stack named 'e1' found") }),
      ).toThrow(K3sTokenProbeError);
    });

    it('error wins over outputs: if both are set, it stops (defensive)', () => {
      expect(() =>
        classifyK3sTokenProbe({ outputs: { k3sToken: 'abc' }, error: new Error('partial state') }),
      ).toThrow(K3sTokenProbeError);
    });

    it('without a stack name it still says what failed', () => {
      expect(() => classifyK3sTokenProbe({ error: new Error('boom') })).toThrow(
        "Couldn't read the k3s join token for this cluster from its Pulumi state: boom.",
      );
    });
  });

  // A state this project's passphrase cannot read still holds the cluster's
  // token: minting on it would let the caller carry a fresh one, and a later call
  // in the same run that CAN read the state (the one-time legacy migration
  // re-encrypts it on first open) would carry that token onto a live cluster
  // whose nodes then cannot join. The probe rethrows instead.
  describe('a passphrase failure is rethrown, never classified', () => {
    const passphraseMessages = STATE_ERROR_CORPUS.filter(
      (c) => c.expect.cause === 'passphrase',
    ).map((c) => c.message);

    it('rethrows every raw Pulumi passphrase refusal from the corpus, as the same object', () => {
      expect(passphraseMessages.length).toBeGreaterThanOrEqual(2);
      for (const message of passphraseMessages) {
        const error = new Error(message);
        let thrown: unknown;
        try {
          classifyK3sTokenProbe({ error });
        } catch (err) {
          thrown = err;
        }
        expect(thrown, message).toBe(error);
      }
    });

    it('rethrows the typed errors: the pre-Pulumi check and an undecryptable stack', () => {
      const missing = new StatePassphraseError(
        'missing',
        "This project's state passphrase isn't set.",
      );
      expect(() => classifyK3sTokenProbe({ error: missing })).toThrow(missing);
      const undecryptable = new StateUndecryptableError('e4-primary');
      expect(() => classifyK3sTokenProbe({ error: undecryptable })).toThrow(undecryptable);
    });

    it('rethrows even when outputs came back alongside the error', () => {
      const error = new StateUndecryptableError('e4-primary');
      expect(() => classifyK3sTokenProbe({ outputs: { k3sToken: 'abc' }, error })).toThrow(error);
    });
  });

  // The first open of a legacy stack migrates it, and that can stop for a
  // reason that clears on the next open in the same process: the child
  // re-encrypted the state and then exited non-zero, or another run held the
  // stack's lock and has since finished. Minting here would put a token in,
  // and the up's own open, reading the state after all, would carry it onto
  // the live cluster. Neither is a passphrase failure (destroy keeps the
  // record), and both are rethrown like one.
  describe('a stopped migration or a stack another run holds is rethrown, never classified', () => {
    const stopped = () =>
      new StateMigrationError(
        'Stopped while re-encrypting the Pulumi state for e4-primary: error: could not import deployment.',
        { cause: new Error('error: could not import deployment') },
      );
    const held = () =>
      new StackHeldError('e4-primary', [
        { user: 'someone', host: 'laptop', pid: 4242, at: '2026-11-11T10:00:00Z' },
      ]);

    it.each([
      ['a migration that stopped', stopped],
      ['a stack another run holds', held],
      ["either, inside a caller's wrapper", () => new Error('probe failed', { cause: held() })],
    ])('%s: the same object is thrown', (_label, make) => {
      const error = make();
      let thrown: unknown;
      try {
        classifyK3sTokenProbe({ error });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBe(error);
    });

    it('rethrows even when outputs came back alongside the error', () => {
      const error = stopped();
      expect(() => classifyK3sTokenProbe({ outputs: { k3sToken: 'abc' }, error })).toThrow(error);
    });
  });
});

// The flag the classifier trusts is set by getOrCreateStack, and only for a
// stack the backend says it doesn't have. A stack that is there but whose
// state read fails is never "missing" (final re-review, minor 1).
describe('classifyK3sTokenProbe on what getStackOutputs really throws', () => {
  const PASSPHRASE = 'Y29udHJhY3Rjb250cmFjdGNvbnRyYWN0Y29udHJhY3Rj';
  const read = async () => {
    const projectDir = createTempDir('probe-classify-contract-');
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } })}\n`,
    );
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
    __resetStatePassphraseForTests();
    return getStackOutputs('e4-primary', async () => ({}), {
      projectName: 'proj',
      projectDir,
    }).catch((e: Error) => e);
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a stack the backend does not have: missing', async () => {
    sdk.select = 'missing';
    const error = await read();
    expect(classifyK3sTokenProbe({ error, stackName: 'e4-primary' }).status).toBe('missing');
  });

  it("a stack whose state read fails after the select: stops, naming the backend's error", async () => {
    sdk.select = 'unreadable';
    const error = await read();
    expect(() => classifyK3sTokenProbe({ error, stackName: 'e4-primary' })).toThrow(
      /^Couldn't read the k3s join token for e4-primary from its Pulumi state: error: could not read checkpoint: AccessDenied/,
    );
  });
});
