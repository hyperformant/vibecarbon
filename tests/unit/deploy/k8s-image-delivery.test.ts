import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_ACCEPT,
  MANIFEST_DIGEST_SH,
  parseLocalRegistryRef,
  planImageDelivery,
  registryImageTag,
  standbyImageRef,
} from '../../../src/lib/deploy/k8s/image-delivery.js';

describe('image-delivery helpers', () => {
  it('parses a local-registry ref', () => {
    expect(parseLocalRegistryRef('10.0.1.1:5000/quorum:abc123-20261020T120000Z')).toEqual({
      host: '10.0.1.1:5000',
      repo: 'quorum',
      tag: 'abc123-20261020T120000Z',
      repoTag: 'quorum:abc123-20261020T120000Z',
    });
  });
  it('refuses a non-local ref and a tagless one', () => {
    expect(() => parseLocalRegistryRef('ghcr.io/o/r:main')).toThrow(/not a local-registry ref/);
    expect(() => parseLocalRegistryRef('10.0.1.1:5000/quorum')).toThrow(/not a local-registry ref/);
  });
  it('refuses a digest ref instead of reading the digest as a tag', () => {
    expect(() => parseLocalRegistryRef(`10.0.1.1:5000/quorum@sha256:${'a'.repeat(64)}`)).toThrow(
      /not a local-registry ref/,
    );
  });
  it('refuses a long slash-run ref in linear time (no ReDoS)', () => {
    const ref = `!:5000/${'!/'.repeat(50_000)} `;
    const t = performance.now();
    expect(() => parseLocalRegistryRef(ref)).toThrow(/not a local-registry ref/);
    expect(performance.now() - t).toBeLessThan(250);
  });
  it('keeps a multi-segment repo whole', () => {
    expect(parseLocalRegistryRef('10.0.1.1:5000/team/quorum:t1').repo).toBe('team/quorum');
  });
  it('re-prefixes the primary ref for the standby registry', () => {
    expect(
      standbyImageRef({
        primaryRef: '10.110.0.2:5000/quorum:t1',
        standbyMasterPrivateIp: '10.120.0.3',
      }),
    ).toBe('10.120.0.3:5000/quorum:t1');
    expect(() =>
      standbyImageRef({ primaryRef: '10.0.1.1:5000/q:t', standbyMasterPrivateIp: '' }),
    ).toThrow(/standbyMasterPrivateIp is required/);
  });
  it('names a locally built image for the master registry (Hetzner static and DO VPC IPs)', () => {
    expect(registryImageTag('vibecarbon-local/quorum:abc-20261031', '10.0.1.1')).toBe(
      '10.0.1.1:5000/quorum:abc-20261031',
    );
    expect(registryImageTag('vibecarbon-local/quorum:abc-dirty-1', '10.110.0.2')).toBe(
      '10.110.0.2:5000/quorum:abc-dirty-1',
    );
    // The result is a ref the rest of the pipeline parses.
    expect(
      parseLocalRegistryRef(registryImageTag('vibecarbon-local/q:t', '10.0.1.1')).repoTag,
    ).toBe('q:t');
    expect(() => registryImageTag('vibecarbon-local/q:t', '')).toThrow(
      /masterPrivateIp is required/,
    );
    expect(() => registryImageTag('q:t', '10.0.1.1')).toThrow(/not a locally built image tag/);
  });
  it('plans delivery by role: one delivery for the operator, none for a standby', () => {
    const operator = { build: true, deliver: true, awaitPeerImage: false };
    expect(planImageDelivery({ role: 'standby' })).toEqual({
      build: false,
      deliver: false,
      awaitPeerImage: true,
    });
    expect(planImageDelivery({ role: 'primary' })).toEqual(operator);
    expect(planImageDelivery({})).toEqual(operator);
  });
  it('the digest helper sends the full Accept list and reads the header case-insensitively', () => {
    expect(MANIFEST_DIGEST_SH).toContain(MANIFEST_ACCEPT);
    expect(MANIFEST_DIGEST_SH).toMatch(/curl -fsSI/);
    expect(MANIFEST_DIGEST_SH).toContain('tolower($1)=="docker-content-digest"');
  });
});

