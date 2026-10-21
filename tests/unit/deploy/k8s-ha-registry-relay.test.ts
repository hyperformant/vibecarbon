import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  REGISTRY_RELAY_SOURCE_HOST,
  renderRegistryRelayManifest,
  withRegistryRelay,
} from '../../../src/lib/deploy/k8s/ha/index.js';

const ROOT = join(__dirname, '../../..');
const TEMPLATE = readFileSync(
  join(ROOT, 'carbon/k8s/base/repl-gateway/registry-relay.yaml'),
  'utf-8',
);

describe('registry relay manifest', () => {
  it('binds the tunnel IP, admits only the standby, targets the primary registry', () => {
    const out = renderRegistryRelayManifest({
      template: TEMPLATE,
      primaryMasterPrivateIp: '10.0.1.1',
    });
    expect(out).toContain('TCP-LISTEN:15000,bind=10.99.0.1,fork,reuseaddr,range=10.99.0.2/32');
    expect(out).toContain('TCP:10.0.1.1:5000');
    expect(out).toContain('restartPolicy: Never');
    expect(out).not.toMatch(/__[A-Z_]+__/);
    expect(REGISTRY_RELAY_SOURCE_HOST).toBe('10.99.0.1:15000');
  });
  it('refuses an empty primary master IP', () => {
    expect(() =>
      renderRegistryRelayManifest({ template: TEMPLATE, primaryMasterPrivateIp: '' }),
    ).toThrow(/primaryMasterPrivateIp is required/);
  });
  it('is in no kustomization', () => {
    for (const k of [
      'carbon/k8s/base/kustomization.yaml',
      'carbon/k8s/base/repl-gateway/kustomization.yaml',
    ]) {
      expect(readFileSync(join(ROOT, k), 'utf-8')).not.toContain('registry-relay');
    }
  });
});

describe('relay hardening', () => {
  it.each(['registry-relay.yaml', 'repl-gateway.yaml'])(
    '%s drops to an unprivileged read-only socat',
    (file) => {
      const text = readFileSync(join(ROOT, 'carbon/k8s/base/repl-gateway', file), 'utf-8');
      // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
      const docs = (text.split(/^---$/m).map((d) => load(d)) as any[]).filter(Boolean);
      const workload = docs.find((d) => d.kind === 'Pod' || d.kind === 'Deployment');
      const pod = workload.kind === 'Pod' ? workload.spec : workload.spec.template.spec;
      expect(pod.containers[0].securityContext).toEqual({
        runAsNonRoot: true,
        runAsUser: 65534,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
    },
  );
});

describe('withRegistryRelay', () => {
  const args = {
    primaryIp: 'P',
    standbyIp: 'S',
    primaryMasterPrivateIp: '10.0.1.1',
    sshKeyPath: '/k',
  };
  it('clears the standby, applies on the primary, waits Ready, runs fn, deletes after', async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const run = async (ip: string, script: string, input?: string) => {
      calls.push([ip, script, input]);
      return '';
    };
    const order: string[] = [];
    const result = await withRegistryRelay({ ...args, run }, async () => {
      order.push(`fn after ${calls.length} calls`);
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls[0]).toEqual([
      'S',
      'kubectl delete pod registry-relay -n vibecarbon --ignore-not-found',
      undefined,
    ]);
    expect(calls[1][0]).toBe('P');
    expect(calls[1][1]).toMatch(/delete pod registry-relay .*&& kubectl apply -f -/);
    expect(calls[1][2]).toContain('name: registry-relay');
    expect(calls[2]).toEqual([
      'P',
      'kubectl wait --for=condition=Ready pod/registry-relay -n vibecarbon --timeout=60s',
      undefined,
    ]);
    expect(order).toEqual(['fn after 3 calls']);
    expect(calls[3][0]).toBe('P');
    expect(calls[3][1]).toMatch(/delete pod registry-relay .*--ignore-not-found/);
  });
  it('a relay that never gets Ready fails with one line, fn never runs, and the relay is still deleted', async () => {
    const calls: string[] = [];
    const run = async (ip: string, script: string) => {
      calls.push(`${ip} ${script}`);
      if (script.startsWith('kubectl wait')) {
        throw Object.assign(new Error('Command failed: ssh ...'), {
          stderr: 'error: timed out waiting for the condition on pods/registry-relay\n',
        });
      }
      return '';
    };
    let ran = false;
    await expect(
      withRegistryRelay({ ...args, run }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(
      /^registry relay not ready on the primary: error: timed out waiting for the condition on pods\/registry-relay$/,
    );
    expect(ran).toBe(false);
    expect(calls.at(-1)).toMatch(/^P kubectl delete pod registry-relay/);
  });
  it('a relay that never gets Ready says its pod phase and last log lines', async () => {
    const run = async (_ip: string, script: string) => {
      if (script.startsWith('kubectl wait'))
        throw Object.assign(new Error('x'), { stderr: 'timed out\n' });
      if (script.includes('jsonpath')) return 'Failed\n';
      if (script.startsWith('kubectl logs')) return 'socat: bind failed\n';
      return '';
    };
    await expect(withRegistryRelay({ ...args, run }, async () => {})).rejects.toThrow(
      /^registry relay not ready on the primary: timed out\npod phase: Failed\nrelay log:\nsocat: bind failed$/,
    );
  });
  it('failing diagnostics are ignored', async () => {
    const run = async (_ip: string, script: string) => {
      if (script.startsWith('kubectl wait'))
        throw Object.assign(new Error('x'), { stderr: 'timed out\n' });
      if (script.startsWith('kubectl get') || script.startsWith('kubectl logs'))
        throw new Error('boom');
      return '';
    };
    await expect(withRegistryRelay({ ...args, run }, async () => {})).rejects.toThrow(
      /^registry relay not ready on the primary: timed out$/,
    );
  });
  it('a missing primary master IP rejects before any remote call', async () => {
    const calls: string[] = [];
    await expect(
      withRegistryRelay(
        {
          ...args,
          primaryMasterPrivateIp: '',
          run: async (ip: string) => {
            calls.push(ip);
            return '';
          },
        },
        async () => {},
      ),
    ).rejects.toThrow(/primaryMasterPrivateIp is required/);
    expect(calls).toEqual([]);
  });
});
