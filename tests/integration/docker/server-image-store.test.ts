import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

// A compose server's Docker daemon config, run for real: every distinct
// /etc/docker/daemon.json the compose user data writes
// (carbon/cloud-init/docker-ce-setup.yaml, through each provider's renderer)
// starts a docker:29-dind daemon, which must come up on the classic image
// store, and a pull through a proxy that resets the first read of the image's
// layer mid-body must still succeed, by dockerd's own per-layer retry. That
// retry is why compose servers turn the containerd snapshotter off: Docker
// 29's default store pulls each layer once (decided 2026-11-09, after seven
// first pulls on fresh servers died with `connection reset by peer`).
//
// tests/unit/iac/docker-daemon-config-census.test.ts proves every compose
// server carries this config before its first pull; this file proves the
// config does what that census assumes, on the Docker a server would get
// (.github/workflows/docker-newest.yml runs it with VC_DIND_IMAGE=docker:dind).
//
// Everything runs on one docker network: a registry, a proxy (node from this
// repo's docker/node-runtime, running a script written below), and the dind
// daemon. Nothing listens outside it except the registry, on 127.0.0.1, for
// the host's push. Every container, network and image is named vcstore* and
// removed in afterAll.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');
// .github/workflows/docker-newest.yml sets this to the newest Docker.
const DIND_IMAGE = process.env.VC_DIND_IMAGE || 'docker:29-dind';
const REGISTRY_IMAGE = 'registry:3.1.2';
const NET = 'vcstore-net';
const REG = 'vcstore-reg';
const PROXY = 'vcstore-proxy';
const DIND = 'vcstore-dind';
const NODE_TAG = 'vcstore/node-runtime:test';
const BLOB_TAG = 'vcstore/blob:test';
// The proxy cuts a layer after this many bytes, so the reset lands mid-body.
const CUT_BYTES = 1 << 20;
const LONG = 900_000;

