/**
 * Sealing the user data an existing server keeps plain in its stack's state
 * (lib/iac/state-seal.js), and where upStack runs it: after a successful up,
 * on a fresh export, importing only when it sealed anything, and twice then,
 * so the checkpoint Pulumi keeps as `<stack>.json.bak` is the sealed one too.
 *
 * With a deploy's ledger it also removes the history copies that still hold
 * plain values, and only then records the seal marker the k8s and compose-ha
 * gates read (infraStepSkips). It never imports over an unfinished create:
 * the deploy clears those first, once the provider (a fake here) lists
 * nothing they left running untracked (state-pending.js).
 *
 * The real engine's answer (a legacy sentinel gone from the stack file, its
 * .bak and its history, a second deploy sealing 0) is
 * tests/integration/iac/state-seal.test.ts.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rpc from '@pulumi/pulumi/runtime/rpc.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { STATE_ERROR_CORPUS } from './fixtures/state-error-corpus.js';

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);
// upStack opens the stack through getOrCreateStack, whose real passphrase
// check would write into the cwd; state-passphrase-census.test.ts covers it.
vi.mock('../../../src/lib/state-passphrase.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));
const warnings: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = await orig<typeof import('@clack/prompts')>();
  return { ...actual, log: { ...actual.log, warn: (m: string) => warnings.push(m) } };
});
const logged: string[] = [];
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (m: string) => logged.push(m),
}));
// The provider the seal asks about an unfinished server create: the servers it
// lists by name, each with the labels its own serverLabels decodes.
type Listed = { id: unknown; labels?: Record<string, string> };
const lookup = vi.hoisted(() => ({
  answer: async (_name: string): Promise<Listed[]> => [],
  calls: [] as Array<[string, unknown]>,
  made: [] as unknown[][],
  reset() {
    this.answer = async () => [];
    this.calls.length = 0;
    this.made.length = 0;
  },
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/providers/index.js')>()),
  getProvider: (...args: unknown[]) => {
    lookup.made.push(args);
    return {
      findServersByName: (name: string, options: unknown) => {
        lookup.calls.push([name, options]);
        return lookup.answer(name);
      },
      serverLabels: (server: Listed) => server.labels ?? {},
    };
  },
}));

const {
  SECRET_SIG,
  SECRET_SIG_KEY,
  infraStepSkips,
  plainValueCount,
  recordStateSeal,
  sealServerUserData,
  stateSealRecorded,
} = await import('../../../src/lib/iac/state-seal.js');
// @ts-expect-error: JS module without types
const { StateTracker } = await import('../../../src/lib/deploy/state.js');
const { SERVER_RESOURCE_TYPES } = await import('../../../src/lib/iac/create-timeout.js');
const { __resetStateProbesForTests, upStack } = await import('../../../src/lib/iac/index.js');
const { pendingReported } = await import('../../../src/lib/iac/state-pending.js');

// Sentinels only: never a real credential.
const TOKEN = 'SENTINEL-provider-token-71c2';
const K3S = 'SENTINEL-k3s-token-0d9e';
const CLOUD_INIT = `#cloud-config\nwrite_files:\n  - content: ${TOKEN} ${K3S}\n`;

/** What each provider's server keeps under its user data field. */
const USER_DATA: Record<string, unknown> = {
  'hcloud:index/server:Server': CLOUD_INIT,
  'digitalocean:index/droplet:Droplet': CLOUD_INIT,
  'vultr:index/instance:Instance': CLOUD_INIT,
  'linode:index/instance:Instance': [{ userData: Buffer.from(CLOUD_INIT).toString('base64') }],
  'scaleway:instance/server:Server': { 'cloud-init': CLOUD_INIT },
};

const envelope = (value: unknown) => ({
  [SECRET_SIG_KEY]: SECRET_SIG,
  plaintext: JSON.stringify(value),
});
const isEnvelope = (v: unknown) =>
  !!v && typeof v === 'object' && (v as Record<string, unknown>)[SECRET_SIG_KEY] === SECRET_SIG;

/** A stack's export with one server of `type` whose user data is `value` on both sides. */
function legacyState(type: string, value: unknown, stackOutputs: Record<string, unknown> = {}) {
  const field = SERVER_RESOURCE_TYPES[type as keyof typeof SERVER_RESOURCE_TYPES].userDataInput;
  return {
    version: 3,
    deployment: {
      manifest: { time: '2026-10-01T00:00:00Z', magic: 'x', version: 'v3.259.0' },
      secrets_providers: { type: 'passphrase', state: { salt: 'v1:abc' } },
      resources: [
        {
          urn: 'urn:pulumi:e1::proj::pulumi:pulumi:Stack::proj-e1',
          custom: false,
          type: 'pulumi:pulumi:Stack',
          outputs: { masterIp: '198.51.100.7', ...stackOutputs },
        },
        {
          urn: `urn:pulumi:e1::proj::${type}::master`,
          custom: true,
          id: '21',
          type,
          inputs: { name: 'proj-e1-master', [field]: structuredClone(value) },
          outputs: { name: 'proj-e1-master', [field]: structuredClone(value) },
        },
      ],
    },
  };
}

const serverOf = (state: { deployment: { resources: Record<string, unknown>[] } }) =>
  state.deployment.resources[1] as {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
  };

