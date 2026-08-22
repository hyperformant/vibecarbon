/**
 * Manifest pins for Task 7 — cluster-autoscaler Deployment swaps from the
 * in-tree hcloud cloudprovider to our externalgrpc carbon-autoscaler
 * sidecar. This is the swap's contract: everything not explicitly listed
 * here must stay byte-identical (deploy/failover/destroy/scale contracts
 * read this Deployment's name/namespace directly), so most assertions pin
 * an exact value rather than a shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml, loadAll as loadYamlAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { clusterAutoscalerImageRef } from '../../../src/lib/images.js';

const DIR = join(process.cwd(), 'carbon', 'k8s', 'base', 'cluster-autoscaler');
const DEPLOYMENT_PATH = join(DIR, 'deployment.yaml');
const CLOUD_CONFIG_PATH = join(DIR, 'cloud-config.yaml');
const KUSTOMIZATION_PATH = join(DIR, 'kustomization.yaml');
const RBAC_PATH = join(DIR, 'rbac.yaml');

// Minimal typed shapes for the YAML docs this suite inspects — just the
// fields exercised below, not full Kubernetes API types.
interface K8sEnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
}

interface K8sContainer {
  name: string;
  image?: string;
  imagePullPolicy?: string;
  command?: string[];
  args?: string[];
  env?: K8sEnvVar[];
  resources?: unknown;
  securityContext?: unknown;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  livenessProbe?: unknown;
  readinessProbe?: unknown;
}

interface K8sDeployment {
  metadata: { name: string; namespace: string };
  spec: {
    replicas: number;
    strategy: { type: string };
    template: {
      spec: {
        serviceAccountName: string;
        priorityClassName: string;
        hostNetwork: boolean;
        dnsPolicy: string;
        tolerations: unknown[];
        nodeSelector: Record<string, string>;
        securityContext: unknown;
        containers: K8sContainer[];
        volumes: unknown[];
      };
    };
  };
}

const deploymentRaw = readFileSync(DEPLOYMENT_PATH, 'utf8');
const deployment = loadYaml(deploymentRaw) as unknown as K8sDeployment;

function containerNamed(name: string): K8sContainer {
  const containers = deployment.spec.template.spec.containers;
  const container = containers.find((c) => c.name === name);
  expect(container, `container "${name}" not found`).toBeDefined();
  return container as K8sContainer;
}

describe('cluster-autoscaler deployment.yaml — preserved literals', () => {
  it('metadata/replicas/strategy/serviceAccount/priorityClass unchanged', () => {
    expect(deployment.metadata.name).toBe('cluster-autoscaler');
    expect(deployment.metadata.namespace).toBe('kube-system');
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy.type).toBe('Recreate');
    expect(deployment.spec.template.spec.serviceAccountName).toBe('cluster-autoscaler');
    expect(deployment.spec.template.spec.priorityClassName).toBe('system-cluster-critical');
  });

  it('control-plane placement unchanged', () => {
    const podSpec = deployment.spec.template.spec;
    expect(podSpec.hostNetwork).toBe(true);
    expect(podSpec.dnsPolicy).toBe('ClusterFirstWithHostNet');
    expect(podSpec.tolerations).toEqual([
      { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
    ]);
    expect(podSpec.nodeSelector).toEqual({ 'node-role.kubernetes.io/control-plane': 'true' });
    expect(podSpec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } });
  });
});

describe('cluster-autoscaler deployment.yaml — CA container swap', () => {
  it('has exactly 2 containers', () => {
    expect(deployment.spec.template.spec.containers).toHaveLength(2);
  });

  it('CA container VERSION pin unchanged — only the registry host moved', () => {
    const ca = containerNamed('cluster-autoscaler');
    // v1.32.7 is still v1.32.7: the ghcr ref is a digest-preserving mirror of
    // the upstream image, made because registry.k8s.io 403s Hetzner IP ranges
    // (incident 2026-07-31 — see the block in src/lib/images.js). The exact
    // literal value of the ref is pinned in tests/unit/autoscaler/image-ref.test.ts.
    expect(ca.image).toBe(clusterAutoscalerImageRef());
    expect(ca.image).toContain(':v1.32.7');
    expect(ca.imagePullPolicy).toBe('IfNotPresent');
    expect(ca.command).toEqual(['./cluster-autoscaler']);
  });

  it('CA container resources unchanged', () => {
    const ca = containerNamed('cluster-autoscaler');
    expect(ca.resources).toEqual({
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '384Mi' },
    });
  });

  it('CA container securityContext unchanged', () => {
    const ca = containerNamed('cluster-autoscaler');
    expect(ca.securityContext).toEqual({
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
  });

  it('args switch to externalgrpc + cloud-config, drop --nodes', () => {
    const ca = containerNamed('cluster-autoscaler');
    expect(ca.args).toContain('--cloud-provider=externalgrpc');
    expect(ca.args).toContain('--cloud-config=/config/cloud-config');
    expect(ca.args.some((a: string) => /--nodes=/.test(a))).toBe(false);
    expect(ca.args.some((a: string) => /hetzner/i.test(a))).toBe(false);
  });

  it('scale-down tuning + balance/expander/verbosity flags stay verbatim', () => {
    const ca = containerNamed('cluster-autoscaler');
    expect(ca.args).toEqual(
      expect.arrayContaining([
        '--scale-down-delay-after-add=10m',
        '--scale-down-delay-after-delete=1m',
        '--scale-down-delay-after-failure=3m',
        '--scale-down-unneeded-time=10m',
        '--scale-down-utilization-threshold=0.5',
        '--skip-nodes-with-local-storage=false',
        '--skip-nodes-with-system-pods=false',
        '--balance-similar-node-groups=true',
        '--expander=least-waste',
        '--v=4',
      ]),
    );
  });

  it('CA container has no env block (hcloud env fully removed)', () => {
    const ca = containerNamed('cluster-autoscaler');
    expect(ca.env ?? []).toEqual([]);
  });

  it('zero HCLOUD_ occurrences anywhere in the raw file', () => {
    expect(deploymentRaw).not.toMatch(/HCLOUD_/);
  });

  it('CA container mounts the new cloud-config volume, keeps ssl-certs + tmp', () => {
    const ca = containerNamed('cluster-autoscaler');
    expect(ca.volumeMounts).toEqual(
      expect.arrayContaining([
        { name: 'cloud-config', mountPath: '/config', readOnly: true },
        { name: 'ssl-certs', mountPath: '/etc/ssl/certs/ca-certificates.crt', readOnly: true },
        { name: 'tmp-vol-0', mountPath: '/tmp' },
      ]),
    );
    expect(ca.volumeMounts).toHaveLength(3);
  });
});

describe('cluster-autoscaler deployment.yaml — carbon-autoscaler sidecar', () => {
  it('image is the exact unpatched placeholder', () => {
    const sidecar = containerNamed('carbon-autoscaler');
    expect(sidecar.image).toBe('{{CARBON_AUTOSCALER_IMAGE}}');
    expect(sidecar.imagePullPolicy).toBe('IfNotPresent');
  });

  it('env carries PROVIDER_API_TOKEN from the carbon-autoscaler-config secret + CARBON_AUTOSCALER_CONFIG path', () => {
    const sidecar = containerNamed('carbon-autoscaler');
    const byName: Record<string, K8sEnvVar> = Object.fromEntries(
      (sidecar.env ?? []).map((e): [string, K8sEnvVar] => [e.name, e]),
    );

    expect(byName.PROVIDER_API_TOKEN?.valueFrom?.secretKeyRef).toEqual({
      name: 'carbon-autoscaler-config',
      key: 'token',
    });
    expect(byName.CARBON_AUTOSCALER_CONFIG?.value).toBe('/config-ca/config.json');
  });

  it('mounts autoscaler-config at /config-ca readOnly', () => {
    const sidecar = containerNamed('carbon-autoscaler');
    expect(sidecar.volumeMounts).toEqual([
      { name: 'autoscaler-config', mountPath: '/config-ca', readOnly: true },
    ]);
  });

  it('resources pinned to req 50m/64Mi, lim 200m/128Mi', () => {
    const sidecar = containerNamed('carbon-autoscaler');
    expect(sidecar.resources).toEqual({
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    });
  });

  it('securityContext mirrors the hardened CA container shape exactly', () => {
    const ca = containerNamed('cluster-autoscaler');
    const sidecar = containerNamed('carbon-autoscaler');
    expect(sidecar.securityContext).toEqual(ca.securityContext);
  });

  // Task 9j: budgets raised after a live d3-rig CrashLoopBackOff — exec
  // probes spawn a full `node` process per invocation, and on a contended
  // 2-vCPU master node cold-start alone repeatedly exceeded the old 5s
  // timeoutSeconds while the backend was healthy throughout (kubelet
  // events: "command timed out ... after 5s" x6 liveness / x20 readiness
  // in 11 min, 6 restarts, cluster-autoscaler's externalgrpc calls refused
  // the whole time). See deployment.yaml's probe comments for the chosen
  // numbers' reasoning and worst-case detection windows — pin here so a
  // future tightening of these values fails loudly instead of silently
  // reintroducing this incident.
  it('livenessProbe execs the healthcheck script in --liveness mode with the specified timings', () => {
    const sidecar = containerNamed('carbon-autoscaler');
    expect(sidecar.livenessProbe).toEqual({
      exec: { command: ['node', 'src/autoscaler/healthcheck.js', '--liveness'] },
      initialDelaySeconds: 15,
      periodSeconds: 30,
      timeoutSeconds: 15,
      failureThreshold: 3,
    });
  });

  it('readinessProbe execs the healthcheck script in --readiness mode with the specified timings', () => {
    const sidecar = containerNamed('carbon-autoscaler');
    expect(sidecar.readinessProbe).toEqual({
      exec: { command: ['node', 'src/autoscaler/healthcheck.js', '--readiness'] },
      initialDelaySeconds: 10,
      periodSeconds: 20,
      timeoutSeconds: 15,
      failureThreshold: 3,
    });
  });
});

describe('cluster-autoscaler deployment.yaml — pod volumes', () => {
  it('adds cloud-config (configMap) + autoscaler-config (secret), keeps ssl-certs + tmp', () => {
    const volumes = deployment.spec.template.spec.volumes;
    expect(volumes).toEqual(
      expect.arrayContaining([
        { name: 'cloud-config', configMap: { name: 'cluster-autoscaler-cloud-config' } },
        { name: 'autoscaler-config', secret: { secretName: 'carbon-autoscaler-config' } },
        { name: 'ssl-certs', hostPath: { path: '/etc/ssl/certs/ca-certificates.crt' } },
        { name: 'tmp-vol-0', emptyDir: {} },
      ]),
    );
    expect(volumes).toHaveLength(4);
  });
});

describe('cluster-autoscaler-cloud-config ConfigMap', () => {
  it('parses as a ConfigMap with the address + grpc_timeout cloud-config value', () => {
    const raw = readFileSync(CLOUD_CONFIG_PATH, 'utf8');
    interface K8sConfigMap {
      kind: string;
      metadata: { name: string };
      data: Record<string, string>;
    }
    const configMap = loadYaml(raw) as unknown as K8sConfigMap;

    expect(configMap.kind).toBe('ConfigMap');
    expect(configMap.metadata.name).toBe('cluster-autoscaler-cloud-config');
    expect(configMap.data['cloud-config']).toContain('address: "127.0.0.1:8086"');
    expect(configMap.data['cloud-config']).toContain('grpc_timeout: 5s');
  });
});

describe('cluster-autoscaler kustomization.yaml', () => {
  it('lists deployment.yaml, rbac.yaml, cloud-config.yaml and keeps the kube-system namespace', () => {
    const raw = readFileSync(KUSTOMIZATION_PATH, 'utf8');
    interface K8sKustomization {
      namespace: string;
      resources: string[];
    }
    const kustomization = loadYaml(raw) as unknown as K8sKustomization;

    expect(kustomization.namespace).toBe('kube-system');
    expect(kustomization.resources).toEqual(['deployment.yaml', 'rbac.yaml', 'cloud-config.yaml']);
  });
});

describe('cluster-autoscaler rbac.yaml — untouched', () => {
  it('still parses into the same SA/ClusterRole/ClusterRoleBinding/Role/RoleBinding docs', () => {
    const raw = readFileSync(RBAC_PATH, 'utf8');
    interface K8sRbacDoc {
      kind: string;
      metadata: { name: string; namespace?: string };
    }
    const docs = loadYamlAll(raw) as unknown as K8sRbacDoc[];

    expect(docs).toHaveLength(5);
    expect(docs.map((d) => d.kind)).toEqual([
      'ServiceAccount',
      'ClusterRole',
      'ClusterRoleBinding',
      'Role',
      'RoleBinding',
    ]);
    for (const doc of docs) {
      expect(doc.metadata.name).toBe('cluster-autoscaler');
    }
    expect(docs[0].metadata.namespace).toBe('kube-system');
  });

  // CA 1.32 links the kube 1.32 scheduler framework, whose CSI-limits plugin
  // starts a VolumeAttachment informer — without the grant every CA pod loops
  // on `volumeattachments.storage.k8s.io is forbidden` (observed live on the
  // M3 rig). Verb set mirrors upstream's own chart
  // (charts/cluster-autoscaler/templates/clusterrole.yaml @
  // cluster-autoscaler-chart-9.50.1).
  it('grants watch/list/get on volumeattachments in the storage.k8s.io rule', () => {
    const raw = readFileSync(RBAC_PATH, 'utf8');
    interface K8sPolicyRule {
      apiGroups: string[];
      resources: string[];
      verbs: string[];
    }
    interface K8sClusterRole {
      kind: string;
      rules: K8sPolicyRule[];
    }
    const docs = loadYamlAll(raw) as unknown as K8sClusterRole[];
    const clusterRole = docs.find((d) => d.kind === 'ClusterRole');

    const storageRules = (clusterRole?.rules ?? []).filter((r) =>
      r.apiGroups.includes('storage.k8s.io'),
    );
    const volumeAttachmentRule = storageRules.find((r) =>
      r.resources.includes('volumeattachments'),
    );

    expect(volumeAttachmentRule).toBeDefined();
    expect(volumeAttachmentRule?.verbs.slice().sort()).toEqual(['get', 'list', 'watch']);
    // The other CSI resources CA has always needed stay in the same rule.
    expect(volumeAttachmentRule?.resources).toEqual([
      'storageclasses',
      'csinodes',
      'csidrivers',
      'csistoragecapacities',
      'volumeattachments',
    ]);
  });
});
