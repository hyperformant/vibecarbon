import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDelta,
  deliverImage,
  deliverySshArgs,
  listTargetDiffIds,
  listTargetLayers,
  normalizeImageRef,
} from '../../../src/lib/deploy/layer-delta.js';
import { SSH_CONNECTION_OPTS } from '../../../src/lib/host-keys.js';

// A fake `docker save` directory: OCI layout plus the legacy manifest.json,
// layer files uncompressed and named by diffID, exactly as the classic store
// writes them (task-1 archive fact 1).
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const LAYER_BODIES = ['base-alpine', 'base-libstdcxx', 'base-node', 'app-deps', 'app-dist'];
const DIFF_IDS = LAYER_BODIES.map((b) => `sha256:${sha(b)}`);
const BASE_DIFF_IDS = DIFF_IDS.slice(0, 3);
const APP_DIFF_IDS = DIFF_IDS.slice(3);
const blobOf = (diffId: string) => `blobs/sha256/${diffId.slice('sha256:'.length)}`;
const APP_LAYER_BLOBS = APP_DIFF_IDS.map(blobOf);
const CONFIG_JSON = JSON.stringify({
  architecture: 'amd64',
  os: 'linux',
  rootfs: { type: 'layers', diff_ids: DIFF_IDS },
});
const CONFIG_BLOB = `blobs/sha256/${sha(CONFIG_JSON)}`;
const TAG = 'vibecarbon-local/app:abc123-20261021000000';

function writeFixture(dir: string) {
  mkdirSync(join(dir, 'blobs/sha256'), { recursive: true });
  LAYER_BODIES.forEach((b, i) => {
    writeFileSync(join(dir, blobOf(DIFF_IDS[i])), b);
  });
  writeFileSync(join(dir, CONFIG_BLOB), CONFIG_JSON);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify([{ Config: CONFIG_BLOB, RepoTags: [TAG], Layers: DIFF_IDS.map(blobOf) }]),
  );
  writeFileSync(join(dir, 'index.json'), '{"schemaVersion":2,"manifests":[]}');
  writeFileSync(join(dir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
}

const isLayerBlob = (p: string) => p.startsWith('blobs/') && p !== CONFIG_BLOB;

let fixture: string;
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vc-layer-delta-test-'));
  fixture = join(scratch, 'save');
  mkdirSync(fixture);
  writeFixture(fixture);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('buildDelta', () => {
  it('sends only the app layers when the target holds the base', () => {
    const d = buildDelta({ archiveDir: fixture, have: new Set(BASE_DIFF_IDS) });
    expect(d.sendPaths.filter(isLayerBlob)).toEqual(APP_LAYER_BLOBS);
    expect(d.sendPaths).toEqual(expect.arrayContaining(['manifest.json', CONFIG_BLOB]));
    expect(d.keep).toEqual(BASE_DIFF_IDS.map((diffId, index) => ({ index, diffId })));
    expect(d.totalLayers).toBe(5);
  });

  it('never sends the OCI index: its manifest blob is not in the delta, so a loader reading it would fail', () => {
    const d = buildDelta({ archiveDir: fixture, have: new Set(BASE_DIFF_IDS) });
    expect(d.sendPaths).not.toContain('index.json');
    expect(d.sendPaths).not.toContain('oci-layout');
  });

  it('sends every layer to an empty target (a custom Dockerfile, or no base pulled)', () => {
    const d = buildDelta({ archiveDir: fixture, have: new Set() });
    expect(d.sendPaths.filter(isLayerBlob)).toEqual(DIFF_IDS.map(blobOf));
    expect(d.keep).toEqual([]);
    expect(d.totalLayers).toBe(5);
  });

  it('sends exactly one layer when only dist changed', () => {
    // The target holds the base and the previous app image's deps layer.
    const d = buildDelta({ archiveDir: fixture, have: new Set(DIFF_IDS.slice(0, 4)) });
    expect(d.sendPaths.filter(isLayerBlob)).toEqual([blobOf(DIFF_IDS[4])]);
    expect(d.keep.map((k) => k.index)).toEqual([0, 1, 2, 3]);
  });

  it('pairs Layers[i] with diff_ids[i], not the blob name (a containerd host names layers by compressed digest)', () => {
    const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf-8'));
    manifest[0].Layers = DIFF_IDS.map((_, i) => `blobs/sha256/${sha(`gz-${i}`)}`);
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify(manifest));
    const d = buildDelta({ archiveDir: fixture, have: new Set(BASE_DIFF_IDS) });
    expect(d.sendPaths.filter(isLayerBlob)).toEqual(
      [3, 4].map((i) => `blobs/sha256/${sha(`gz-${i}`)}`),
    );
  });

  it('refuses an archive whose Layers and diff_ids disagree in length', () => {
    const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf-8'));
    manifest[0].Layers.pop();
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify(manifest));
    expect(() => buildDelta({ archiveDir: fixture, have: new Set() })).toThrow(/5 diff_ids/);
  });
});

