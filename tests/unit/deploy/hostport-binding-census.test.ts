/**
 * Every k8s hostPort binds a named interface (security plan 2026-10-20,
 * Task 6, M5). A hostPort with no `hostIP` is published on EVERY node
 * address, public ones included, so the cloud firewall becomes the only
 * barrier. The one exception is Traefik's 80/443: public ingress is the
 * point of those two.
 *
 * Walks:
 *   - every YAML under carbon/k8s/** and services/*\/k8s/** (raw, with
 *     `{{PLACEHOLDER}}` tokens kept as non-empty strings so a templated
 *     hostIP like the registry's `{{MASTER_PRIVATE_IP}}` counts as bound);
 *   - the output of every exported `build*Patch` function in
 *     src/lib/deploy/k8s/** (the HA db hostPort lands through one of these,
 *     never through a manifest).
 *
 * Positive controls keep the walk from passing vacuously: it must see
 * Traefik's two exempt ports, the registry's 5000 and the HA db patch's 5433.
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML / patch objects
type Node = any;

type Binding = { source: string; owner: string; hostPort: number; hostIP: unknown };

function walkFiles(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p, match));
    else if (match.test(name)) out.push(p);
  }
  return out;
}

/** Every object carrying a `hostPort`, anywhere under `node`. */
function collectHostPorts(node: Node, source: string, owner: string): Binding[] {
  if (Array.isArray(node)) return node.flatMap((n) => collectHostPorts(n, source, owner));
  if (!node || typeof node !== 'object') return [];
  const here: Binding[] =
    'hostPort' in node
      ? [{ source, owner, hostPort: Number(node.hostPort), hostIP: node.hostIP }]
      : [];
  return [
    ...here,
    ...Object.values(node).flatMap((v) => collectHostPorts(v as Node, source, owner)),
  ];
}

/** Traefik's public ingress ports are the only hostPorts allowed every address. */
const isTraefikIngress = (b: Binding) =>
  b.owner === 'traefik' && (b.hostPort === 80 || b.hostPort === 443);

/** A binding that publishes on every node address. */
function unboundHostPorts(bindings: Binding[]): Binding[] {
  return bindings.filter(
    (b) =>
      !isTraefikIngress(b) &&
      (typeof b.hostIP !== 'string' || b.hostIP.trim() === '' || b.hostIP.trim() === '0.0.0.0'),
  );
}

function manifestBindings(): Binding[] {
  const files = [
    ...walkFiles(join(ROOT, 'carbon/k8s'), /\.ya?ml$/),
    ...readdirSync(join(ROOT, 'services')).flatMap((svc) => {
      const dir = join(ROOT, 'services', svc, 'k8s');
      try {
        return walkFiles(dir, /\.ya?ml$/);
      } catch {
        return [];
      }
    }),
  ];
  return files.flatMap((file) => {
    // Keep each placeholder as a non-empty, YAML-safe string.
    const text = readFileSync(file, 'utf-8').replace(/\{\{([A-Z0-9_]+)\}\}/g, '__$1__');
    const docs = (loadAll(text) as Node[]).filter(Boolean);
    return docs.flatMap((doc) =>
      collectHostPorts(doc, relative(ROOT, file), String(doc?.metadata?.name ?? '')),
    );
  });
}

async function patchBuilderBindings(): Promise<Binding[]> {
  const modules = walkFiles(join(ROOT, 'src/lib/deploy/k8s'), /\.js$/);
  const out: Binding[] = [];
  for (const file of modules) {
    const mod = await import(pathToFileURL(file).href);
    for (const [name, fn] of Object.entries(mod)) {
      if (!/^build\w*Patch$/.test(name) || typeof fn !== 'function') continue;
      // A builder that needs arguments throws here: give the census a fixture
      // for it rather than skipping it.
      const patch = (fn as () => unknown)();
      out.push(...collectHostPorts(patch, `${relative(ROOT, file)}#${name}`, name));
    }
  }
  return out;
}

