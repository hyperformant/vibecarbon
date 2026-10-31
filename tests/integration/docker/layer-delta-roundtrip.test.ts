import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MANIFEST_ACCEPT, MANIFEST_DIGEST_SH } from '../../../src/lib/deploy/k8s/image-delivery.js';
import { deliverImage } from '../../../src/lib/deploy/layer-delta.js';
import { acquireUplinkLock } from '../../../src/lib/deploy/uplink-lock.js';

// The layer delta (src/lib/deploy/layer-delta.js + layer-delta-remote.sh) end
// to end on every store a deploy target can have: docker:29-dind with the
// classic store, docker:29-dind with the containerd snapshotter, and k3s
// (`ctr images import`, then a push into a registry:2.8.3 sidecar and a
// `ctr images pull --plain-http` back, the call
// src/lib/deploy/k8s/ha/image-copy.js makes).
//
// The base is THIS commit's docker/node-runtime (the published one may not
// exist yet), built on the host and pushed into the sidecar registry; each
// target pulls it from there, so it holds the base compressed exactly as a
// registry pull leaves it (the shape a GHCR pull gives a real server). The
// app is that base plus a deps layer and a dist layer. Each target gets the
// app twice: a cold delivery (the base is held, deps and dist travel), then a
// redeploy whose only change is dist (one layer travels).
//
// The real module runs, save, listing, staging, the uplink lock and the
// remote script included; only the ssh hop is replaced by `docker exec -i`.
//
// Every container, network and image this file makes is named vcdelta* and
// removed in afterAll (`docker rm -f -v` for containers). One target runs at a
// time.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');
const DIND_IMAGE = 'docker:29-dind';
const K3S_IMAGE = 'rancher/k3s:v1.31.5-k3s1';
const REGISTRY_IMAGE = 'registry:2.8.3';
const NET = 'vcdelta-net';
const REG = 'vcdelta-reg';
const DIND_CLASSIC = 'vcdelta-dind-classic';
const DIND_CONTAINERD = 'vcdelta-dind-containerd';
const K3S = 'vcdelta-k3s';
const BASE_TAG = 'vcdelta/node-runtime:test';
const APP = 'vcdelta/app';
// The k8s tag scheme: the app is named by the in-cluster registry it lands in.
const K3S_APP = `${REG}:5000/vcdelta/app`;
const LONG = 900_000;
let lockRoot: string;

type Run = { status: number | null; stdout: string; stderr: string };
const run = (cmd: string, args: string[]): Run => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const must = (cmd: string, args: string[]): string => {
  const r = run(cmd, args);
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout;
};
const docker = (...args: string[]) => must('docker', args);
const sh = (container: string, script: string) =>
  must('docker', ['exec', container, 'sh', '-c', script]);