describe('listTargetLayers / listTargetDiffIds', () => {
  const ID_A = `sha256:${sha('img-a')}`;
  const ID_B = `sha256:${sha('img-b')}`;

  it('docker: maps each held diffID to an image that holds it, asking the base ref directly', async () => {
    const cmds: string[] = [];
    const run = async (cmd: string) => {
      cmds.push(cmd);
      return `${ID_A} ${BASE_DIFF_IDS.join(' ')} \n${ID_B} ${DIFF_IDS.slice(0, 4).join(' ')} \n`;
    };
    const layers = await listTargetLayers({ run, runtime: 'docker', refs: ['ghcr.io/x/base:1'] });
    expect([...layers.keys()].sort()).toEqual(DIFF_IDS.slice(0, 4).sort());
    expect(layers.get(DIFF_IDS[3])).toBe(ID_B);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('docker image ls -a -q --no-trunc');
    expect(cmds[0]).toContain("'ghcr.io/x/base:1'");
  });

  it('docker: prefers the image that covers the most layers, so the target saves as few images as possible', async () => {
    const run = async () =>
      `${ID_A} ${BASE_DIFF_IDS[0]} \n${ID_B} ${DIFF_IDS.slice(0, 4).join(' ')} \n`;
    const layers = await listTargetLayers({ run, runtime: 'docker' });
    expect(new Set(layers.values())).toEqual(new Set([ID_B]));
  });

  it('k3s: reads diffIDs from the content store uncompressed labels and names the blob that holds each', async () => {
    const gz = (i: number) => `sha256:${sha(`gz-${i}`)}`;
    const run = async (cmd: string) => {
      expect(cmd).toContain('content ls');
      return [
        'DIGEST\tSIZE\tAGE\tLABELS',
        `${gz(0)}\t3.6MB\t2 minutes\tcontainerd.io/distribution.source.ghcr.io=x/base,containerd.io/uncompressed=${DIFF_IDS[0]}`,
        `${gz(1)}\t1.2kB\t2 minutes\tcontainerd.io/gc.ref.content.l.0=${gz(0)}`,
        `${gz(2)}\t50MB\t2 minutes\tcontainerd.io/uncompressed=${DIFF_IDS[2]},containerd.io/distribution.source.ghcr.io=x/base`,
        '',
      ].join('\n');
    };
    const layers = await listTargetLayers({ run, runtime: 'k3s' });
    expect(Object.fromEntries(layers)).toEqual({ [DIFF_IDS[0]]: gz(0), [DIFF_IDS[2]]: gz(2) });
    expect(await listTargetDiffIds({ run, runtime: 'k3s' })).toEqual(
      new Set([DIFF_IDS[0], DIFF_IDS[2]]),
    );
  });

  it('a failed listing fails loudly instead of degrading to a full send', async () => {
    const run = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    await expect(listTargetDiffIds({ run })).rejects.toThrow('Cannot connect to the Docker daemon');
  });
});

describe('normalizeImageRef', () => {
  it('names an image the way ctr import names it from RepoTags', () => {
    expect(normalizeImageRef('10.0.1.1:5000/app:abc')).toBe('10.0.1.1:5000/app:abc');
    expect(normalizeImageRef('vibecarbon-local/app:abc')).toBe(
      'docker.io/vibecarbon-local/app:abc',
    );
    expect(normalizeImageRef('app:abc')).toBe('docker.io/library/app:abc');
    expect(normalizeImageRef('localhost/app')).toBe('localhost/app:latest');
  });
});

describe('deliverySshArgs', () => {
  it('pins the per-env known_hosts and carries the shared transport opts, like the sideload did', () => {
    const args = deliverySshArgs({
      sshTarget: 'root@203.0.113.7',
      sshKey: '/p/.vibecarbon/deploy_key_prod',
    });
    expect(args.slice(0, 2)).toEqual(['-i', '/p/.vibecarbon/deploy_key_prod']);
    expect(args).toContain('UserKnownHostsFile=/p/.vibecarbon/known_hosts_prod');
    expect(args).toContain('GlobalKnownHostsFile=/dev/null');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    // OpenSSH keeps the first value per option: 30 s must precede the shared 10 s.
    expect(args.indexOf('ConnectTimeout=30')).toBeLessThan(args.indexOf('ConnectTimeout=10'));
    expect(args.join(' ')).toContain(SSH_CONNECTION_OPTS.join(' '));
    expect(args.at(-1)).toBe('root@203.0.113.7');
  });
});

