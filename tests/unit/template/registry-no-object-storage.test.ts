import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The in-cluster registry must have NO object-storage dependency.
 *
 * ROOT FIX (2026-08-30, run 33332292268): both hetzner k8s deploys died with
 * `docker push` → 500 while the registry answered /v2/ with 200 — its S3
 * backend hit Hetzner Object Storage's stale-frontend weather
 * ("s3aws: NoSuchBucket" completing an upload against a bucket in active
 * use). The registry is a TRANSPORT CACHE, not a durability surface: every
 * deploy (including each k8s-ha cluster, and every restore re-deploy)
 * builds and pushes its own image; nodes pull through the registry service
 * regardless of backend; nothing ever reads yesterday's layers back out of
 * S3. Sitting that cache on the one backend with documented read-after-write
 * weather bought nothing and coupled every k8s deploy to it.
 *
 * Per the standing rule (memory: no-retry-ladders-root-fix-first — Brandon,
 * 2026-08-30): the fix for weather on a removable dependency is REMOVING THE
 * DEPENDENCY, not another retry ladder. The registry runs on the master's
 * local disk (hostPath — the pod is already pinned to master for hostPort
 * placement), which also strips bucket-wide S3 credentials and the public
 * egress allowance from the pod.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf-8');

describe('the in-cluster registry has no object-storage dependency', () => {
  const manifest = read('carbon/k8s/base/registry/local-registry.yaml');

  it('no S3 storage driver, env, or credentials anywhere in the manifest', () => {
    expect(manifest).not.toMatch(/REGISTRY_STORAGE_S3/);
    expect(manifest).not.toMatch(/value:\s*s3\b/);
    // No secretKeyRef at all — the pod needs no credentials of any kind.
    expect(manifest).not.toMatch(/secretKeyRef/);
  });

  it('image layers persist on the master node disk (hostPath), not emptyDir', () => {
    // emptyDir loses the cache on every pod restart; hostPath survives it.
    // The Deployment is already pinned to the master (nodeSelector for
    // hostPort placement), so the volume rides the same pin.
    expect(manifest).toMatch(/hostPath:/);
    expect(manifest).toMatch(/DirectoryOrCreate/);
    // Config shape, not prose — the history comment may name emptyDir.
    expect(manifest).not.toMatch(/emptyDir\s*:/);
  });

  it('the NetworkPolicy grants the registry no public egress', () => {
    // Filesystem backend = no outbound calls at all. The old S3 arm allowed
    // 443 to 0.0.0.0/0 from a pod holding bucket-wide credentials.
    expect(manifest).not.toMatch(/cidr:\s*0\.0\.0\.0\/0/);
  });

  it('the VPC S3-egress overlay carries no arm for the registry', () => {
    // Selector shape, not prose — the tombstone comment may name the file.
    const vpc = read('carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml');
    expect(vpc).not.toMatch(/app:\s*local-registry/);
  });
});
