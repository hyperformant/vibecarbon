/**
 * The target half of the layer delta (src/lib/deploy/layer-delta-remote.sh),
 * run under real shells with a stub `docker` / `ctr` on PATH: the stubs record
 * every call and keep what they were asked to load, so these tests read what
 * the script really did. Prod runs it as `sh -c '<script>' layer-delta ...`
 * over ssh, with the delta tar on stdin; so do these tests (bash and the
 * system sh, which is dash here and busybox ash on a k3s image).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_SCRIPT } from '../../../src/lib/deploy/layer-delta.js';
import { TARGET_PLATFORM } from '../../../src/lib/deploy/platform.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const BODIES = ['base-0', 'base-1', 'base-2', 'app-3', 'app-4'];
const DIFF_IDS = BODIES.map((b) => `sha256:${sha(b)}`);
const CONFIG = JSON.stringify({
  architecture: 'amd64',
  rootfs: { type: 'layers', diff_ids: DIFF_IDS },
});
const TAG = 'vibecarbon-local/app:abc-1';
const SRC_ID = `sha256:${sha('base-image')}`;

let root: string;
let stub: string;
let deltaRoot: string;

const tarOf = (dir: string, members: string[]) =>
  execFileSync('tar', ['-cf', '-', '-C', dir, ...members], { maxBuffer: 64 * 1024 * 1024 });

/** The delta the host sends: manifest, config, the app layers, the fill list. */
function deltaTar({ fill }: { fill: string } = { fill: '' }) {
  const d = mkdtempSync(join(root, 'delta-'));
  writeFileSync(
    join(d, 'manifest.json'),
    JSON.stringify([
      { Config: 'config.json', RepoTags: [TAG], Layers: BODIES.map((_, i) => `l${i}`) },
    ]),
  );
  writeFileSync(join(d, 'config.json'), CONFIG);
  writeFileSync(join(d, 'l3'), gzipSync(BODIES[3]));
  writeFileSync(join(d, 'l4'), gzipSync(BODIES[4]));
  writeFileSync(join(d, 'fill.txt'), fill);
  return tarOf(d, ['manifest.json', 'config.json', 'fill.txt', 'l3', 'l4']);
}

const dockerFill = BODIES.slice(0, 3)
  .map((_, i) => `${i} ${DIFF_IDS[i]} ${SRC_ID}\n`)
  .join('');

/**
 * What the target's own `docker save` of the base writes on the containerd
 * store: gzip layers named by their COMPRESSED digest, so only the manifest's
 * Layers[i] <-> config diff_ids[i] pairing finds them (task-1 fact 2). The
 * JSON is pretty-printed on purpose: the script must not depend on layout.
 */
function writeSourceSave() {
  const s = join(stub, 'srcsave');
  mkdirSync(join(s, 'blobs/sha256'), { recursive: true });
  const layers = BODIES.slice(0, 3).map((b) => {
    const gz = gzipSync(`${b}`);
    const p = `blobs/sha256/${sha(gz)}`;
    writeFileSync(join(s, p), gz);
    return p;
  });
  const cfg = JSON.stringify(
    { architecture: 'amd64', rootfs: { type: 'layers', diff_ids: DIFF_IDS.slice(0, 3) } },
    null,
    2,
  );
  const cfgPath = `blobs/sha256/${sha(cfg)}`;
  writeFileSync(join(s, cfgPath), cfg);
  writeFileSync(
    join(s, 'manifest.json'),
    JSON.stringify([{ Config: cfgPath, RepoTags: null, Layers: layers }], null, 2),
  );
  writeFileSync(join(s, 'index.json'), '{}');
  return layers;
}

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB/calls"
case "$1 $2" in
  "save --platform")
    [ "$4" = "$STUB_SRC_ID" ] || { echo "Error: No such image: $4" >&2; exit 1; }
    cd "$STUB/srcsave" && exec tar -cf - . ;;
  "load "*|"load")
    cat > "$STUB/loaded.tar"
    if [ -n "\${STUB_LOAD_FAIL:-}" ]; then echo "$STUB_LOAD_FAIL" >&2; echo "second line" >&2; exit 1; fi
    echo "$STUB_TAG" >> "$STUB/tags"
    echo "Loaded image: $STUB_TAG"; exit 0 ;;
  "image inspect")
    cat "$STUB/inspect"; exit 0 ;;
  "image rm")
    grep -vxF "$3" "$STUB/tags" > "$STUB/tags.new" || true; mv "$STUB/tags.new" "$STUB/tags"; exit 0 ;;