type Run = { status: number | null; stdout: string; stderr: string };
const run = (cmd: string, args: string[]): Run => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
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
const fact = (key: string, value: unknown) =>
  console.log(
    `[server-image-store] ${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
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

/** Every distinct daemon.json a compose server's user data writes. */
async function serverDaemonConfigs(): Promise<string[]> {
  const configs = new Set<string>();
  for (const Provider of Object.values(PROVIDERS)) {
    const userData = (await Provider.getComposeUserData()) as string;
    const cfg = loadYaml(userData) as { write_files?: Array<{ path?: string; content?: string }> };
    for (const f of cfg.write_files ?? []) {
      if (f.path === '/etc/docker/daemon.json' && f.content) configs.add(f.content);
    }
  }
  return [...configs];
}

/**
 * The proxy: passes every request to the registry, except the first plain GET
 * of each large blob, which it cuts after CUT_BYTES with a TCP reset (what the
 * failed server pulls saw: `read: connection reset by peer`). One `reset ...`
 * line per cut on stdout.
 */
const PROXY_SCRIPT = `
import http from 'node:http';
const seen = new Set();
http
  .createServer((req, res) => {
    const up = http.request(
      { host: '${REG}', port: 5000, method: req.method, path: req.url, headers: req.headers },
      (ur) => {
        const blob = /\\/blobs\\/(sha256:[0-9a-f]{64})$/.exec(req.url || '');
        const len = Number(ur.headers['content-length'] || 0);
        const cut =
          req.method === 'GET' && blob && ur.statusCode === 200 &&
          len > 2 * ${CUT_BYTES} && !seen.has(blob[1]);
        res.writeHead(ur.statusCode || 502, ur.headers);
        if (!cut) {
          ur.pipe(res);
          return;
        }
        seen.add(blob[1]);
        let sent = 0;
        ur.on('data', (chunk) => {
          if (sent >= ${CUT_BYTES}) return;
          const part = chunk.subarray(0, ${CUT_BYTES} - sent);
          sent += part.length;
          if (sent < ${CUT_BYTES}) {
            res.write(part);
            return;
          }
          ur.destroy();
          res.write(part, () => {
            console.log('reset ' + blob[1] + ' after ' + sent + ' of ' + len + ' bytes');
            res.socket.resetAndDestroy();
          });
        });
      },
    );
    up.on('error', () => res.destroy());
    req.pipe(up);
  })
  .listen(8080, () => console.log('listening'));
`;

describeDocker('a compose server’s Docker daemon config, on a real dockerd', () => {
  let work: string;
  let proxyDir: string;
  let configs: string[];
  let hostLayers: string[];
  const hostTags = new Set<string>();

  beforeAll(async () => {
    configs = await serverDaemonConfigs();
    fact('distinctConfigs', configs.length);
    expect(configs.length).toBeGreaterThan(0);
    work = mkdtempSync(join(tmpdir(), 'vcstore-'));

    // The image the server pulls: one incompressible layer, so its blob is
    // several times CUT_BYTES and the reset lands inside it.
    const context = join(work, 'blob');
    mkdirSync(context);
    writeFileSync(join(context, 'blob'), randomBytes(4 * CUT_BYTES));
    writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY blob /blob\n');
    docker('buildx', 'build', '--builder', 'default', '--load', '-q', '-t', BLOB_TAG, context);
    hostTags.add(BLOB_TAG);
    hostLayers = JSON.parse(
      docker('image', 'inspect', BLOB_TAG, '--format', '{{json .RootFS.Layers}}'),
    );

    // node for the proxy, from this checkout (no registry needed).
    docker(
      'buildx',
      'build',
      '--builder',
      'default',
      '--load',
      '-q',
      '-t',
      NODE_TAG,
      join(REPO_ROOT, 'docker/node-runtime'),
    );
    hostTags.add(NODE_TAG);

    docker('network', 'create', NET);
    docker('run', '-d', '--name', REG, '--network', NET, '-p', '127.0.0.1::5000', REGISTRY_IMAGE);
    const regPort = docker('port', REG, '5000').trim().split('\n')[0].split(':').pop() as string;
    const hostRef = `127.0.0.1:${regPort}/vcstore/blob:test`;
    docker('tag', BLOB_TAG, hostRef);
    hostTags.add(hostRef);
    waitFor('registry', () => run('docker', ['push', '-q', hostRef]).status === 0, 60_000);

    proxyDir = join(work, 'proxy');
    mkdirSync(proxyDir);
    writeFileSync(join(proxyDir, 'proxy.mjs'), PROXY_SCRIPT);
  }, LONG);

  afterAll(() => {
    rmContainers(DIND, PROXY, REG);
    run('docker', ['network', 'rm', NET]);
    for (const t of hostTags) run('docker', ['image', 'rm', t]);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it(
    'runs the classic image store, and a pull survives a reset mid-layer by its own retry',
    () => {
      for (const config of configs) {
        // The server's file as is, plus only what reaching the test registry
        // over plain http needs.
        const daemonJson = JSON.stringify({
          ...JSON.parse(config),
          'insecure-registries': [`${PROXY}:8080`],
        });
        try {
          // A fresh proxy per config, so each pull meets its own reset.
          docker(
            'run',
            '-d',
            '--name',
            PROXY,
            '--network',
            NET,
            '-v',
            `${proxyDir}:/p:ro`,
            NODE_TAG,
            'node',
            '/p/proxy.mjs',
          );
          waitFor('proxy', () => docker('logs', PROXY).includes('listening'), 30_000);
          docker(
            'run',
            '-d',
            '--privileged',
            '--name',
            DIND,
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
          waitFor('dockerd', () => run('docker', ['exec', DIND, 'docker', 'info']).status === 0);
          const d = (...args: string[]) => must('docker', ['exec', DIND, 'docker', ...args]);
          fact('engine', d('version', '--format', '{{.Server.Version}}').trim());

          const info = JSON.parse(d('info', '--format', '{{json .}}'));
          fact('storage', { driver: info.Driver, status: info.DriverStatus });
          expect(JSON.stringify(info.DriverStatus)).not.toContain('io.containerd.snapshotter');
          expect(info.Driver).toBe('overlay2');
          expect(info.LoggingDriver).toBe('json-file');

          const ref = `${PROXY}:8080/vcstore/blob:test`;
          const started = Date.now();
          const pull = run('docker', ['exec', DIND, 'docker', 'pull', ref]);
          fact('pull', { status: pull.status, ms: Date.now() - started });
          const resets = docker('logs', PROXY)
            .split('\n')
            .filter((l) => l.startsWith('reset '));
          fact('resets', resets);
          // Not vacuous: the proxy really cut the layer.
          expect(resets.length).toBeGreaterThan(0);
          const daemonLog = run('docker', ['logs', DIND]);
          const retries = `${daemonLog.stdout}\n${daemonLog.stderr}`
            .split('\n')
            .filter((l) => /Download failed, retrying/.test(l));
          fact(
            'dockerdRetries',
            retries.map((l) => l.slice(0, 300)),
          );
          expect(pull.status, pull.stderr || pull.stdout).toBe(0);
          expect(retries.length).toBeGreaterThan(0);
          expect(
            JSON.parse(d('image', 'inspect', ref, '--format', '{{json .RootFS.Layers}}')),
          ).toEqual(hostLayers);
        } finally {
          rmContainers(DIND, PROXY);
        }
      }
    },
    LONG,
  );
});