describe('sealServerUserData', () => {
  it("uses Pulumi's own secret signature", () => {
    expect(SECRET_SIG_KEY).toBe(rpc.specialSigKey);
    expect(SECRET_SIG).toBe(rpc.specialSecretSig);
  });

  it('every server class has a user data shape here', () => {
    expect(Object.keys(USER_DATA).sort()).toEqual(Object.keys(SERVER_RESOURCE_TYPES).sort());
  });

  it.each(Object.keys(USER_DATA))(
    '%s: seals plain user data on both sides, keeps its value, leaves the rest alone',
    (type) => {
      const field = SERVER_RESOURCE_TYPES[type as keyof typeof SERVER_RESOURCE_TYPES].userDataInput;
      const state = legacyState(type, USER_DATA[type]);
      const before = structuredClone(state);

      const { deployment, count } = sealServerUserData(state, SERVER_RESOURCE_TYPES);

      expect(count).toBe(2);
      for (const side of ['inputs', 'outputs'] as const) {
        const sealed = serverOf(deployment)[side][field] as { plaintext: string };
        expect(isEnvelope(sealed), `${side}.${field}`).toBe(true);
        expect(JSON.parse(sealed.plaintext)).toEqual(USER_DATA[type]);
        expect(serverOf(deployment)[side].name).toBe('proj-e1-master');
      }
      // No plain copy of a credential is left anywhere but in the envelopes.
      const outside = JSON.stringify(deployment, (_k, v) => (isEnvelope(v) ? '<sealed>' : v));
      expect(outside).not.toContain(TOKEN);
      expect(outside).not.toContain(Buffer.from(CLOUD_INIT).toString('base64'));
      // Pure: the export it was given is untouched.
      expect(state).toEqual(before);
    },
  );

  it.each(Object.keys(USER_DATA))('%s: a second run seals nothing (idempotent)', (type) => {
    const once = sealServerUserData(legacyState(type, USER_DATA[type]), SERVER_RESOURCE_TYPES);
    const twice = sealServerUserData(once.deployment, SERVER_RESOURCE_TYPES);
    expect(twice.count).toBe(0);
    expect(twice.deployment).toEqual(once.deployment);
  });

  it('seals a plain k3sToken Stack output, and only that output', () => {
    const state = legacyState('hcloud:index/server:Server', envelope(CLOUD_INIT), {
      k3sToken: K3S,
    });
    const { deployment, count } = sealServerUserData(state, SERVER_RESOURCE_TYPES);
    expect(count).toBe(1);
    const outputs = deployment.deployment.resources[0].outputs as Record<string, unknown>;
    expect(outputs.k3sToken).toEqual(envelope(K3S));
    expect(outputs.masterIp).toBe('198.51.100.7');
  });

  it('a sealed k3sToken and sealed user data: nothing to do', () => {
    const state = legacyState('hcloud:index/server:Server', envelope(CLOUD_INIT), {
      k3sToken: envelope(K3S),
    });
    const { deployment, count } = sealServerUserData(state, SERVER_RESOURCE_TYPES);
    expect(count).toBe(0);
    expect(deployment).toEqual(state);
  });

  it('a secret inside the value is opened, so one secret wraps the whole', () => {
    const value = [{ userData: envelope('aGVsbG8=') }];
    const state = legacyState('linode:index/instance:Instance', value);
    const { deployment, count } = sealServerUserData(state, SERVER_RESOURCE_TYPES);
    expect(count).toBe(2);
    const sealed = serverOf(deployment).inputs.metadatas as { plaintext: string };
    expect(JSON.parse(sealed.plaintext)).toEqual([{ userData: 'aGVsbG8=' }]);
  });

  it('a value holding ciphertext is left as it is: only the passphrase opens it', () => {
    const cipher = { [SECRET_SIG_KEY]: SECRET_SIG, ciphertext: 'v1:abc:def' };
    const state = legacyState('scaleway:instance/server:Server', { 'cloud-init': cipher });
    const { deployment, count } = sealServerUserData(state, SERVER_RESOURCE_TYPES);
    expect(count).toBe(0);
    expect(deployment).toEqual(state);
  });

  it('a type that is not a server class, and a server without user data, are left alone', () => {
    const state = legacyState('hcloud:index/server:Server', CLOUD_INIT);
    state.deployment.resources.push({
      urn: 'urn:pulumi:e1::proj::hcloud:index/firewall:Firewall::fw',
      custom: true,
      id: 'fw',
      type: 'hcloud:index/firewall:Firewall',
      inputs: { name: 'fw', userData: CLOUD_INIT },
      outputs: { name: 'fw', userData: CLOUD_INIT },
    });
    delete (serverOf(state).outputs as Record<string, unknown>).userData;
    const { deployment, count } = sealServerUserData(state, SERVER_RESOURCE_TYPES);
    expect(count).toBe(1);
    expect(deployment.deployment.resources[2]).toEqual(state.deployment.resources[2]);
    expect('userData' in serverOf(deployment).outputs).toBe(false);
  });

  it('a secret whose plaintext is not JSON is left alone, and nothing quotes it', () => {
    // V8's parse error quotes the text it choked on; the seal never parses
    // its way into a message. Only a secret inside the value is parsed (one
    // at the top is already sealed), so it sits in Linode's metadatas.
    const broken = { [SECRET_SIG_KEY]: SECRET_SIG, plaintext: `#cloud-config ${TOKEN}` };
    const value = [{ userData: broken }];
    const state = legacyState('linode:index/instance:Instance', value);
    let result: ReturnType<typeof sealServerUserData> | undefined;
    expect(() => {
      result = sealServerUserData(state, SERVER_RESOURCE_TYPES);
    }).not.toThrow();
    expect(result?.count).toBe(0);
    expect(serverOf(result?.deployment as typeof state).inputs.metadatas).toEqual(value);
  });

  it('plainValueCount counts the user data a pending operation still carries', () => {
    const sealed = sealServerUserData(
      legacyState('hcloud:index/server:Server', CLOUD_INIT),
      SERVER_RESOURCE_TYPES,
    ).deployment;
    expect(plainValueCount(sealed, SERVER_RESOURCE_TYPES)).toBe(0);
    const pending = withPending(sealed, CLOUD_INIT);
    expect(plainValueCount(pending, SERVER_RESOURCE_TYPES)).toBe(1);
    // The resources alone: the seal itself never wraps an operation's inputs.
    expect(sealServerUserData(pending, SERVER_RESOURCE_TYPES).count).toBe(0);
  });
});