esac
echo "stub docker: unexpected $*" >&2; exit 2
`;

/** k3s's ctr: content get serves blobs by digest, import stores the archive. */
const CTR_STUB = `#!/bin/sh
echo "ctr $*" >> "$STUB/calls"
[ "$1" = "-n" ] && [ "$2" = "k8s.io" ] || { echo "stub ctr: namespace" >&2; exit 2; }
shift 2
case "$1 $2" in
  "content get")
    f="$STUB/content/\${3#sha256:}"
    [ -f "$f" ] || { echo "ctr: content digest $3: not found" >&2; exit 1; }
    exec cat "$f" ;;
  "images import")
    cat > "$STUB/loaded.tar"
    if [ -n "\${STUB_LOAD_FAIL:-}" ]; then echo "$STUB_LOAD_FAIL" >&2; exit 1; fi
    echo "$STUB_REF" >> "$STUB/tags"
    echo "unpacking $STUB_REF (sha256:feed)...done"; exit 0 ;;
  "images ls")
    echo "REF TYPE DIGEST SIZE PLATFORMS LABELS"
    echo "$STUB_REF application/vnd.docker.distribution.manifest.v2+json sha256:$(cat "$STUB/manifest-digest") 5.0 MiB linux/amd64 -"
    exit 0 ;;
  "images rm")
    grep -vxF "$3" "$STUB/tags" > "$STUB/tags.new" || true; mv "$STUB/tags.new" "$STUB/tags"; exit 0 ;;
  "images tag"|"images push")
    exit 0 ;;