// ---------------------------------------------------------------------------

type SendCall = { cmd: string; body: Buffer };
function stubSsh({ exit = 0, stderr = '' } = {}) {
  const sent: SendCall[] = [];
  const stub = {
    calls: 0,
    sent,
    async send(cmd: string, stdin: Readable) {
      stub.calls++;
      const chunks: Buffer[] = [];
      for await (const c of stdin) chunks.push(c as Buffer);
      sent.push({ cmd, body: Buffer.concat(chunks) });
      return { code: exit, stderr };
    },
  };
  return stub;
}

/** Lists a tar stream's members and reads one of them. */
function untar(body: Buffer) {
  const dir = mkdtempSync(join(scratch, 'untar-'));
  writeFileSync(join(dir, 'x.tar'), body);
  const out = join(dir, 'out');
  mkdirSync(out);
  execFileSync('tar', ['-xf', join(dir, 'x.tar'), '-C', out]);
  const members = execFileSync('tar', ['-tf', join(dir, 'x.tar')], { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
    .map((m) => m.replace(/^\.\//, ''))
    .filter((m) => m !== '' && m !== '.')
    .sort();
  return { members, read: (m: string) => readFileSync(join(out, m)) };
}

const ID_BASE = `sha256:${sha('base-image')}`;
const listBase = async () => `${ID_BASE} ${BASE_DIFF_IDS.join(' ')} \n`;
const saveFixture = async (_tag: string, dir: string) => writeFixture(dir);
const noLock = async () => () => {};

describe('deliverImage', () => {
  const args = {
    tag: TAG,
    sshTarget: 'root@203.0.113.7',
    sshKey: '/p/.vibecarbon/deploy_key_prod',
    runtime: 'docker' as const,
  };

  it('ships manifest, config and the gzipped app layers, with a fill list for the base', async () => {
    const ssh = stubSsh();
    const r = await deliverImage({
      ...args,
      deps: { run: listBase, send: ssh.send, saveImage: saveFixture, acquireLock: noLock },
    });
    expect(r).toEqual({ bytes: ssh.sent[0].body.length, layersSent: 2, layersReused: 3 });
    const t = untar(ssh.sent[0].body);
    expect(t.members).toEqual(['config.json', 'fill.txt', 'l3', 'l4', 'manifest.json']);
    expect(JSON.parse(t.read('manifest.json').toString())).toEqual([
      { Config: 'config.json', RepoTags: [TAG], Layers: ['l0', 'l1', 'l2', 'l3', 'l4'] },
    ]);
    expect(t.read('config.json').toString()).toBe(CONFIG_JSON);
    // gzipped on the host (Task 1 ruling), so the target's store and any
    // registry it pushes to keep the app layers compressed.
    expect(t.read('l3').subarray(0, 2).toString('hex')).toBe('1f8b');
    expect(gunzipSync(t.read('l4')).toString()).toBe('app-dist');
    expect(t.read('fill.txt').toString()).toBe(
      BASE_DIFF_IDS.map((d, i) => `${i} ${d} ${ID_BASE}\n`).join(''),
    );
    expect(ssh.sent[0].cmd).toMatch(/^sh -c '/);
    expect(ssh.sent[0].cmd).toContain(` layer-delta 'docker' '${TAG}' '${TAG}' ''`);
  });

  it('k3s: names the imported image as ctr will and passes the registry ref for the push', async () => {
    const ssh = stubSsh();
    const ref = '10.0.1.1:5000/app:abc123-20261021000000';
    await deliverImage({
      ...args,
      tag: ref,
      runtime: 'k3s',
      registryRef: ref,
      deps: {
        run: async () => '',
        send: ssh.send,
        saveImage: saveFixture,
        acquireLock: noLock,
      },
    });
    expect(ssh.sent[0].cmd).toContain(` layer-delta 'k3s' '${ref}' '${ref}' '${ref}'`);
  });

  it('maps a failed remote load to one line and never retries', async () => {
    const ssh = stubSsh({ exit: 1, stderr: 'no space left on device\nmore' });
    await expect(
      deliverImage({
        ...args,
        deps: { run: listBase, send: ssh.send, saveImage: saveFixture, acquireLock: noLock },
      }),
    ).rejects.toThrow(/^image delivery failed: no space left on device$/);
    expect(ssh.calls).toBe(1);
  });

  it('a target that fails without reading the stream still settles (the host tar is not left blocked)', async () => {
    // Bigger than any pipe buffer, so tar is still writing when the send ends.
    const big = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i);
    const saveBig = async (_tag: string, dir: string) => {
      writeFixture(dir);
      writeFileSync(join(dir, APP_LAYER_BLOBS[1]), big);
    };
    const send = async () => ({ code: 1, stderr: 'no space left on device' });
    await expect(
      deliverImage({
        ...args,
        deps: { run: listBase, send, saveImage: saveBig, acquireLock: noLock },
      }),
    ).rejects.toThrow('image delivery failed: no space left on device');
  });

  it('skips the ssh host-key notice when it picks the first stderr line', async () => {
    const ssh = stubSsh({
      exit: 1,
      stderr:
        "Warning: Permanently added '203.0.113.7' (ED25519) to the list of known hosts.\ndocker: not found\n",
    });
    await expect(
      deliverImage({
        ...args,
        deps: { run: listBase, send: ssh.send, saveImage: saveFixture, acquireLock: noLock },
      }),
    ).rejects.toThrow(/^image delivery failed: docker: not found$/);
  });

  it('a failed listing is an image delivery failure too, and nothing is sent', async () => {
    const ssh = stubSsh();
    await expect(
      deliverImage({
        ...args,
        deps: {
          run: async () => {
            throw new Error('ssh: connect to host 203.0.113.7 port 22: Connection refused');
          },
          send: ssh.send,
          saveImage: saveFixture,
          acquireLock: noLock,
        },
      }),
    ).rejects.toThrow(
      'image delivery failed: ssh: connect to host 203.0.113.7 port 22: Connection refused',
    );
    expect(ssh.calls).toBe(0);
  });

  it('waits for the base pull before listing diffIDs', async () => {
    const order: string[] = [];
    let resolvePull!: () => void;
    const basePull = new Promise<void>((r) => {
      resolvePull = () => {
        order.push('pull:done');
        r();
      };
    });
    const ssh = stubSsh();
    const p = deliverImage({
      ...args,
      basePull,
      deps: {
        run: async () => {
          order.push('list');
          return listBase();
        },
        send: ssh.send,
        saveImage: async (_tag: string, dir: string) => {
          order.push('save');
          writeFixture(dir);
        },
        acquireLock: noLock,
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['save']);
    resolvePull();
    const r = await p;
    expect(order).toEqual(['save', 'pull:done', 'list']);
    expect(r.layersReused).toBe(3);
  });

  it('a failed base pull fails the delivery with its cause instead of silently sending the base', async () => {
    const ssh = stubSsh();
    const basePull = Promise.reject(new Error('unauthorized'));
    basePull.catch(() => {});
    await expect(
      deliverImage({
        ...args,
        basePull,
        deps: { run: listBase, send: ssh.send, saveImage: saveFixture, acquireLock: noLock },
      }),
    ).rejects.toThrow('image delivery failed: base image pull failed: unauthorized');
    expect(ssh.calls).toBe(0);
  });

  it('holds the uplink lock for the send only', async () => {
    const order: string[] = [];
    const ssh = stubSsh();
    await deliverImage({
      ...args,
      deps: {
        run: async () => {
          order.push('list');
          return listBase();
        },
        send: async (cmd: string, stdin: Readable) => {
          order.push('send');
          return ssh.send(cmd, stdin);
        },
        saveImage: saveFixture,
        acquireLock: async (opts: { label: string }) => {
          order.push(`lock:${opts.label}`);
          return () => order.push('unlock');
        },
      },
    });
    expect(order).toEqual(['list', `lock:delta tag=${TAG}`, 'send', 'unlock']);
  });

  it('releases the uplink lock when the send fails', async () => {
    const order: string[] = [];
    const ssh = stubSsh({ exit: 255, stderr: 'Connection reset' });
    await expect(
      deliverImage({
        ...args,
        deps: {
          run: listBase,
          send: ssh.send,
          saveImage: saveFixture,
          acquireLock: async () => {
            order.push('lock');
            return () => order.push('unlock');
          },
        },
      }),
    ).rejects.toThrow('image delivery failed: Connection reset');
    expect(order).toEqual(['lock', 'unlock']);
  });

  it('refuses a registry ref for a docker target (only k3s pushes into a registry)', async () => {
    await expect(
      deliverImage({ ...args, registryRef: 'x:5000/app:1', deps: { saveImage: saveFixture } }),
    ).rejects.toThrow(/registryRef/);
  });
});