/** The ownership labels the programs set on e1's servers (create-timeout.js SERVER_OWNER_LABELS). */
const OWN = { project: 'proj', environment: 'e1', 'managed-by': 'vibecarbon' };

/**
 * `state` with a server create an earlier run left pending, user data
 * `userData`, recording the ownership labels the programs set.
 */
function withPending(state: ReturnType<typeof legacyState>, userData: unknown) {
  const next = structuredClone(state) as ReturnType<typeof legacyState> & {
    deployment: { pending_operations?: unknown[] };
  };
  next.deployment.pending_operations = [
    {
      type: 'creating',
      resource: {
        urn: 'urn:pulumi:e1::proj::hcloud:index/server:Server::worker-1',
        custom: true,
        type: 'hcloud:index/server:Server',
        inputs: { name: 'proj-e1-worker-1', userData, labels: { ...OWN, role: 'worker' } },
      },
    },
  ];
  return next;
}

/** A legacy Hetzner compose stack, as every export of it reads before the seal. */
const LEGACY = legacyState('hcloud:index/server:Server', CLOUD_INIT);
const BASE = { projectName: 'proj', provider: 'hetzner', providerToken: 't' };
/** A state write the store refused, which nothing retries. */
const STORE_FAULT =
  'code: -2\n stdout: \n stderr: Command failed with exit code 255: pulumi stack export\n' +
  'error: state file contains errors\n';
const sealLines = () => logged.filter((l) => /\[pulumi\] sealed \d+ /.test(l));
const encryptRefusal = () => {
  const found = STATE_ERROR_CORPUS.find((c) => c.id === 'passphrase-incorrect-on-import-encrypt');
  if (!found) throw new Error('no corpus entry passphrase-incorrect-on-import-encrypt');
  return new Error(found.message);
};

describe('upStack seals the state after a successful up', () => {
  beforeEach(() => {
    fakePulumi.reset();
    __resetStateProbesForTests();
    warnings.length = 0;
    logged.length = 0;
  });

  it('a legacy stack: a fresh export after the up, then the sealed state imported twice', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);

    const { outputs } = await upStack('e1', async () => ({}), BASE);

    expect(outputs).toEqual({});
    const afterUp = fakePulumi.calls.slice(fakePulumi.calls.indexOf('up') + 1);
    expect(afterUp).toEqual(['exportStack', 'importStack', 'importStack']);
    expect(fakePulumi.imports).toHaveLength(2);
    for (const imported of fakePulumi.imports) {
      expect(imported.stack).toBe('e1');
      const server = serverOf(imported.deployment as typeof LEGACY);
      expect(isEnvelope(server.inputs.userData)).toBe(true);
      expect(isEnvelope(server.outputs.userData)).toBe(true);
    }
    // The second import is the same state: it only replaces the .bak.
    expect(fakePulumi.imports[1].deployment).toEqual(fakePulumi.imports[0].deployment);
    expect(sealLines()).toEqual([
      "[pulumi] sealed 2 plain user data and k3s token values in e1's state",
    ]);
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(warnings).toEqual([]);
  });

  it('a sealed stack: the export after the up, no import, and the count says 0', async () => {
    fakePulumi.behaviour.exportStack = () =>
      sealServerUserData(structuredClone(LEGACY), SERVER_RESOURCE_TYPES).deployment;

    await upStack('e1', async () => ({}), BASE);

    const afterUp = fakePulumi.calls.slice(fakePulumi.calls.indexOf('up') + 1);
    expect(afterUp).toEqual(['exportStack']);
    expect(fakePulumi.imports).toEqual([]);
    expect(sealLines()).toEqual([
      "[pulumi] sealed 0 plain user data and k3s token values in e1's state",
    ]);
  });

  it('nothing is sealed before the up: the only imports come after it', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);
    await upStack('e1', async () => ({}), BASE);
    const beforeUp = fakePulumi.calls.slice(0, fakePulumi.calls.indexOf('up'));
    expect(beforeUp).not.toContain('importStack');
  });

  it('a failed up seals nothing', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);
    fakePulumi.behaviour.up = () => {
      throw new Error('code: 255\n stdout: \n stderr: error: update failed\n');
    };

    await expect(upStack('e1', async () => ({}), BASE)).rejects.toThrow(/update failed/);

    const afterUp = fakePulumi.calls.slice(fakePulumi.calls.indexOf('up') + 1);
    expect(afterUp).toEqual([]);
    expect(sealLines()).toEqual([]);
  });

  it("an import refused 'failed to encrypt': the up stands, and the warning says the next deploy seals it, never that the state is lost", async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);
    fakePulumi.behaviour.importStack = () => {
      throw encryptRefusal();
    };

    const result = await upStack('e1', async () => ({}), BASE);

    expect(result.outputs).toEqual({});
    expect(warnings).toEqual([
      "Your servers in e1 are updated, but vibecarbon couldn't seal their user data in the Pulumi state: Pulumi wouldn't encrypt it with this project's state passphrase. " +
        'It stays in plain text in the state until the next successful deploy seals it.',
    ]);
    expect(warnings.join('\n')).not.toMatch(/can't be recovered|destroy|backup/);
    // Withdrawn, not counted: one attempt, no second import, no count line.
    expect(fakePulumi.calls.filter((c) => c === 'importStack')).toHaveLength(1);
    expect(sealLines()).toEqual([]);
  });

  it('an export that fails after the up: the up stands, and the warning names what failed', async () => {
    // Every read before the up works; the one after it fails.
    fakePulumi.behaviour.exportStack = () => {
      if (fakePulumi.calls.includes('up')) throw new Error(STORE_FAULT);
      return structuredClone(LEGACY);
    };

    await expect(upStack('e1', async () => ({}), BASE)).resolves.toBeDefined();

    expect(warnings).toEqual([
      "Your servers in e1 are updated, but vibecarbon couldn't seal their user data in the Pulumi state: state file contains errors. " +
        'It stays in plain text in the state until the next successful deploy seals it.',
    ]);
    expect(fakePulumi.imports).toEqual([]);
  });

  it('a second import that fails leaves the stack sealed and only logs it', async () => {
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);
    let imports = 0;
    fakePulumi.behaviour.importStack = () => {
      imports++;
      if (imports > 1) throw new Error(STORE_FAULT);
    };

    await upStack('e1', async () => ({}), BASE);

    expect(warnings).toEqual([]);
    expect(sealLines()).toHaveLength(1);
    expect(logged.join('\n')).toContain(
      "[pulumi] e1's state is sealed, but its previous copy (.bak) keeps the plain values until the next deploy",
    );
  });
});