describe('MANIFEST_DIGEST_SH runs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function runDigest(stubBody: string) {
    dir = mkdtempSync(join(tmpdir(), 'digest-stub-'));
    const curl = join(dir, 'curl');
    writeFileSync(curl, `#!/bin/sh\n${stubBody}\n`);
    chmodSync(curl, 0o755);
    return spawnSync('sh', ['-c', `${MANIFEST_DIGEST_SH}; digest h r t`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  }

  it('prints the Docker-Content-Digest value', () => {
    const r = runDigest(`printf 'HTTP/1.1 200 OK\\r\\ndocker-content-digest: sha256:aa\\r\\n'`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('sha256:aa\n');
  });
  it('prints nothing and exits 0 on a 404', () => {
    const r = runDigest('exit 22');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

/**
 * Ruling R8 (cold-deploy-speed Task 5): the primary's registry is now filled by
 * `ctr images push` (layer-delta-remote.sh, after deliverImage's import and
 * diffID check), not by `docker push`. Task 1 recorded what that writes
 * against registry:2.8.3 (task-1-report.md; tests/integration/docker/
 * layer-delta-roundtrip.test.ts runs it for real): ONE docker v2 manifest
 * (no index), a docker v1 config, a gzip base layer and gzip or uncompressed
 * app layers, blobs pushed as stored. The two readers of that registry are the
 * apply gate's probe (primaryRegistryHasImage) and the k8s-ha standby copy
 * (copyAppImageToStandby). Both are run here against a stub registry that
 * answers a manifest HEAD the way registry:2 does: only when the request's
 * Accept list names the stored manifest's media type.
 */
describe('a ctr-pushed tag is what the apply-gate probe and the standby copy read (R8)', () => {
  const CTR_PUSHED = {
    manifest: 'application/vnd.docker.distribution.manifest.v2+json',
    digest: `sha256:${'5'.repeat(64)}`,
  };
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** A PATH with stub `curl` (the registry) and `k3s` (ctr pull / push). */
  function stubRegistry(seed: Record<string, { manifest: string; digest: string }>) {
    dir = mkdtempSync(join(tmpdir(), 'ctr-pushed-'));
    const store = join(dir, 'store');
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', store, bin]);
    const key = (ref: string) => ref.replace(/[:/]/g, '_');
    for (const [ref, m] of Object.entries(seed)) {
      writeFileSync(join(store, key(ref)), `${m.manifest} ${m.digest}\n`);
    }
    // curl -fsSI -H "Accept: a, b" http://host/v2/repo/manifests/tag, or
    // curl -fsS -o /dev/null http://host/v2/ (the copy's reachability check).
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh
accept=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -H) accept=\${2#Accept: }; shift 2 ;;
    -o) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
rest=\${url#http://}; host=\${rest%%/*}; path=\${rest#*/}
case "$path" in v2/) exit 0 ;; esac
repo=\${path#v2/}; repo=\${repo%/manifests/*}; tag=\${path##*/}
f="${store}/$(printf '%s' "$host/$repo:$tag" | tr ':/' '__')"
[ -f "$f" ] || exit 22
read -r mt dg < "$f"
case ", $accept," in *", $mt,"*) ;; *) exit 22 ;; esac
printf 'HTTP/1.1 200 OK\\r\\nContent-Type: %s\\r\\nDocker-Content-Digest: %s\\r\\n\\r\\n' "$mt" "$dg"
`,
    );
    // k3s ctr -n <ns> images pull|push|rm ...: a push stores the source's
    // manifest unchanged under the destination (ctr pushes blobs as stored).
    writeFileSync(
      join(bin, 'k3s'),
      `#!/bin/sh
shift 3
case "$2" in
  pull) for a; do last=$a; done
        [ -f "${store}/$(printf '%s' "$last" | tr ':/' '__')" ] || { echo "ctr: not found" >&2; exit 1; } ;;
  push) cp "${store}/$(printf '%s' "$5" | tr ':/' '__')" "${store}/$(printf '%s' "$4" | tr ':/' '__')" ;;
esac
exit 0
`,
    );
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'k3s'), 0o755);
    return async (script: string) => {
      const r = spawnSync('sh', ['-s'], {
        input: script,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      if (r.status !== 0) throw Object.assign(new Error('script failed'), r);
      return r.stdout;
    };
  }

  it('the apply-gate probe finds the tag, and only by the media type ctr wrote', async () => {
    const { primaryRegistryHasImage } = await import('../../../src/lib/deploy/k8s/k3s.js');
    const args = { masterIp: 'm', sshKeyPath: '/k', imageTag: '10.0.1.1:5000/quorum:t1' };
    let run = stubRegistry({ '10.0.1.1:5000/quorum:t1': CTR_PUSHED });
    await expect(primaryRegistryHasImage({ ...args, run })).resolves.toBe(true);
    // Controls: the stub honours Accept and absence, so the pass above is real.
    run = stubRegistry({
      '10.0.1.1:5000/quorum:t1': {
        manifest: 'application/vnd.docker.distribution.manifest.v1+prettyjws',
        digest: CTR_PUSHED.digest,
      },
    });
    await expect(primaryRegistryHasImage({ ...args, run })).resolves.toBe(false);
    run = stubRegistry({});
    await expect(primaryRegistryHasImage({ ...args, run })).resolves.toBe(false);
  });

  it('the standby copy reads it through the relay and lands the same digest', async () => {
    const { copyAppImageToStandby } = await import('../../../src/lib/deploy/k8s/ha/image-copy.js');
    const { REGISTRY_RELAY_SOURCE_HOST } = await import('../../../src/lib/deploy/k8s/ha/index.js');
    const run = stubRegistry({ [`${REGISTRY_RELAY_SOURCE_HOST}/quorum:t1`]: CTR_PUSHED });
    await expect(
      copyAppImageToStandby({
        primaryRef: '10.0.1.1:5000/quorum:t1',
        primaryIp: 'P',
        standbyIp: 'S',
        primaryMasterPrivateIp: '10.0.1.1',
        standbyMasterPrivateIp: '10.120.0.3',
        standbyDbIp: 'SDB',
        sshKeyPath: '/k',
        run,
        relay: async (_a: unknown, fn: () => Promise<string>) => fn(),
      }),
    ).resolves.toEqual({ digest: CTR_PUSHED.digest, skipped: false });
  });
});
