/**
 * One k3s node, started with the flags a real master installs with.
 *
 * The version channel's k3s smoke test: `.github/workflows/version-channel.yml`
 * runs this on a version before the list names it (VC_K3S_VERSION), on a runner,
 * with no cloud spend. It also runs under `pnpm test:docker`, on the bundled
 * version.
 *
 * What it proves that nothing cheaper can. The flags are read out of
 * master-init.sh, so `--system-default-registry` is really on, and registries.yaml
 * is built from the same snippet a node gets, so a system image reaches this node
 * only through our ghcr mirror, by tag, with no credential. If the mirror is
 * short of one, or a package is private, or the release needs a system image the
 * rewrite does not cover, its pod never starts and this fails. It also installs
 * the Traefik CRDs of the Traefik about to be published, which fails if upstream
 * moved that file.
 *
 * What stands in for the cloud: the container's one address plays both the
 * public and the private one. Nothing runs a cloud controller, so this test
 * removes the taint a real CCM removes.
 *
 * Every container and network here is named vctest-* and removed in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { K3S_SYSTEM_REGISTRY, k3sVersion, traefikImageRef } from '../../../src/lib/images.js';
import { k3sServerFlags } from '../../_shared/k3s-server-flags.js';

const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const ROOT = process.cwd();
const VERSION = process.env.VC_K3S_VERSION || k3sVersion();
const IMAGE = `rancher/k3s:${VERSION.replace('+', '-')}`;
const TRAEFIK_TAG = (process.env.VC_TRAEFIK_IMAGE || traefikImageRef()).match(
  /:(v[\d.]+)@/,
)?.[1] as string;
const NODE = `vctest-k3s-${process.pid}`;
const NET = `vctest-k3s-net-${process.pid}`;
// The address master-init.sh names as the advertise address.
const NODE_IP = '10.0.1.1';
const TAINT = 'node.cloudprovider.kubernetes.io/uninitialized-';
// Long, because a first pull of every system image is the point.
const LONG = 230_000;

const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { encoding: 'utf-8', input, timeout: LONG });
const must = (cmd: string, args: string[], input?: string) => {
  const r = run(cmd, args, input);
  if (r.status !== 0) {
    throw new Error(`${args.slice(0, 6).join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  }
  return r.stdout;
};
const kubectl = (...args: string[]) => must('docker', ['exec', NODE, 'kubectl', ...args]);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (what: string, probe: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    sleepSync(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** registries.yaml as master-init.sh writes it, with the same snippet. */
function registriesYaml() {
  const snippet = readFileSync(
    join(ROOT, 'carbon/cloud-init/k3s/_k3s-system-image-mirror.yaml'),
    'utf-8',
  );
  return `mirrors:\n${snippet}`;
}

describeDocker(`k3s ${VERSION} with the flags in master-init.sh`, () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vctest-k3s-'));
    writeFileSync(join(dir, 'registries.yaml'), registriesYaml());
    must('docker', [
      'network',
      'create',
      '--subnet',
      '10.0.1.0/24',
      '--gateway',
      '10.0.1.254',
      NET,
    ]);
    const flags = k3sServerFlags(
      readFileSync(join(ROOT, 'carbon/cloud-init/k3s/master-init.sh'), 'utf-8'),
      { k3s_token: 'vctest', floating_ip: NODE_IP, PUBLIC_IP: NODE_IP, PRIVATE_IFACE: 'eth0' },
    );
    must('docker', [
      'run',
      '-d',
      '--privileged',
      '--name',
      NODE,
      '--network',
      NET,
      '--ip',
      NODE_IP,
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/var/run',
      '-v',
      '/var/lib/rancher/k3s',
      '-v',
      `${join(dir, 'registries.yaml')}:/etc/rancher/k3s/registries.yaml:ro`,
      IMAGE,
      'server',
      ...flags,
    ]);
    waitFor(
      'the node to register',
      () => run('docker', ['exec', NODE, 'kubectl', 'get', 'node', '-o', 'name']).stdout.length > 0,
      120_000,
    );
    kubectl('taint', 'nodes', '--all', TAINT);
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', NODE]);
    run('docker', ['network', 'rm', NET]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('runs the version under test', () => {
    expect(
      kubectl('get', 'node', '-o', 'jsonpath={.items[0].status.nodeInfo.kubeletVersion}'),
    ).toBe(VERSION);
  });

  it(
    'the node goes Ready and the system pods start, pulled only through our mirror',
    () => {
      kubectl('wait', 'node', '--all', '--for=condition=Ready', '--timeout=120s');
      for (const deployment of ['coredns', 'metrics-server', 'local-path-provisioner']) {
        // k3s applies its add-ons a moment after the node registers.
        waitFor(
          deployment,
          () =>
            run('docker', [
              'exec',
              NODE,
              'kubectl',
              '-n',
              'kube-system',
              'get',
              `deployment/${deployment}`,
            ]).status === 0,
          60_000,
        );
        kubectl(
          '-n',
          'kube-system',
          'rollout',
          'status',
          `deployment/${deployment}`,
          '--timeout=150s',
        );
      }
      const images = kubectl(
        'get',
        'pods',
        '-A',
        '-o',
        'jsonpath={.items[*].spec.containers[*].image}',
      )
        .split(/\s+/)
        .filter(Boolean);
      expect(images.length).toBeGreaterThanOrEqual(3);
      // A chart k3s starts shipping can need an image we do not mirror, and its
      // pod waits on the pull forever while everything above still passes.
      expect(
        kubectl(
          'get',
          'pods',
          '-A',
          '--field-selector=status.phase!=Running,status.phase!=Succeeded',
          '-o',
          'name',
        ),
      ).toBe('');
      for (const image of images)
        expect(image.startsWith(`${K3S_SYSTEM_REGISTRY}/`), image).toBe(true);
    },
    LONG,
  );

  it(
    'the Traefik CRDs of the Traefik about to go out install',
    () => {
      const kustomization = readFileSync(
        join(ROOT, 'carbon/k8s/infra/traefik-crds/kustomization.yaml'),
        'utf-8',
      ).replaceAll('{{TRAEFIK_VERSION}}', TRAEFIK_TAG);
      must('docker', ['exec', NODE, 'mkdir', '-p', '/tmp/traefik-crds']);
      must(
        'docker',
        ['exec', '-i', NODE, 'sh', '-c', 'cat > /tmp/traefik-crds/kustomization.yaml'],
        kustomization,
      );
      kubectl('apply', '-k', '/tmp/traefik-crds');
      kubectl(
        'wait',
        '--for=condition=established',
        '--timeout=60s',
        'crd/ingressroutes.traefik.io',
      );
    },
    LONG,
  );
});
