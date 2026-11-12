/**
 * Sealing the user data an existing server keeps plain in its stack's state
 * (lib/iac/state-seal.js), and where upStack runs it: after a successful up,
 * on a fresh export, importing only when it sealed anything, and twice then,
 * so the checkpoint Pulumi keeps as `<stack>.json.bak` is the sealed one too.
 *
 * The real engine's answer (a legacy sentinel gone from the stack file and
 * its .bak, a second deploy sealing 0) is
 * tests/integration/iac/state-seal.test.ts.
 */
import * as rpc from '@pulumi/pulumi/runtime/rpc.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';
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

const { SECRET_SIG, SECRET_SIG_KEY, sealServerUserData } = await import(
  '../../../src/lib/iac/state-seal.js'
);
const { SERVER_RESOURCE_TYPES } = await import('../../../src/lib/iac/create-timeout.js');
const { __resetStateProbesForTests, upStack } = await import('../../../src/lib/iac/index.js');

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
});

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