const fact = (target: string, key: string, value: unknown) =>
  console.log(
    `[layer-delta:${target}] ${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (what: string, probe: () => boolean, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    sleepSync(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const rmContainers = (...names: string[]) => {
  for (const n of names) run('docker', ['rm', '-f', '-v', n]);
};
const memAvailableMb = () => {
  const m = /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf-8'));
  return m ? Math.round(Number(m[1]) / 1024) : Number.POSITIVE_INFINITY;
};

/** deliverImage's ssh hop, replaced by `docker exec` into the target. */
function execTransport(container: string) {
  const execArgs = (cmd: string, interactive: boolean) => [
    'exec',
    ...(interactive ? ['-i'] : []),
    '-e',
    // The rancher/k3s image answers `k3s ctr` with "No help topic"; its
    // /bin/ctr is the same multicall binary a node's `k3s ctr` runs.
    'VC_CTR=ctr',
    container,
    'sh',
    '-c',
    cmd,
  ];
  return {
    // The real lock, in this run's own dir rather than the operator's home.
    acquireLock: (opts: { label: string }) =>
      acquireUplinkLock({ ...opts, lockDir: join(lockRoot, 'uplink.lock') }),
    run: async (cmd: string) => must('docker', execArgs(cmd, false)),
    send: async (cmd: string, stdin: Readable) => {
      const child = spawn('docker', execArgs(cmd, true), { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => {
        stderr += c;
      });
      const fed = pipeline(stdin, child.stdin).catch(() => {});
      const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? 1)));
      await fed;
      return { code, stderr };
    },
  };
}

const deltaRootEmpty = (container: string) =>
  sh(container, 'ls -A /var/lib/vibecarbon/delta 2>/dev/null || true').trim() === '';

describeDocker('layer delta delivery (deliverImage) on every target store', () => {
  let work: string;
  let context: string;
  let regPort: string;
  let baseLayers: string[];
  const hostLayers: Record<string, string[]> = {};
  const fullSaveBytes: Record<string, number> = {};
  const hostTags = new Set<string>();

  /** Builds app:<version> from the shared context, changing only dist. */
  function buildApp(version: string) {
    writeFileSync(join(context, 'dist', 'marker'), `vibecarbon layer-delta ${version}\n`);
    const tag = `${APP}:${version}`;
    docker('buildx', 'build', '--builder', 'default', '--load', '-q', '-t', tag, context);
    hostTags.add(tag);
    hostLayers[version] = JSON.parse(
      docker('image', 'inspect', tag, '--format', '{{json .RootFS.Layers}}'),
    );
    docker('save', tag, '-o', join(work, `${version}.tar`));
    fullSaveBytes[version] = statSync(join(work, `${version}.tar`)).size;
    rmSync(join(work, `${version}.tar`));
    fact('host', `${version}.fullSaveBytes`, fullSaveBytes[version]);
  }

  beforeAll(() => {
    // The k3s pin must track the one deploys install.
    expect(readFileSync(join(REPO_ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8')).toContain(
      `K3S_VERSION = '${K3S_IMAGE.split(':')[1].replace(/-k3s/, '+k3s')}'`,
    );
    work = mkdtempSync(join(tmpdir(), 'vcdelta-'));
    lockRoot = join(work, 'locks');
    mkdirSync(lockRoot);
    docker(
      'buildx',
      'build',
      '--builder',
      'default',
      '--load',
      '-q',
      '-t',
      BASE_TAG,
      join(REPO_ROOT, 'docker/node-runtime'),
    );
    hostTags.add(BASE_TAG);
    baseLayers = JSON.parse(
      docker('image', 'inspect', BASE_TAG, '--format', '{{json .RootFS.Layers}}'),
    );
    fact('host', 'base.layers', baseLayers.length);

    // The app: FROM the base, then deps (compressible, like node_modules),
    // then dist. Written into the build context at run time: a committed file
    // named Dockerfile would enter the repo's Dockerfile censuses.
    context = join(work, 'context');
    mkdirSync(join(context, 'deps'), { recursive: true });
    mkdirSync(join(context, 'dist'));
    writeFileSync(
      join(context, 'Dockerfile'),
      `FROM ${BASE_TAG}\nCOPY deps /app/deps\nCOPY dist /app/dist\n`,
    );
    writeFileSync(
      join(context, 'deps', 'index.js'),
      Array.from(
        { length: 60_000 },
        (_, i) => `export const v${i} = ${JSON.stringify({ i })};`,
      ).join('\n'),
    );
    buildApp('v1');

    docker('network', 'create', NET);
    docker('run', '-d', '--name', REG, '--network', NET, '-p', '127.0.0.1::5000', REGISTRY_IMAGE);
    regPort = docker('port', REG, '5000').trim().split('\n')[0].split(':').pop() as string;
    const hostRef = `127.0.0.1:${regPort}/vcdelta/node-runtime:test`;
    docker('tag', BASE_TAG, hostRef);
    hostTags.add(hostRef);
    waitFor('registry', () => run('docker', ['push', '-q', hostRef]).status === 0, 60_000);
  }, LONG);

  afterAll(() => {
    rmContainers(DIND_CLASSIC, DIND_CONTAINERD, K3S, REG);
    run('docker', ['network', 'rm', NET]);
    for (const t of hostTags) run('docker', ['image', 'rm', t]);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  // The base as a server's deploy pulls it, by the name the delta asks for.
  const baseInReg = `${REG}:5000/vcdelta/node-runtime:test`;

  for (const variant of [
    { name: DIND_CLASSIC, label: 'classic', snapshotter: false },
    { name: DIND_CONTAINERD, label: 'containerd-snapshotter', snapshotter: true },
  ]) {
    it(
      `docker:29-dind ${variant.label} store: the base stays on the server, and a dist-only redeploy sends one layer`,
      async () => {
        const target = variant.label;
        expect(memAvailableMb()).toBeGreaterThan(300);
        const daemonJson = JSON.stringify({
          features: { 'containerd-snapshotter': variant.snapshotter },
          'insecure-registries': [`${REG}:5000`],
        });
        try {
          docker(
            'run',
            '-d',
            '--privileged',
            '--name',
            variant.name,
            '--network',
            NET,
            '-e',
            'DOCKER_TLS_CERTDIR=',
            '--entrypoint',
            'sh',
            DIND_IMAGE,
            '-c',
            `mkdir -p /etc/docker && echo '${daemonJson}' > /etc/docker/daemon.json && exec dockerd-entrypoint.sh`,
          );
          waitFor(
            'dockerd',
            () => run('docker', ['exec', variant.name, 'docker', 'info']).status === 0,
          );
          const d = (...args: string[]) =>
            must('docker', ['exec', variant.name, 'docker', ...args]);
          const storage = d('info', '-f', '{{json .DriverStatus}} {{.Driver}}').trim();
          fact(target, 'storage', storage);
          if (variant.snapshotter) expect(storage).toContain('io.containerd.snapshotter');
          else expect(storage).toContain('overlay2');

          // Pull the base BY DIGEST: on classic Docker 29 such an image is
          // missing from `docker image ls -q`, the case the base ref lookup
          // covers. The pull runs while the host saves (basePull).
          const digest = JSON.parse(
            docker(
              'image',
              'inspect',
              `127.0.0.1:${regPort}/vcdelta/node-runtime:test`,
              '--format',
              '{{json .RepoDigests}}',
            ),
          )[0].split('@')[1];
          const baseRef = `${REG}:5000/vcdelta/node-runtime@${digest}`;
          const basePull = new Promise<void>((resolve, reject) => {
            const p = spawn('docker', ['exec', variant.name, 'docker', 'pull', '-q', baseRef], {
              stdio: 'ignore',
            });
            p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`pull exited ${c}`))));
          });
          const transport = execTransport(variant.name);

          const t0 = Date.now();
          const cold = await deliverImage({
            tag: `${APP}:v1`,
            sshTarget: 'unused',
            runtime: 'docker',
            basePull,
            baseRef,
            deps: transport,
          });
          fact(target, 'cold', { ...cold, ms: Date.now() - t0, fullSaveBytes: fullSaveBytes.v1 });
          expect(cold.layersReused).toBe(baseLayers.length);
          expect(cold.layersSent).toBe(2);
          expect(cold.bytes).toBeLessThan(fullSaveBytes.v1 / 4);
          expect(
            JSON.parse(d('image', 'inspect', `${APP}:v1`, '--format', '{{json .RootFS.Layers}}')),
          ).toEqual(hostLayers.v1);
          expect(d('run', '--rm', `${APP}:v1`, 'cat', '/app/dist/marker').trim()).toBe(
            'vibecarbon layer-delta v1',
          );
          expect(d('run', '--rm', `${APP}:v1`, 'node', '-e', 'console.log(1+1)').trim()).toBe('2');
          expect(deltaRootEmpty(variant.name)).toBe(true);

          if (!hostLayers.v2) buildApp('v2');
          const t1 = Date.now();
          const warm = await deliverImage({
            tag: `${APP}:v2`,
            sshTarget: 'unused',
            runtime: 'docker',
            baseRef,
            deps: transport,
          });
          fact(target, 'distOnly', { ...warm, ms: Date.now() - t1 });
          expect(warm.layersSent).toBe(1);
          expect(warm.layersReused).toBe(baseLayers.length + 1);
          expect(d('run', '--rm', `${APP}:v2`, 'cat', '/app/dist/marker').trim()).toBe(
            'vibecarbon layer-delta v2',
          );
          expect(deltaRootEmpty(variant.name)).toBe(true);
        } finally {
          rmContainers(variant.name);
        }
      },
      LONG,
    );
  }

  it(
    'k3s: imports the delta, pushes it to the in-cluster registry, and a fresh namespace pulls it back',
    async () => {
      const target = 'k3s';
      expect(memAvailableMb()).toBeGreaterThan(500);
      const ctr = (ns: string, ...args: string[]) =>
        must('docker', ['exec', K3S, 'ctr', '-n', ns, ...args]);
      const resolveConfig = (ns: string, ref: string) => {
        const line = ctr(ns, 'images', 'ls')
          .split('\n')
          .find((l) => l.split(/\s+/)[0] === ref);
        if (!line) throw new Error(`${ref} not in ${ns}`);
        const digest = line.split(/\s+/)[2];
        const manifest = JSON.parse(ctr(ns, 'content', 'get', digest));
        const config = JSON.parse(ctr(ns, 'content', 'get', manifest.config.digest));
        return { digest, diffIds: config.rootfs.diff_ids as string[] };
      };
      try {
        docker(
          'run',
          '-d',
          '--privileged',
          '--name',
          K3S,
          '--network',
          NET,
          '--tmpfs',
          '/run',
          '--tmpfs',
          '/var/run',
          '-v',
          '/var/lib/rancher/k3s',
          K3S_IMAGE,
          'server',
          '--disable=traefik,servicelb,metrics-server,local-storage,coredns',
          '--disable-cloud-controller',
          '--disable-helm-controller',
          '--disable-network-policy',
        );
        waitFor(
          'k3s containerd',
          () => run('docker', ['exec', K3S, 'ctr', 'version']).status === 0,
          180_000,
        );
        // The base, pulled as Task 5's deploy pulls it on the master.
        const basePull = new Promise<void>((resolve, reject) => {
          const p = spawn(
            'docker',
            ['exec', K3S, 'ctr', '-n', 'k8s.io', 'images', 'pull', '--plain-http', baseInReg],
            { stdio: 'ignore' },
          );
          p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`pull exited ${c}`))));
        });
        const transport = execTransport(K3S);

        for (const version of ['v1', 'v2']) {
          if (!hostLayers[version]) buildApp(version);
          const tag = `${K3S_APP}:${version}`;
          docker('tag', `${APP}:${version}`, tag);
          hostTags.add(tag);
          const t0 = Date.now();
          const r = await deliverImage({
            tag,
            sshTarget: 'unused',
            runtime: 'k3s',
            registryRef: tag,
            basePull: version === 'v1' ? basePull : undefined,
            deps: transport,
          });
          fact(target, version, { ...r, ms: Date.now() - t0 });
          expect(r.layersReused).toBe(version === 'v1' ? baseLayers.length : baseLayers.length + 1);
          expect(r.layersSent).toBe(version === 'v1' ? 2 : 1);
          expect(resolveConfig('k8s.io', tag).diffIds).toEqual(hostLayers[version]);
          expect(deltaRootEmpty(K3S)).toBe(true);
        }

        // The registry holds what ctr pushed, compressed (the host gzipped
        // the app layers), and the registry-copy probe reads it (R8).
        const url = `http://127.0.0.1:${regPort}/v2/vcdelta/app/manifests/v2`;
        const head = must('curl', ['-fsSI', '-H', `Accept: ${MANIFEST_ACCEPT}`, url]);
        const body = JSON.parse(must('curl', ['-fsS', '-H', `Accept: ${MANIFEST_ACCEPT}`, url]));
        fact(
          target,
          'registry.layers',
          body.layers.map((l: { mediaType: string; size: number }) => `${l.mediaType} ${l.size}`),
        );
        for (const l of body.layers) expect(l.mediaType).toMatch(/gzip$/);
        const probed = must('sh', [
          '-c',
          `${MANIFEST_DIGEST_SH}\ndigest 127.0.0.1:${regPort} vcdelta/app v2`,
        ]).trim();
        expect(probed).toBe(/docker-content-digest:\s*(\S+)/i.exec(head)?.[1]);

        // A node that never saw the import pulls it with image-copy.js's flags.
        const remote = `${K3S_APP}:v2`;
        ctr('vcdelta-pull', 'images', 'pull', '--plain-http', '--all-platforms', remote);
        expect(resolveConfig('vcdelta-pull', remote).diffIds).toEqual(hostLayers.v2);
        expect(
          ctr(
            'vcdelta-pull',
            'run',
            '--rm',
            remote,
            'vcdelta-run',
            'cat',
            '/app/dist/marker',
          ).trim(),
        ).toBe('vibecarbon layer-delta v2');
      } finally {
        rmContainers(K3S);
      }
    },
    LONG,
  );
});