/** A real StateTracker in its own directory, as a deploy's ledger. */
function ledgerIn(dir: string, environment = 'e1') {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  try {
    return new StateTracker('proj', environment);
  } finally {
    cwd.mockRestore();
  }
}

/** Write `latest` as one of e1's history checkpoints, with its sidecar, as Pulumi does. */
function writeHistory(backendDir: string, name: string, latest: unknown) {
  const dir = join(backendDir, '.pulumi/history/proj/e1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.checkpoint.json`);
  writeFileSync(file, JSON.stringify({ version: 3, checkpoint: { stack: 'e1', latest } }));
  writeFileSync(`${file}.attrs`, '{"user.cache_control":""}');
  writeFileSync(join(dir, `${name}.history.json`), '{"kind":"update","result":"succeeded"}');
  return file;
}

/** LEGACY as the backend writes it after the seal: user data in ciphertext. */
const CIPHERTEXT = { [SECRET_SIG_KEY]: SECRET_SIG, ciphertext: 'v1:c2VhbGVk:c2VhbGVk' };
const SEALED_LATEST = legacyState('hcloud:index/server:Server', CIPHERTEXT).deployment;

describe('with a ledger: the history copies, then the seal marker', () => {
  let backendDir: string;
  let ledgerDir: string;
  beforeEach(() => {
    fakePulumi.reset();
    __resetStateProbesForTests();
    warnings.length = 0;
    logged.length = 0;
    backendDir = createTempDir('seal-backend-');
    ledgerDir = createTempDir('seal-ledger-');
    // Never the developer's own ~/.vibecarbon/pulumi-state.
    process.env.PULUMI_BACKEND_URL = `file://${backendDir}`;
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);
  });
  afterEach(() => {
    const dir = join(backendDir, '.pulumi/history/proj/e1');
    if (existsSync(dir)) chmodSync(dir, 0o755);
  });

  it('a legacy stack: sealed, the history copy that held plain values removed with its sidecar, the rest kept, the marker set', async () => {
    const plain = writeHistory(backendDir, 'e1-1000', LEGACY.deployment);
    const sealed = writeHistory(backendDir, 'e1-2000', SEALED_LATEST);
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(fakePulumi.imports).toHaveLength(2);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(`${plain}.attrs`)).toBe(false);
    expect(existsSync(sealed)).toBe(true);
    expect(existsSync(`${sealed}.attrs`)).toBe(true);
    for (const name of ['e1-1000', 'e1-2000']) {
      expect(existsSync(join(backendDir, '.pulumi/history/proj/e1', `${name}.history.json`))).toBe(
        true,
      );
    }
    expect(logged).toContain(
      "[pulumi] removed 1 of 2 history copies of e1's state that held plain values",
    );
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
    // On disk: the next process's ledger reads it.
    expect(stateSealRecorded(ledgerIn(ledgerDir), 'e1')).toBe(true);
  });

  it('a marked stack: no history read at all', async () => {
    fakePulumi.behaviour.exportStack = () =>
      sealServerUserData(structuredClone(LEGACY), SERVER_RESOURCE_TYPES).deployment;
    const plain = writeHistory(backendDir, 'e1-1000', LEGACY.deployment);
    const ledger = ledgerIn(ledgerDir);
    recordStateSeal(ledger, 'e1');

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(existsSync(plain)).toBe(true);
    expect(logged.filter((l) => l.includes('history'))).toEqual([]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
  });

  it('a marked stack whose up found plain values again: sealed, and the plain history copies of this deploy go too', async () => {
    const plain = writeHistory(backendDir, 'e1-1000', LEGACY.deployment);
    const ledger = ledgerIn(ledgerDir);
    recordStateSeal(ledger, 'e1');

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(fakePulumi.imports).toHaveLength(2);
    expect(existsSync(plain)).toBe(false);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
  });

  it('no ledger (scale, failover): sealed, history untouched, nothing recorded', async () => {
    const plain = writeHistory(backendDir, 'e1-1000', LEGACY.deployment);

    await upStack('e1', async () => ({}), BASE);

    expect(fakePulumi.imports).toHaveLength(2);
    expect(existsSync(plain)).toBe(true);
  });

  it('a seal that fails sets no marker, and clears one a ledger had', async () => {
    fakePulumi.behaviour.importStack = () => {
      throw encryptRefusal();
    };
    const plain = writeHistory(backendDir, 'e1-1000', LEGACY.deployment);
    const fresh = ledgerIn(ledgerDir, 'e1');
    await upStack('e1', async () => ({}), { ...BASE, ledger: fresh });
    expect(stateSealRecorded(fresh, 'e1')).toBe(false);
    expect(existsSync(plain), 'no history cleanup before the stack is sealed').toBe(true);

    const marked = ledgerIn(ledgerDir, 'e1');
    recordStateSeal(marked, 'e1');
    await upStack('e1', async () => ({}), { ...BASE, ledger: marked });
    expect(stateSealRecorded(marked, 'e1')).toBe(false);
  });

  it('a second import that fails sets no marker: the .bak still holds the plain values', async () => {
    let imports = 0;
    fakePulumi.behaviour.importStack = () => {
      imports++;
      if (imports > 1) throw new Error(STORE_FAULT);
    };
    const ledger = ledgerIn(ledgerDir);
    await upStack('e1', async () => ({}), { ...BASE, ledger });
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
  });

  it('a history cleanup that fails: the deploy stands, the warning says the next deploy tries again, no marker', async () => {
    writeHistory(backendDir, 'e1-1000', LEGACY.deployment);
    chmodSync(join(backendDir, '.pulumi/history/proj/e1'), 0o000);
    const ledger = ledgerIn(ledgerDir);

    await expect(upStack('e1', async () => ({}), { ...BASE, ledger })).resolves.toBeDefined();

    expect(sealLines()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^Your servers in e1 are updated and their user data is sealed in the Pulumi state, but vibecarbon couldn't remove the older copies of that state Pulumi keeps in its history, which still hold it in plain text: .*EACCES.*\. The next deploy tries again\.$/,
    );
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
  });

  it('a marked stack that sealed values again and whose cleanup fails loses its marker, so the next deploy runs the up again', async () => {
    writeHistory(backendDir, 'e1-1000', LEGACY.deployment);
    chmodSync(join(backendDir, '.pulumi/history/proj/e1'), 0o000);
    const ledger = ledgerIn(ledgerDir);
    recordStateSeal(ledger, 'e1');

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(fakePulumi.imports).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
    expect(stateSealRecorded(ledgerIn(ledgerDir), 'e1')).toBe(false);
  });

  it('pending operations with nothing plain anywhere: nothing to import, so the stack counts as sealed', async () => {
    const sealed = sealServerUserData(structuredClone(LEGACY), SERVER_RESOURCE_TYPES).deployment;
    fakePulumi.behaviour.exportStack = () => withPending(sealed, CIPHERTEXT);
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
  });
});

