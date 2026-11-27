import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml, loadAll as loadYamlAll } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The carbon-autoscaler pod reads only what its container env holds: the
 * token and the config path, plus whatever operator variables the in-cluster
 * provider needs besides the token (`k8sAutoscalerEnv()`, written into the
 * carbon-autoscaler-config Secret and mapped by deployment.yaml). Scaleway's
 * createServer refuses without SCALEWAY_DEFAULT_PROJECT_ID, so a pod without
 * it could never add a worker.
 *
 * Every other test of createServer stubs the project id into the test's own
 * env and would pass anyway. This one runs createServer with the env the pod
 * would get, built from the shipped manifest and the Secret the deploy
 * writes, and nothing else.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { carbonAutoscalerSecretYaml } from '../../../src/lib/deploy/k8s/autoscaler-secret.js';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { REPO_ROOT } from '../../_shared/source-files.js';

const DEPLOYMENT = join(
  REPO_ROOT,
  'carbon',
  'k8s',
  'base',
  'cluster-autoscaler',
  'deployment.yaml',
);
const SECRET_NAME = 'carbon-autoscaler-config';
const PROJECT_ID = '0f5a7c3e-6b1d-4e2a-9c8f-3d4b5a6e7f80';

interface EnvEntry {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

/** The carbon-autoscaler container's env entries, as the manifest ships them. */
function sidecarEnv(): EnvEntry[] {
  const docs = loadYamlAll(readFileSync(DEPLOYMENT, 'utf-8')) as Array<{
    kind?: string;
    spec?: { template?: { spec?: { containers?: Array<{ name: string; env?: EnvEntry[] }> } } };
  }>;
  const deployment = docs.find((d) => d?.kind === 'Deployment');
  const container = deployment?.spec?.template?.spec?.containers?.find(
    (c) => c.name === 'carbon-autoscaler',
  );
  if (!container?.env) throw new Error('deployment.yaml has no carbon-autoscaler container env');
  return container.env;
}

/**
 * The env the kubelet gives the container: literal values as written, and
 * each secretKeyRef read from the Secret's stringData. A missing key with
 * `optional: true` is left out; without it the pod would not start at all.
 */
function podEnv(entries: EnvEntry[], stringData: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.value !== undefined) {
      env[entry.name] = entry.value;
      continue;
    }
    const ref = entry.valueFrom?.secretKeyRef;
    if (!ref) throw new Error(`env ${entry.name}: neither a value nor a secretKeyRef`);
    if (ref.name !== SECRET_NAME) throw new Error(`env ${entry.name}: reads Secret ${ref.name}`);
    if (ref.key in stringData) env[entry.name] = stringData[ref.key];
    else if (!ref.optional) throw new Error(`env ${entry.name}: Secret has no key ${ref.key}`);
  }
  return env;
}

/** The Secret the deploy writes, as the API server would store it. */
function deployedSecret(env: Record<string, string>): Record<string, string> {
  const yaml = carbonAutoscalerSecretYaml({ token: 'scw-secret-key', configJson: '{}', env });
  return (loadYaml(yaml) as { stringData: Record<string, string> }).stringData;
}

/** The operator's variables the provider classes read at deploy time. */
function stubCompanions() {
  vi.stubEnv('SCALEWAY_ACCESS_KEY', 'SCWABCDEFGHIJKLMNOPQ');
  vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', PROJECT_ID);
}

/**
 * Leave this process with no Scaleway variable but the pod's own. Each is
 * stubbed first, so unstubAllEnvs puts back what was there, then deleted:
 * vitest 5's stubEnv(name, undefined) leaves a value stubbed earlier in the
 * same file in place.
 */
function runWithOnly(env: Record<string, string>) {
  for (const name of Object.keys(process.env)) {
    if (!/^(SCALEWAY|SCW)_/.test(name)) continue;
    vi.stubEnv(name, '');
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** A createServer wire in fr-par-1; returns the server POST bodies it saw. */
function wire() {
  const creates: Array<Record<string, unknown>> = [];
  fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    if (method === 'GET' && u.searchParams.has('name')) return jsonResp({ servers: [] });
    if (method === 'POST' && u.pathname === '/instance/v1/zones/fr-par-1/servers') {
      creates.push(JSON.parse(String(init?.body)));
      return jsonResp({ server: { id: 'srv-ca', zone: 'fr-par-1' } }, 201);
    }
    if (u.pathname.endsWith('/user_data/cloud-init')) return jsonResp({}, 204);
    if (method === 'POST' && u.pathname.endsWith('/ips'))
      return jsonResp({ ip: { id: 'ip' } }, 201);
    if (method === 'POST' && u.pathname.endsWith('/action')) return jsonResp({ task: {} }, 202);
    return jsonResp({}, 404);
  });
  return creates;
}