esac
echo "stub ctr: unexpected $*" >&2; exit 2
`;

function writeStub(name: string, body: string) {
  writeFileSync(join(stub, name), body);
  chmodSync(join(stub, name), 0o755);
}

/** The image the stub store "holds" after a load: inspect / content answers. */
function storeLoaded({ diffIds = DIFF_IDS }: { diffIds?: string[] } = {}) {
  writeFileSync(join(stub, 'inspect'), `${diffIds.map((d) => `${d} `).join('')}\n`);
  const cfg = JSON.stringify({ rootfs: { type: 'layers', diff_ids: diffIds } });
  const cfgHex = sha(cfg);
  const manifest = JSON.stringify(
    {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: {
        mediaType: 'application/vnd.docker.container.image.v1+json',
        size: cfg.length,
        digest: `sha256:${cfgHex}`,
      },
      layers: [{ mediaType: 'x', size: 1, digest: 'sha256:00' }],
    },
    null,
    3,
  );
  mkdirSync(join(stub, 'content'), { recursive: true });
  writeFileSync(join(stub, 'content', cfgHex), cfg);
  writeFileSync(join(stub, 'content', sha(manifest)), manifest);
  writeFileSync(join(stub, 'manifest-digest'), sha(manifest));
}

const SHELLS = ['bash', 'sh'];

/** args: runtime, tag, ref, registry-ref; the platform goes in after runtime. */
function runScript(
  shell: string,
  args: string[],
  input: Buffer,
  env: Record<string, string> = {},
  platform = TARGET_PLATFORM,
) {
  const [runtime, ...rest] = args;
  const r = spawnSync(shell, ['-c', REMOTE_SCRIPT, 'layer-delta', runtime, platform, ...rest], {
    input,
    encoding: 'buffer',
    env: {
      PATH: `${stub}:${process.env.PATH}`,
      STUB: stub,
      STUB_SRC_ID: SRC_ID,
      STUB_TAG: TAG,
      VC_DELTA_ROOT: deltaRoot,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const tags = () =>
  existsSync(join(stub, 'tags'))
    ? readFileSync(join(stub, 'tags'), 'utf-8').split('\n').filter(Boolean)
    : [];
const calls = () =>
  existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf-8') : '';
const loaded = () => {
  const out = mkdtempSync(join(root, 'loaded-'));
  execFileSync('tar', ['-xf', join(stub, 'loaded.tar'), '-C', out]);
  return {
    members: readdirSync(out).sort(),
    read: (m: string) => readFileSync(join(out, m)),
  };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vc-layer-delta-remote-'));
  stub = join(root, 'stub');
  deltaRoot = join(root, 'delta-root');
  mkdirSync(stub);
  writeStub('docker', DOCKER_STUB);
  writeStub('ctr', CTR_STUB);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(SHELLS)('layer-delta-remote.sh under %s', (shell) => {
  describe('docker target', () => {
    it("fills the held layers from the target's own save and loads a complete archive", () => {
      const srcLayers = writeSourceSave();
      storeLoaded();
      const r = runScript(shell, ['docker', TAG, TAG, ''], deltaTar({ fill: dockerFill }));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const l = loaded();
      expect(l.members).toEqual(['config.json', 'l0', 'l1', 'l2', 'l3', 'l4', 'manifest.json']);
      srcLayers.forEach((p, i) => {
        expect(l.read(`l${i}`)).toEqual(readFileSync(join(stub, 'srcsave', p)));
      });
      expect(l.read('config.json').toString()).toBe(CONFIG);
      // One save per source image, pinned to the platform deploys run.
      expect(calls().match(/docker save/g)).toHaveLength(1);
      expect(calls()).toContain(`docker save --platform linux/amd64 ${SRC_ID}`);
      expect(tags()).toEqual([TAG]);
      expect(readdirSync(deltaRoot)).toEqual([]);
    });

    it('saves the source image for the platform the host passes, not a literal', () => {
      writeSourceSave();
      storeLoaded();
      const r = runScript(
        shell,
        ['docker', TAG, TAG, ''],
        deltaTar({ fill: dockerFill }),
        {},
        'linux/arm64',
      );
      expect(r.status).toBe(0);
      expect(calls()).toContain(`docker save --platform linux/arm64 ${SRC_ID}`);
    });

    it('sweeps work dirs an hour old that a killed host left behind, and only those', () => {
      mkdirSync(join(deltaRoot, 'd.stale'), { recursive: true });
      mkdirSync(join(deltaRoot, 'd.fresh'));
      mkdirSync(join(deltaRoot, 'other'));
      writeFileSync(join(deltaRoot, 'd.stale', 'l0'), 'x');
      const old = new Date(Date.now() - 2 * 3600_000);
      for (const p of ['d.stale/l0', 'd.stale', 'other']) utimesSync(join(deltaRoot, p), old, old);
      writeSourceSave();
      storeLoaded();
      const r = runScript(shell, ['docker', TAG, TAG, ''], deltaTar({ fill: dockerFill }));
      expect(r.status).toBe(0);
      expect(readdirSync(deltaRoot).sort()).toEqual(['d.fresh', 'other']);
    });

    it('loads a full delta (nothing held) without saving anything', () => {
      storeLoaded();
      const d = mkdtempSync(join(root, 'full-'));
      writeFileSync(
        join(d, 'manifest.json'),
        JSON.stringify([
          { Config: 'config.json', RepoTags: [TAG], Layers: BODIES.map((_, i) => `l${i}`) },
        ]),
      );
      writeFileSync(join(d, 'config.json'), CONFIG);
      for (const [i, b] of BODIES.entries()) writeFileSync(join(d, `l${i}`), gzipSync(b));
      writeFileSync(join(d, 'fill.txt'), '');
      const input = tarOf(d, [
        'manifest.json',
        'config.json',
        'fill.txt',
        ...BODIES.map((_, i) => `l${i}`),
      ]);
      const r = runScript(shell, ['docker', TAG, TAG, ''], input);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(calls()).not.toContain('docker save');
    });

    it('a failed load leaves no dir under the delta root and no tag, and its error is the first stderr line', () => {
      writeSourceSave();
      storeLoaded();
      const r = runScript(shell, ['docker', TAG, TAG, ''], deltaTar({ fill: dockerFill }), {
        STUB_LOAD_FAIL: 'write /var/lib/docker/tmp/x: no space left on device',
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr.split('\n')[0]).toBe('write /var/lib/docker/tmp/x: no space left on device');
      expect(readdirSync(deltaRoot)).toEqual([]);
      expect(calls()).not.toMatch(/docker (tag|push|image inspect)/);
    });

    it('a stream cut mid-transfer (killed ssh) loads nothing and leaves no dir behind', () => {
      writeSourceSave();
      storeLoaded();
      const full = deltaTar({ fill: dockerFill });
      const r = runScript(shell, ['docker', TAG, TAG, ''], full.subarray(0, 700));
      expect(r.status).not.toBe(0);
      expect(calls()).not.toContain('docker load');
      expect(readdirSync(deltaRoot)).toEqual([]);
    });

    it('refuses when the named source image does not hold a layer it was asked for', () => {
      writeSourceSave();
      storeLoaded();
      const bogus = `${dockerFill}3 sha256:${sha('nope')} ${SRC_ID}\n`;
      const r = runScript(shell, ['docker', TAG, TAG, ''], deltaTar({ fill: bogus }));
      expect(r.status).not.toBe(0);
      expect(r.stderr.split('\n')[0]).toContain(`does not hold layer sha256:${sha('nope')}`);
      expect(calls()).not.toContain('docker load');
      expect(readdirSync(deltaRoot)).toEqual([]);
    });

    it('removes the tag and exits non-zero when the loaded layers differ from the manifest', () => {
      writeSourceSave();
      storeLoaded({ diffIds: [...DIFF_IDS.slice(0, 4), `sha256:${sha('other')}`] });
      const r = runScript(shell, ['docker', TAG, TAG, ''], deltaTar({ fill: dockerFill }));
      expect(r.status).not.toBe(0);
      expect(r.stderr.split('\n')[0]).toContain('do not match');
      expect(calls()).toContain(`docker image rm ${TAG}`);
      expect(tags()).not.toContain(TAG);
      expect(readdirSync(deltaRoot)).toEqual([]);
    });
  });

  describe('k3s target', () => {
    const REF = '10.0.1.1:5000/app:abc-1';
    const gzDigest = (i: number) => `sha256:${sha(gzipSync(BODIES[i]))}`;
    const k3sFill = [0, 1, 2].map((i) => `${i} ${DIFF_IDS[i]} ${gzDigest(i)}\n`).join('');
    const env = { VC_CTR: '', STUB_REF: REF };

    function holdBlobs() {
      mkdirSync(join(stub, 'content'), { recursive: true });
      for (const i of [0, 1, 2]) {
        writeFileSync(join(stub, 'content', gzDigest(i).slice(7)), gzipSync(BODIES[i]));
      }
    }

    it('fills from the content store, imports, verifies and pushes to the in-cluster registry', () => {
      holdBlobs();
      storeLoaded();
      const r = runScript(shell, ['k3s', REF, REF, REF], deltaTar({ fill: k3sFill }), {
        ...env,
        VC_CTR: join(stub, 'ctr'),
      });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const l = loaded();
      expect(l.members).toEqual(['config.json', 'l0', 'l1', 'l2', 'l3', 'l4', 'manifest.json']);
      expect(l.read('l1')).toEqual(gzipSync(BODIES[1]));
      expect(calls()).toContain('ctr -n k8s.io images import -');
      expect(calls()).toContain(`ctr -n k8s.io images push --plain-http ${REF} ${REF}`);
      expect(calls()).not.toContain('images tag');
      expect(readdirSync(deltaRoot)).toEqual([]);
    });

    it('tags the imported image under the registry ref when the two differ', () => {
      holdBlobs();
      storeLoaded();
      const imported = 'docker.io/vibecarbon-local/app:abc-1';
      const r = runScript(
        shell,
        ['k3s', 'vibecarbon-local/app:abc-1', imported, REF],
        deltaTar({ fill: k3sFill }),
        {
          ...env,
          STUB_REF: imported,
          VC_CTR: join(stub, 'ctr'),
        },
      );
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(calls()).toContain(`ctr -n k8s.io images tag --force ${imported} ${REF}`);
      expect(calls()).toContain(`ctr -n k8s.io images push --plain-http ${REF} ${REF}`);
    });

    it('a failed import leaves no dir and pushes nothing', () => {
      holdBlobs();
      storeLoaded();
      const r = runScript(shell, ['k3s', REF, REF, REF], deltaTar({ fill: k3sFill }), {
        ...env,
        VC_CTR: join(stub, 'ctr'),
        STUB_LOAD_FAIL: 'ctr: failed to extract layer: no space left on device',
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr.split('\n')[0]).toBe('ctr: failed to extract layer: no space left on device');
      expect(calls()).not.toContain('images push');
      expect(readdirSync(deltaRoot)).toEqual([]);
    });

    it('a missing blob stops before the import', () => {
      storeLoaded();
      const r = runScript(shell, ['k3s', REF, REF, REF], deltaTar({ fill: k3sFill }), {
        ...env,
        VC_CTR: join(stub, 'ctr'),
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr.split('\n')[0]).toContain('not found');
      expect(calls()).not.toContain('images import');
      expect(readdirSync(deltaRoot)).toEqual([]);
    });

    it('removes the image and pushes nothing when the imported layers differ from the manifest', () => {
      holdBlobs();
      storeLoaded({ diffIds: DIFF_IDS.slice(0, 4) });
      const r = runScript(shell, ['k3s', REF, REF, REF], deltaTar({ fill: k3sFill }), {
        ...env,
        VC_CTR: join(stub, 'ctr'),
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr.split('\n')[0]).toContain('do not match');
      expect(calls()).toContain(`ctr -n k8s.io images rm ${REF}`);
      expect(tags()).not.toContain(REF);
      expect(calls()).not.toContain('images push');
    });
  });
});

describe('layer-delta-remote.sh text', () => {
  it('never prints an environment value, on success or failure (its stderr becomes the deploy error line)', () => {
    const secret = 'vc-secret-probe-7f3a9c';
    const env = { HCLOUD_TOKEN: secret, VC_SECRET_PROBE: secret, AWS_SECRET_ACCESS_KEY: secret };
    for (const shell of SHELLS) {
      for (const fail of ['', 'no space left on device']) {
        writeSourceSave();
        storeLoaded();
        const r = runScript(shell, ['docker', TAG, TAG, ''], deltaTar({ fill: dockerFill }), {
          ...env,
          ...(fail ? { STUB_LOAD_FAIL: fail } : {}),
        });
        expect(r.status).toBe(fail ? 1 : 0);
        expect(r.stdout + r.stderr).not.toContain(secret);
      }
    }
    expect(REMOTE_SCRIPT).not.toMatch(/^\s*set\s+-[a-z]*x/m);
  });

  it('works under /var/lib/vibecarbon/delta by default and removes its dir on every exit', () => {
    expect(REMOTE_SCRIPT).toContain('/var/lib/vibecarbon/delta');
    expect(REMOTE_SCRIPT).toContain(`trap 'rm -rf "$d"' EXIT`);
  });
});