/** A create of a resource vibecarbon has no lookup for, left unfinished. */
const pendingFirewall = (urnName = 'fw', name = 'proj-e1-firewall') => ({
  type: 'creating',
  resource: {
    urn: `urn:pulumi:e1::proj::hcloud:index/firewall:Firewall::${urnName}`,
    custom: true,
    type: 'hcloud:index/firewall:Firewall',
    inputs: { name },
  },
});

/** `state` with `ops` as its pending operations. */
function withOps(state: ReturnType<typeof legacyState>, ops: unknown[]) {
  const next = structuredClone(state) as ReturnType<typeof legacyState> & {
    deployment: { pending_operations?: unknown[] };
  };
  next.deployment.pending_operations = ops;
  return next;
}

/**
 * `state` as the deploy's up leaves it over each pending create in `ops`
 * whose resource the program still declares: the up made it again and tracks
 * it at the same URN under `ids[i]`, and the record stays (CLI 3.259.0, the
 * fake cloud, Task 7 review).
 */
function remadeOver(
  state: ReturnType<typeof legacyState>,
  ops: Array<{ resource: { urn: string; type: string; inputs: Record<string, unknown> } }>,
  ids: string[],
) {
  const next = withOps(state, ops);
  ops.forEach((op, i) => {
    next.deployment.resources.push({
      urn: op.resource.urn,
      custom: true,
      id: ids[i],
      type: op.resource.type,
      inputs: structuredClone(op.resource.inputs),
      outputs: structuredClone(op.resource.inputs),
    } as never);
  });
  return next;
}

/**
 * e1 exports `before` until a refresh clears its pending creates, `after`
 * from then on, as the engine does. Returns the options of each clearing
 * refresh.
 */