describe('k8s hostPorts bind a named interface (Traefik 80/443 excepted)', () => {
  it('every manifest hostPort carries a hostIP that is not empty and not 0.0.0.0', () => {
    const bindings = manifestBindings();
    // Positive controls: the walk reaches the manifests that publish ports.
    expect(
      bindings
        .filter(isTraefikIngress)
        .map((b) => b.hostPort)
        .sort(),
    ).toEqual([443, 80]);
    expect(bindings.some((b) => b.owner === 'local-registry' && b.hostPort === 5000)).toBe(true);
    expect(
      unboundHostPorts(bindings).map((b) => `${b.source} (${b.owner}) hostPort ${b.hostPort}`),
    ).toEqual([]);
  });

  it('every exported build*Patch hostPort carries a hostIP that is not empty and not 0.0.0.0', async () => {
    const bindings = await patchBuilderBindings();
    // Positive control: the HA db replication hostPort is found.
    expect(bindings.some((b) => b.owner === 'buildDbHostPortPatch' && b.hostPort === 5433)).toBe(
      true,
    );
    expect(unboundHostPorts(bindings).map((b) => `${b.source} hostPort ${b.hostPort}`)).toEqual([]);
  });

  it('arm-bite: the checker flags a missing, empty or 0.0.0.0 hostIP and spares Traefik 80/443', () => {
    const doc = (name: string, ports: Node[]) => ({
      metadata: { name },
      spec: { template: { spec: { containers: [{ name: 'c', ports }] } } },
    });
    const bindings = [
      doc('traefik', [{ hostPort: 80 }, { hostPort: 443 }, { hostPort: 8080 }]),
      doc('x', [{ hostPort: 1 }, { hostPort: 2, hostIP: '' }, { hostPort: 3, hostIP: '0.0.0.0' }]),
      doc('y', [
        { hostPort: 4, hostIP: '127.0.0.1' },
        { hostPort: 80, hostIP: '__MASTER__' },
      ]),
    ].flatMap((d) => collectHostPorts(d, 'fixture', d.metadata.name));
    expect(unboundHostPorts(bindings).map((b) => `${b.owner}:${b.hostPort}`)).toEqual([
      'traefik:8080',
      'x:1',
      'x:2',
      'x:3',
    ]);
  });
});

describe("the rendered registry binds the deploy's master private IP", () => {
  const values = async (masterPrivateIp: string | undefined) => {
    const { buildDbManifestValues } = await import('../../../src/lib/deploy/k8s/k3s.js');
    return {
      ...buildDbManifestValues({
        dbImageTag: 'ghcr.io/org/postgres:17-walg1',
        storageClass: 'provider-csi',
        dbPrivateIp: '10.0.1.2',
        walArchiveSha: 'abc',
      }),
      MASTER_PRIVATE_IP: masterPrivateIp as string,
    };
  };
  const renderedRegistryHostIps = async (masterPrivateIp: string) => {
    const { renderK8sBase } = await import('../../../src/lib/deploy/k8s/k3s.js');
    const out = renderK8sBase(join(ROOT, 'carbon/k8s/base'), await values(masterPrivateIp));
    try {
      const docs = (
        loadAll(readFileSync(join(out, 'registry', 'local-registry.yaml'), 'utf-8')) as Node[]
      ).filter(Boolean);
      return collectHostPorts(docs, 'rendered', 'local-registry').map((b) => b.hostIP);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  };

  it('Hetzner shape: hostIP is the static 10.0.1.1', async () => {
    expect(await renderedRegistryHostIps('10.0.1.1')).toEqual(['10.0.1.1']);
  });

  it('DigitalOcean shape: hostIP is the Pulumi-assigned VPC address', async () => {
    expect(await renderedRegistryHostIps('10.10.0.7')).toEqual(['10.10.0.7']);
  });

  it('refuses to render the registry without a master private IP', async () => {
    const { renderK8sBase } = await import('../../../src/lib/deploy/k8s/k3s.js');
    for (const bad of [undefined, '', 'not-an-ip']) {
      const v = await values(bad);
      expect(() => renderK8sBase(join(ROOT, 'carbon/k8s/base'), v), String(bad)).toThrow(
        /MASTER_PRIVATE_IP/,
      );
    }
  });
});