const worker = {
  name: 'acme-prod-ca-k3x9q2ab',
  region: 'fr-par-1',
  serverType: 'DEV1-M',
  image: 'ubuntu_resolute',
  labels: { cluster: 'acme-prod' },
  userData: '#cloud-config\n',
};

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Review Focus 1: the autoscaler pod's env carries what createServer reads", () => {
  it("an autoscaled Scaleway create runs with only the pod's env", async () => {
    stubCompanions();
    const stringData = deployedSecret(ScalewayProvider.k8sAutoscalerEnv());
    const env = podEnv(sidecarEnv(), stringData);
    runWithOnly(env);
    expect(Object.keys(process.env).filter((k) => /^(SCALEWAY|SCW)_/.test(k))).toEqual([
      'SCALEWAY_DEFAULT_PROJECT_ID',
    ]);

    const creates = wire();
    await new ScalewayProvider(env.PROVIDER_API_TOKEN).createServer(worker);

    expect(env.PROVIDER_API_TOKEN).toBe('scw-secret-key');
    expect(creates).toHaveLength(1);
    expect(creates[0].project).toBe(PROJECT_ID);
  });

  it('without the manifest entry, the same create refuses: the pod would never add a worker', async () => {
    stubCompanions();
    const stringData = deployedSecret(ScalewayProvider.k8sAutoscalerEnv());
    const entries = sidecarEnv().filter((e) => e.name !== 'SCALEWAY_DEFAULT_PROJECT_ID');
    const env = podEnv(entries, stringData);
    runWithOnly(env);
    expect(Object.keys(process.env).filter((k) => /^(SCALEWAY|SCW)_/.test(k))).toEqual([]);

    const creates = wire();
    await expect(new ScalewayProvider(env.PROVIDER_API_TOKEN).createServer(worker)).rejects.toThrow(
      'SCALEWAY_DEFAULT_PROJECT_ID is not set',
    );
    expect(creates).toEqual([]);
  });

  it("a deploy with the project id unset fails before the Secret is written, in buildIacEnv's words", () => {
    stubCompanions();
    runWithOnly({});
    expect(() => ScalewayProvider.k8sAutoscalerEnv()).toThrow(/SCALEWAY_DEFAULT_PROJECT_ID/);
    let iacError = '';
    try {
      ScalewayProvider.buildIacEnv('tok');
    } catch (err) {
      iacError = (err as Error).message;
    }
    expect(iacError).not.toBe('');
    expect(() => ScalewayProvider.k8sAutoscalerEnv()).toThrow(iacError);
  });
});

describe('the autoscaler env census: provider table and manifest agree', () => {
  const providers = Object.entries(PROVIDERS);

  it('walks every registered provider, and at least one names a key (never vacuously green)', () => {
    stubCompanions();
    expect(providers.map(([id]) => id)).toContain('scaleway');
    const keyed = providers.filter(([, P]) => Object.keys(P.k8sAutoscalerEnv()).length > 0);
    expect(keyed.map(([id]) => id)).toEqual(['scaleway']);
  });

  it('the base names nothing', () => {
    expect(BaseProvider.k8sAutoscalerEnv()).toEqual({});
  });

  it.each(providers)(
    '%s: each key has exactly its optional deployment.yaml entry, and a string value',
    (_id, P) => {
      stubCompanions();
      const env = P.k8sAutoscalerEnv();
      for (const [key, value] of Object.entries(env)) {
        expect(typeof value, key).toBe('string');
        expect(['token', 'config.json'], key).not.toContain(key);
        expect(sidecarEnv().filter((e) => e.name === key)).toEqual([
          { name: key, valueFrom: { secretKeyRef: { name: SECRET_NAME, key, optional: true } } },
        ]);
      }
    },
  );

  it("every optional entry reading the Secret is some provider's key", () => {
    stubCompanions();
    const keys = new Set(providers.flatMap(([, P]) => Object.keys(P.k8sAutoscalerEnv())));
    const optional = sidecarEnv().filter(
      (e) => e.valueFrom?.secretKeyRef?.name === SECRET_NAME && e.valueFrom.secretKeyRef.optional,
    );
    expect(optional.length).toBeGreaterThan(0);
    for (const entry of optional) expect([...keys], entry.name).toContain(entry.name);
  });
});