function clearingExports(before: unknown, after: unknown) {
  const clears: Array<Record<string, unknown>> = [];
  let cleared = false;
  fakePulumi.behaviour.refresh = (_stack, options) => {
    const opts = (options ?? {}) as Record<string, unknown>;
    if (opts.clearPendingCreates) {
      cleared = true;
      clears.push(opts);
    }
  };
  fakePulumi.behaviour.exportStack = () => structuredClone(cleared ? after : before);
  return clears;
}

const OPENING =
  'Your servers in e1 are updated, but vibecarbon left their user data in plain text in the Pulumi state.';

describe('unfinished creates: the deploy clears them itself before it seals (state-pending.js)', () => {
  let ledgerDir: string;
  beforeEach(() => {
    fakePulumi.reset();
    __resetStateProbesForTests();
    lookup.reset();
    warnings.length = 0;
    logged.length = 0;
    ledgerDir = createTempDir('seal-pending-ledger-');
    process.env.PULUMI_BACKEND_URL = `file://${createTempDir('seal-pending-backend-')}`;
  });
  /** A later deploy: a new process, the same ledger file. */
  const nextDeploy = () => {
    fakePulumi.calls.length = 0;
    fakePulumi.imports.length = 0;
    __resetStateProbesForTests();
    warnings.length = 0;
    logged.length = 0;
  };

  it('no server by that name: cleared under the lock, then sealed, and the marker set', async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(lookup.made).toEqual([['hetzner', 't']]);
    expect(lookup.calls).toEqual([['proj-e1-worker-1', { strict: true }]]);
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ clearPendingCreates: true, color: 'never' });
    const afterUp = fakePulumi.calls.slice(fakePulumi.calls.indexOf('up') + 1);
    expect(afterUp).toEqual([
      'exportStack',
      'refresh',
      'exportStack',
      'importStack',
      'importStack',
    ]);
    for (const imported of fakePulumi.imports) {
      const deployment = imported.deployment as ReturnType<typeof withOps>;
      expect(deployment.deployment.pending_operations ?? []).toEqual([]);
      expect(isEnvelope(serverOf(deployment).inputs.userData)).toBe(true);
    }
    expect(logged).toContain(
      "[pulumi] cleared 1 unfinished create from e1's state: server proj-e1-worker-1",
    );
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
  });

  it('the server listed by that name is the one the state tracks: nothing untracked, so cleared', async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);
    // The id the state records is '21'; the API answers a number.
    lookup.answer = async () => [{ id: 21, labels: OWN }];
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(clears).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
  });

  it('a server running untracked: nothing cleared or sealed, the warning names it and the console; once it is deleted, the next deploy clears and seals', async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);
    // Ours: the labels the create recorded. The other one only shares the name.
    lookup.answer = async () => [{ id: 777, labels: { ...OWN, role: 'worker' } }, { id: 778 }];
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(clears).toEqual([]);
    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([
      `${OPENING} An earlier run started creating the server proj-e1-worker-1 and didn't finish, ` +
        'and the state keeps a record of that create, which has to go before vibecarbon can seal it. ' +
        "proj-e1-worker-1 (id 777) is running in your account without Pulumi tracking it, so you're billed for it " +
        'and no vibecarbon command will remove it: delete it in your Hetzner Cloud console. ' +
        'Then deploy again: the next deploy clears the record and seals the state.',
    ]);
    expect(logged).toContain(
      '[pulumi] state seal for e1 waits on 1 unfinished create: proj-e1-worker-1 (id 777) running untracked',
    );
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
    expect(`${warnings.join('\n')}\n${logged.join('\n')}`).not.toContain(TOKEN);

    // The user deleted it in the console.
    nextDeploy();
    lookup.answer = async () => [];
    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(clears).toHaveLength(1);
    expect(fakePulumi.imports).toHaveLength(2);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledgerIn(ledgerDir), 'e1')).toBe(true);
  });

  it("a same-name server without this environment's ownership labels isn't ours: left alone, never named to delete, and the create is cleared", async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);
    lookup.answer = async () => [
      { id: 778 },
      { id: 779, labels: { ...OWN, environment: 'e2' } },
      { id: 780, labels: { ...OWN, 'managed-by': 'terraform' } },
    ];
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(lookup.calls).toEqual([['proj-e1-worker-1', { strict: true }]]);
    expect(clears).toHaveLength(1);
    expect(fakePulumi.imports).toHaveLength(2);
    expect(warnings).toEqual([]);
    expect(logged).toContain(
      '[pulumi] state seal for e1 leaves alone proj-e1-worker-1 (id 778), proj-e1-worker-1 (id 779), ' +
        "proj-e1-worker-1 (id 780): same name, but without this environment's ownership labels, so not vibecarbon's",
    );
    expect(logged).toContain(
      "[pulumi] cleared 1 unfinished create from e1's state: server proj-e1-worker-1",
    );
    expect(logged.join('\n')).not.toMatch(/delete/i);
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
  });

  it('a server create that recorded no ownership labels: never looked up; the server the up made again is the one to keep, told once, then cleared', async () => {
    const unowned = {
      type: 'creating',
      resource: {
        urn: 'urn:pulumi:e1::proj::hcloud:index/server:Server::web',
        custom: true,
        type: 'hcloud:index/server:Server',
        inputs: { name: 'proj-e1-web', userData: CLOUD_INIT },
      },
    };
    const remade = remadeOver(LEGACY, [unowned], ['22']);
    const clears = clearingExports(remade, withOps(remade, []));

    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(lookup.made).toEqual([]);
    expect(clears).toEqual([]);
    expect(warnings).toEqual([
      `${OPENING} An earlier run started creating the server proj-e1-web and didn't finish, ` +
        'and the state keeps a record of that create, which has to go before vibecarbon can seal it. ' +
        "Keep the server proj-e1-web (id 22): a later run made it again, and it's the one this project uses. " +
        "vibecarbon can't tell whether the earlier create also made another server named proj-e1-web, so check " +
        "your Hetzner Cloud console for one and delete it if it's this project's. Another server named " +
        'proj-e1-web would be billing you while it exists. Then deploy again: the next deploy clears the ' +
        'record and seals the state.',
    ]);
    expect(warnings.join('\n')).not.toContain(TOKEN);

    nextDeploy();
    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(clears).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledgerIn(ledgerDir), 'e1')).toBe(true);
  });

  it('a create vibecarbon has no lookup for, of a firewall the up made again: that one is named by id as the one to keep, only another is asked about, and the next deploy clears and seals', async () => {
    const remade = remadeOver(LEGACY, [pendingFirewall()], ['88']);
    const clears = clearingExports(remade, withOps(remade, []));

    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(lookup.made).toEqual([]);
    expect(clears).toEqual([]);
    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([
      `${OPENING} An earlier run started creating the firewall proj-e1-firewall and didn't finish, ` +
        'and the state keeps a record of that create, which has to go before vibecarbon can seal it. ' +
        "Keep the firewall proj-e1-firewall (id 88): a later run made it again, and it's the one this " +
        "project uses. vibecarbon can't tell whether the earlier create also made another firewall named " +
        "proj-e1-firewall, so check your Hetzner Cloud console for one and delete it if it's this " +
        "project's. Then deploy again: the next deploy clears the record and seals the state.",
    ]);
    // Never the bare "delete it if it's this project's" about the live one.
    expect(warnings[0]).not.toContain(
      "can't tell whether that create made the firewall proj-e1-firewall",
    );
    expect(logged).toContain(
      "[pulumi] state seal for e1 waits on 1 unfinished create: another firewall proj-e1-firewall besides id 88, which vibecarbon can't confirm",
    );
    expect(stateSealRecorded(ledgerIn(ledgerDir), 'e1')).toBe(false);

    // "Then deploy again".
    nextDeploy();
    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(clears).toHaveLength(1);
    expect(fakePulumi.imports).toHaveLength(2);
    expect(warnings).toEqual([]);
    // The clear drops the record, never the firewall the state tracks.
    for (const imported of fakePulumi.imports) {
      const resources = (imported.deployment as ReturnType<typeof withOps>).deployment.resources;
      expect(resources.find((r) => r.urn === pendingFirewall().resource.urn)).toMatchObject({
        id: '88',
      });
    }
    const after = ledgerIn(ledgerDir);
    expect(stateSealRecorded(after, 'e1')).toBe(true);
    // The report is gone with the creates it named.
    expect(pendingReported(after, 'e1', [{ urn: pendingFirewall().resource.urn }] as never)).toBe(
      false,
    );
  });

  it('a create with nothing at its URN (the program no longer declares it): told to check the console for it, then cleared', async () => {
    const clears = clearingExports(withOps(LEGACY, [pendingFirewall()]), LEGACY);

    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(clears).toEqual([]);
    expect(warnings).toEqual([
      `${OPENING} An earlier run started creating the firewall proj-e1-firewall and didn't finish, ` +
        'and the state keeps a record of that create, which has to go before vibecarbon can seal it. ' +
        "vibecarbon can't tell whether that create made the firewall proj-e1-firewall, so check your Hetzner Cloud " +
        "console for it and delete it if it's this project's. Then deploy again: the next deploy clears the record " +
        'and seals the state.',
    ]);

    nextDeploy();
    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(clears).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledgerIn(ledgerDir), 'e1')).toBe(true);
  });

  it('a create that appears after the warning is reported too, not cleared unseen', async () => {
    clearingExports(remadeOver(LEGACY, [pendingFirewall()], ['88']), LEGACY);
    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    nextDeploy();
    const clears = clearingExports(
      remadeOver(
        LEGACY,
        [pendingFirewall(), pendingFirewall('net', 'proj-e1-network')],
        ['88', '89'],
      ),
      LEGACY,
    );
    await upStack('e1', async () => ({}), { ...BASE, ledger: ledgerIn(ledgerDir) });

    expect(clears).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'Keep the firewall proj-e1-firewall (id 88) and the firewall proj-e1-network (id 89): a later run ' +
        "made them again, and they're the ones this project uses. vibecarbon can't tell whether the " +
        'earlier creates also made another firewall named proj-e1-firewall or another firewall named ' +
        "proj-e1-network, so check your Hetzner Cloud console for those and delete any that are this project's.",
    );
    expect(warnings[0]).toContain('the next deploy clears the records and seals the state.');
  });

  it("the provider can't answer: nothing cleared, the warning says the check failed and the next deploy checks again", async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);
    lookup.answer = async () => {
      throw new Error(
        "Hetzner Cloud couldn't say whether the server proj-e1-worker-1 exists: it answered HTTP 503",
      );
    };
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(clears).toEqual([]);
    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([
      `${OPENING} An earlier run started creating the server proj-e1-worker-1 and didn't finish. ` +
        'Before it drops the record of that create, vibecarbon checks whether that server exists, and the check failed ' +
        "(Hetzner Cloud couldn't say whether the server proj-e1-worker-1 exists: it answered HTTP 503). " +
        'The next deploy checks again.',
    ]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
  });

  it('a clear that fails: the seal warns as any failed seal does, nothing imported, no marker', async () => {
    fakePulumi.behaviour.exportStack = () => withPending(LEGACY, CLOUD_INIT);
    fakePulumi.behaviour.refresh = (_stack, options) => {
      if ((options as { clearPendingCreates?: boolean })?.clearPendingCreates) {
        throw new Error(STORE_FAULT);
      }
    };
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^Your servers in e1 are updated, but vibecarbon couldn't seal their user data in the Pulumi state: /,
    );
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
  });

  it('a clear that leaves a record behind: nothing imported over it, and the seal says so', async () => {
    // The engine answered the clear, but the export still lists the create.
    const clears = clearingExports(
      withPending(LEGACY, CLOUD_INIT),
      withPending(LEGACY, CLOUD_INIT),
    );
    const ledger = ledgerIn(ledgerDir);

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(clears).toHaveLength(1);
    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([
      "Your servers in e1 are updated, but vibecarbon couldn't seal their user data in the Pulumi state: " +
        'its state still records 1 unfinished operation after Pulumi cleared them. ' +
        'It stays in plain text in the state until the next successful deploy seals it.',
    ]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
  });

  it('a deploy that names no provider: no lookup at a guessed one, nothing cleared, the seal warns and waits', async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);
    const ledger = ledgerIn(ledgerDir);
    // No token either: buildEnv refuses a token it can't place.
    await upStack('e1', async () => ({}), { projectName: 'proj', ledger });

    expect(lookup.made).toEqual([]);
    expect(clears).toEqual([]);
    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([
      "Your servers in e1 are updated, but vibecarbon couldn't seal their user data in the Pulumi state: " +
        "the deploy named no provider to ask which servers e1's unfinished creates left running. " +
        'It stays in plain text in the state until the next successful deploy seals it.',
    ]);
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
  });

  it('no ledger (scale, failover): no lookup, no clear, no warning; the next deploy resolves it', async () => {
    const clears = clearingExports(withPending(LEGACY, CLOUD_INIT), LEGACY);

    await upStack('e1', async () => ({}), BASE);

    expect(lookup.made).toEqual([]);
    expect(clears).toEqual([]);
    expect(fakePulumi.imports).toEqual([]);
    expect(warnings).toEqual([]);
    expect(logged).toContain(
      '[pulumi] state seal for e1 left for the next deploy: its state records 1 unfinished create',
    );
  });
});

