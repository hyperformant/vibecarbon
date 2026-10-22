import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MANIFEST_ACCEPT, MANIFEST_DIGEST_SH } from '../../../src/lib/deploy/k8s/image-delivery.js';

// Spike (cold-deploy speed plan, Task 1): proves the diffID layer delta round
// trip on every store a deploy target can have, before any code depends on it.
//
//   host:   build the fixture, `docker save` it, drop every layer blob whose
//           diffID the target already holds, ship the rest (the delta).
//   target: fill the gaps from its own save/export of the base, write the
//           final legacy manifest.json, load it, run it.
//
// Targets: docker:29-dind classic store, docker:29-dind with the containerd
// snapshotter, and k3s (`ctr images import`, then a push to a registry:2.8.3
// sidecar and a `ctr images pull --plain-http` back, the call
// src/lib/deploy/k8s/ha/image-copy.js makes).
//
// Every container, network and volume this file makes is named vcspike-* and
// removed with `docker rm -f -v` in afterAll. One target runs at a time.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');
// The fixture is a pinned small base plus one COPY layer, written into the
// build context at run time: a committed file named Dockerfile would enter the
// repo's Dockerfile censuses and Dependabot's docker ecosystem as if it shipped.
const BASE = 'alpine:3.21@sha256:c3f8e73fdb79deaebaa2037150150191b9dcbfba68b4a46d70103204c53f4709';
const MARKER = 'vibecarbon layer-delta marker';
const TAG = 'vcspike/layer-delta:test';
const DIND_IMAGE = 'docker:29-dind';
const K3S_IMAGE = 'rancher/k3s:v1.31.5-k3s1';
const REGISTRY_IMAGE = 'registry:2.8.3';
const DIND_CLASSIC = 'vcspike-dind-classic';
const DIND_CONTAINERD = 'vcspike-dind-containerd';
const K3S = 'vcspike-k3s';
const REG = 'vcspike-reg';
const NET = 'vcspike-net';
const LONG = 600_000;

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
const sha256File = (p: string) =>
  `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
const fact = (target: string, key: string, value: unknown) =>
  console.log(
    `[spike:${target}] ${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
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

/** Base archive metadata the target holds, read back as a few KB of JSON. */
type BaseArchive = { pathByDiffId: Map<string, string> };

/**
 * Reads the base archive the target extracted at /vcspike/vcbase and pairs its
 * manifest.json Layers[i] with the config's rootfs.diff_ids[i].
 */
function readTargetBase(target: string, container: string): BaseArchive {
  const manifest = JSON.parse(sh(container, 'cat /vcspike/vcbase/manifest.json'))[0];
  const config = JSON.parse(sh(container, `cat /vcspike/vcbase/${manifest.Config}`));
  const diffIds: string[] = config.rootfs.diff_ids;
  expect(manifest.Layers.length).toBe(diffIds.length);
  const pathByDiffId = new Map<string, string>();
  const kinds: string[] = [];
  manifest.Layers.forEach((p: string, i: number) => {
    pathByDiffId.set(diffIds[i], p);
    // gzip magic is 1f 8b; anything else is an uncompressed tar here.
    const magic = sh(container, `head -c 2 /vcspike/vcbase/${p} | od -An -tx1 | tr -d ' \\n'`);
    kinds.push(`${p} ${magic === '1f8b' ? 'gzip' : 'uncompressed'}`);
  });
  fact(target, 'base.archive.layers', kinds);
  return { pathByDiffId };
}

/**
 * The target-side gap fill: copies the base's own layer files under the names
 * the delta's manifest.json expects, then tars exactly the manifest's files.
 */
function reconstruct(container: string, members: string[]) {
  sh(
    container,
    `set -eu
rm -rf /vcspike/vcout && mkdir -p /vcspike/vcout
tar -xf /vcspike/vcdelta.tar -C /vcspike/vcout
while read -r src dst; do [ -n "$src" ] || continue; cp "/vcspike/vcbase/$src" "/vcspike/vcout/$dst"; done < /vcspike/vcout/fill.txt
cd /vcspike/vcout && tar -cf /vcspike/vcfull.tar ${members.join(' ')}`,
  );
}

describeDocker('layer delta round trip (spike)', () => {
  let work: string;
  let hostId: string;
  let hostLayers: string[];
  let hostLayerPaths: string[];
  let hostConfigPath: string;
  let fullSaveBytes: number;

  beforeAll(() => {
    expect(BASE).toMatch(/@sha256:[0-9a-f]{64}$/);
    // The k3s pin must track the one deploys install.
    expect(readFileSync(join(REPO_ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8')).toContain(
      `K3S_VERSION = '${K3S_IMAGE.split(':')[1].replace(/-k3s/, '+k3s')}'`,
    );
    work = mkdtempSync(join(tmpdir(), 'vcspike-'));
    const context = join(work, 'context');
    mkdirSync(context);
    writeFileSync(join(context, 'Dockerfile'), `FROM ${BASE}\nCOPY marker /marker\n`);
    writeFileSync(join(context, 'marker'), `${MARKER}\n`);
    docker('buildx', 'build', '--builder', 'default', '--load', '-q', '-t', TAG, context);
    const inspect = JSON.parse(docker('image', 'inspect', TAG))[0];
    hostId = inspect.Id;
    hostLayers = inspect.RootFS.Layers;
    docker('save', TAG, '-o', join(work, 'full.tar'));
    fullSaveBytes = statSync(join(work, 'full.tar')).size;
    mkdirSync(join(work, 'save'));
    must('tar', ['-xf', join(work, 'full.tar'), '-C', join(work, 'save')]);
    const manifest = JSON.parse(readFileSync(join(work, 'save/manifest.json'), 'utf-8'))[0];
    hostConfigPath = join(work, 'save', manifest.Config);
    const config = JSON.parse(readFileSync(hostConfigPath, 'utf-8'));
    hostLayerPaths = manifest.Layers.map((p: string) => join(work, 'save', p));

    // Archive facts Task 3 codes against: Layers[i] pairs with diff_ids[i],
    // and the host (classic store) writes each layer uncompressed, named by
    // its diffID, so sha256(file) == diffID.
    expect(config.rootfs.diff_ids).toEqual(hostLayers);
    expect(sha256File(hostConfigPath)).toBe(hostId);
    expect(hostLayerPaths.map(sha256File)).toEqual(hostLayers);
    fact('host', 'manifest.Layers', manifest.Layers);
    fact('host', 'diff_ids', hostLayers);
    fact('host', 'fullSaveBytes', fullSaveBytes);
  }, LONG);

  afterAll(() => {
    rmContainers(DIND_CLASSIC, DIND_CONTAINERD, K3S, REG);
    run('docker', ['network', 'rm', NET]);
    run('docker', ['image', 'rm', TAG]);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /**
   * Builds the delta for a target that holds `held` diffIDs and whose base
   * archive is `base`. Returns its byte size and the tar member list.
   */
  function buildDelta(name: string, held: Set<string>, base: BaseArchive) {
    const out = join(work, `delta-${name}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    const fill: string[] = [];
    const layers = hostLayers.map((diffId, i) => {
      // Neutral names on purpose: the loader must accept layer files that are
      // not named by their digest, gzip or not.
      const member = `l${i}`;
      const basePath = base.pathByDiffId.get(diffId);
      if (held.has(diffId) && basePath) fill.push(`${basePath} ${member}`);
      else copyFileSync(hostLayerPaths[i], join(out, member));
      return member;
    });
    copyFileSync(hostConfigPath, join(out, 'config.json'));
    writeFileSync(
      join(out, 'manifest.json'),
      JSON.stringify([{ Config: 'config.json', RepoTags: [TAG], Layers: layers }]),
    );
    writeFileSync(join(out, 'fill.txt'), `${fill.join('\n')}\n`);
    const shipped = [
      'manifest.json',
      'config.json',
      'fill.txt',
      ...layers.filter((_, i) => !fill.some((f) => f.endsWith(` l${i}`))),
    ];
    must('tar', ['-cf', join(out, '..', `delta-${name}.tar`), '-C', out, ...shipped]);
    const deltaBytes = statSync(join(work, `delta-${name}.tar`)).size;
    fact(name, 'delta.members', shipped);
    fact(name, 'deltaBytes', deltaBytes);
    fact(name, 'fill', fill);
    return {
      tar: join(work, `delta-${name}.tar`),
      deltaBytes,
      members: ['manifest.json', 'config.json', ...layers],
    };
  }

  for (const variant of [
    { name: DIND_CLASSIC, label: 'classic', snapshotter: false },
    { name: DIND_CONTAINERD, label: 'containerd-snapshotter', snapshotter: true },
  ]) {
    it(
      `docker:29-dind ${variant.label} store loads the delta`,
      () => {
        const target = variant.label;
        expect(memAvailableMb()).toBeGreaterThan(300);
        const daemonJson = `{"features":{"containerd-snapshotter":${variant.snapshotter}}}`;
        try {
          docker(
            'run',
            '-d',
            '--privileged',
            '--name',
            variant.name,
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

          // The target pre-pulls the base, then reports the diffIDs it holds.
          sh(variant.name, 'mkdir -p /vcspike');
          d('pull', '-q', BASE);
          // An image pulled by digest alone has no tag; record whether
          // `image ls` still lists it, and ask for the base ref directly.
          fact(target, 'image.ls.q', d('image', 'ls', '-q').trim() || '(empty)');
          fact(target, 'image.ls.aq', d('image', 'ls', '-a', '-q').trim() || '(empty)');
          const held = new Set<string>(
            JSON.parse(d('image', 'inspect', BASE, '--format', '{{json .RootFS.Layers}}')),
          );
          fact(target, 'held', [...held]);

          // Its own save of the base fills the gaps.
          const saveBase = run('docker', [
            'exec',
            variant.name,
            'docker',
            'save',
            BASE,
            '-o',
            '/vcspike/vcbase.tar',
          ]);
          fact(target, 'base.save.plain', saveBase.status === 0 ? 'ok' : saveBase.stderr.trim());
          if (saveBase.status !== 0)
            d('save', '--platform', 'linux/amd64', BASE, '-o', '/vcspike/vcbase.tar');
          sh(
            variant.name,
            'mkdir -p /vcspike/vcbase && tar -xf /vcspike/vcbase.tar -C /vcspike/vcbase',
          );
          const base = readTargetBase(target, variant.name);

          const delta = buildDelta(target, held, base);
          docker('cp', delta.tar, `${variant.name}:/vcspike/vcdelta.tar`);
          reconstruct(variant.name, delta.members);
          fact(target, 'load', d('load', '-i', '/vcspike/vcfull.tar').trim());

          const loaded = JSON.parse(d('image', 'inspect', TAG))[0];
          // Re-save to read the config digest the store holds (with the
          // containerd store, inspect's Id is the manifest digest).
          const reManifest = JSON.parse(
            sh(
              variant.name,
              `rm -rf /vcspike/vcre && mkdir -p /vcspike/vcre && docker save ${TAG} | tar -x -C /vcspike/vcre && cat /vcspike/vcre/manifest.json`,
            ),
          )[0];
          const configDigest = `sha256:${sh(variant.name, `sha256sum /vcspike/vcre/${reManifest.Config}`).split(' ')[0]}`;
          fact(target, 'loaded.Id', loaded.Id);
          fact(target, 'loaded.configDigest', configDigest);

          expect(loaded.RootFS.Layers).toEqual(hostLayers);
          expect(configDigest).toBe(hostId);
          if (!variant.snapshotter) expect(loaded.Id).toBe(hostId);
          expect(d('run', '--rm', TAG, 'cat', '/marker').trim()).toBe(MARKER);
          expect(delta.deltaBytes).toBeLessThan(fullSaveBytes / 10);
        } finally {
          rmContainers(variant.name);
        }
      },
      LONG,
    );
  }

  it(
    'k3s ctr imports the delta, and the pushed tag pulls back through a registry',
    () => {
      const target = 'k3s';
      expect(memAvailableMb()).toBeGreaterThan(500);
      const k = (...args: string[]) => must('docker', ['exec', K3S, ...args]);
      // The rancher/k3s image answers `k3s ctr` with "No help topic"; its
      // /bin/ctr symlink is the same multicall binary a node's `k3s ctr` runs.
      const ctr = (ns: string, ...args: string[]) => k('ctr', '-n', ns, ...args);
      const ctrRun = (ns: string, ...args: string[]) =>
        run('docker', ['exec', K3S, 'ctr', '-n', ns, ...args]);
      // A ref's resolved manifest (an index is followed to linux/amd64).
      const resolve = (ns: string, ref: string) => {
        const line = ctr(ns, 'images', 'ls')
          .split('\n')
          .find((l) => l.split(/\s+/)[0] === ref);
        if (!line) throw new Error(`${ref} not in ${ns}`);
        const [, type, digest] = line.split(/\s+/);
        let manifest = JSON.parse(ctr(ns, 'content', 'get', digest));
        let manifestDigest = digest;
        if (manifest.manifests) {
          const m = manifest.manifests.find(
            (x: { platform?: { architecture?: string } }) => x.platform?.architecture === 'amd64',
          );
          manifestDigest = m.digest;
          manifest = JSON.parse(ctr(ns, 'content', 'get', m.digest));
        }
        const config = JSON.parse(ctr(ns, 'content', 'get', manifest.config.digest));
        return {
          type,
          digest,
          manifestDigest,
          manifest,
          configDigest: manifest.config.digest,
          diffIds: config.rootfs.diff_ids as string[],
        };
      };
      const ref = `docker.io/${TAG}`;
      const baseRef = `docker.io/library/${BASE}`;
      try {
        docker('network', 'create', NET);
        docker(
          'run',
          '-d',
          '--name',
          REG,
          '--network',
          NET,
          '-p',
          '127.0.0.1::5000',
          REGISTRY_IMAGE,
        );
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
        const regPort = docker('port', REG, '5000').trim().split('\n')[0].split(':').pop();
        const regHost = `127.0.0.1:${regPort}`;
        fact(target, 'containerd', k('ctr', 'version').replace(/\s+/g, ' ').trim());

        // Pre-pull the base, report held diffIDs from the image store.
        sh(K3S, 'mkdir -p /vcspike');
        ctr('k8s.io', 'images', 'pull', '--platform', 'linux/amd64', baseRef);
        const held = new Set<string>();
        for (const r of ctr('k8s.io', 'images', 'ls', '-q').trim().split('\n').filter(Boolean)) {
          try {
            for (const d of resolve('k8s.io', r).diffIds) held.add(d);
          } catch {
            // content for another platform, or a ref with no local manifest
          }
        }
        fact(target, 'held', [...held]);

        // Its own export of the base fills the gaps.
        ctr(
          'k8s.io',
          'images',
          'export',
          '--platform',
          'linux/amd64',
          '/vcspike/vcbase.tar',
          baseRef,
        );
        sh(K3S, 'mkdir -p /vcspike/vcbase && tar -xf /vcspike/vcbase.tar -C /vcspike/vcbase');
        fact(
          target,
          'base.export.files',
          sh(K3S, 'cd /vcspike/vcbase && find . -type f | sort').trim().split('\n'),
        );
        const base = readTargetBase(target, K3S);

        const delta = buildDelta(target, held, base);
        docker('cp', delta.tar, `${K3S}:/vcspike/vcdelta.tar`);
        reconstruct(K3S, delta.members);
        fact(target, 'import', ctr('k8s.io', 'images', 'import', '/vcspike/vcfull.tar').trim());

        const loaded = resolve('k8s.io', ref);
        fact(target, 'loaded', {
          type: loaded.type,
          digest: loaded.digest,
          manifestMediaType: loaded.manifest.mediaType,
          layers: loaded.manifest.layers.map(
            (l: { mediaType: string; digest: string }) => `${l.mediaType} ${l.digest}`,
          ),
        });
        expect(loaded.diffIds).toEqual(hostLayers);
        expect(loaded.configDigest).toBe(hostId);
        expect(ctr('k8s.io', 'run', '--rm', ref, 'vcspike-run', 'cat', '/marker').trim()).toBe(
          MARKER,
        );
        expect(delta.deltaBytes).toBeLessThan(fullSaveBytes / 10);

        // Push, as the primary registry would be filled, and record what lands.
        const remote = `${REG}:5000/vcspike/layer-delta:test`;
        ctr('k8s.io', 'images', 'push', '--plain-http', remote, ref);
        const head = must('curl', [
          '-fsSI',
          '-H',
          `Accept: ${MANIFEST_ACCEPT}`,
          `http://${regHost}/v2/vcspike/layer-delta/manifests/test`,
        ]);
        const body = JSON.parse(
          must('curl', [
            '-fsS',
            '-H',
            `Accept: ${MANIFEST_ACCEPT}`,
            `http://${regHost}/v2/vcspike/layer-delta/manifests/test`,
          ]),
        );
        fact(target, 'registry.contentType', /content-type:\s*(\S+)/i.exec(head)?.[1]);
        fact(target, 'registry.manifest.mediaType', body.mediaType);
        fact(target, 'registry.config.mediaType', body.config?.mediaType);
        fact(
          target,
          'registry.layers',
          body.layers?.map((l: { mediaType: string; size: number }) => `${l.mediaType} ${l.size}`),
        );
        expect(MANIFEST_ACCEPT).toContain(body.mediaType);

        // The registry-copy probe reads the ctr-pushed tag (R8).
        const headDigest = /docker-content-digest:\s*(\S+)/i.exec(head)?.[1];
        const probed = must('sh', [
          '-c',
          `${MANIFEST_DIGEST_SH}\ndigest ${regHost} vcspike/layer-delta test`,
        ]).trim();
        fact(target, 'probe.digest', probed);
        expect(probed).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(probed).toBe(headDigest);
        expect(probed).toBe(loaded.digest);

        // Pull back with image-copy.js's flags, into a fresh namespace so no
        // blob is satisfied from the importing namespace's content.
        const pull = ctrRun(
          'vcspike-pull',
          'images',
          'pull',
          '--plain-http',
          '--all-platforms',
          remote,
        );
        fact(target, 'pull.status', pull.status);
        if (pull.status !== 0) fact(target, 'pull.stderr', pull.stderr.trim());
        expect(pull.status).toBe(0);
        const pulled = resolve('vcspike-pull', remote);
        expect(pulled.diffIds).toEqual(hostLayers);
        expect(pulled.configDigest).toBe(hostId);
        expect(
          ctr('vcspike-pull', 'run', '--rm', remote, 'vcspike-run2', 'cat', '/marker').trim(),
        ).toBe(MARKER);
      } finally {
        rmContainers(K3S, REG);
        run('docker', ['network', 'rm', NET]);
      }
    },
    LONG,
  );
});