describe('the k8s and compose-ha gates read the seal marker (infraStepSkips)', () => {
  const INFRA = { region: 'fsn1', masterType: 'cx23', k3sVersion: 'v1.31.0+k3s1' };
  let ledgerDir: string;
  beforeEach(() => {
    fakePulumi.reset();
    __resetStateProbesForTests();
    warnings.length = 0;
    logged.length = 0;
    ledgerDir = createTempDir('seal-gate-');
    process.env.PULUMI_BACKEND_URL = `file://${createTempDir('seal-gate-backend-')}`;
    fakePulumi.behaviour.exportStack = () => structuredClone(LEGACY);
  });

  /** A ledger an older version wrote: the infra step done with these inputs, no marker. */
  function upgradedLedger() {
    const ledger = ledgerIn(ledgerDir);
    ledger.startStep('k3s-infra', INFRA);
    ledger.completeStep('k3s-infra', { masterIp: '198.51.100.7' });
    return ledger;
  }

  it('a redeploy with unchanged infra after the upgrade runs the up and seals; the next one skips', async () => {
    const ledger = upgradedLedger();
    // What the gate alone would say, and what it says with the marker.
    expect(ledger.shouldSkip('k3s-infra', INFRA)).toBe(true);
    expect(infraStepSkips(ledger, 'k3s-infra', INFRA, ['e1'])).toBe(false);

    await upStack('e1', async () => ({}), { ...BASE, ledger });
    expect(sealLines()).toEqual([
      "[pulumi] sealed 2 plain user data and k3s token values in e1's state",
    ]);

    // The next deploy, a new process: unchanged inputs, marker set, skipped.
    expect(infraStepSkips(ledgerIn(ledgerDir), 'k3s-infra', INFRA, ['e1'])).toBe(true);
  });

  it('a seal that fails leaves the marker unset, so the next deploy runs the up again', async () => {
    fakePulumi.behaviour.importStack = () => {
      throw encryptRefusal();
    };
    const ledger = upgradedLedger();

    await upStack('e1', async () => ({}), { ...BASE, ledger });

    expect(infraStepSkips(ledgerIn(ledgerDir), 'k3s-infra', INFRA, ['e1'])).toBe(false);
  });

  it('a step with two stacks (compose-ha) skips only when both are marked', () => {
    const ledger = upgradedLedger();
    recordStateSeal(ledger, 'e1-primary');
    expect(infraStepSkips(ledger, 'k3s-infra', INFRA, ['e1-primary', 'e1-standby'])).toBe(false);
    recordStateSeal(ledger, 'e1-standby');
    expect(infraStepSkips(ledger, 'k3s-infra', INFRA, ['e1-primary', 'e1-standby'])).toBe(true);
    // Changed inputs still run the up, marker or not.
    expect(
      infraStepSkips(ledger, 'k3s-infra', { ...INFRA, masterType: 'cx33' }, [
        'e1-primary',
        'e1-standby',
      ]),
    ).toBe(false);
  });
});
