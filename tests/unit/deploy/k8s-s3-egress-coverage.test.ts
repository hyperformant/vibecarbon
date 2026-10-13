/**
 * Every pod that talks to S3 needs an egress allowance — on both paths.
 *
 * The namespace is default-deny-egress (allow-dns + allow-intra-namespace-egress
 * select every pod with an Egress type), so a pod without an explicit S3
 * allowance simply cannot reach object storage.
 *
 * History: the (since removed) Supabase storage service shipped with NO
 * allowance at all, on any provider. Live DO k8s, 2026-08-21: its first upload
 * failed with `connect ECONNREFUSED 10.10.15.254:443`, the VPC gateway address
 * s3-egress-vpc.yaml's own header documents. Pods that talk to S3 today: the
 * app and the db (wal-g).
 *
 * TWO paths, and a pod needs both:
 *   - network-policies.yaml — public S3, private ranges excluded. All providers.
 *   - s3-egress-vpc/s3-egress-vpc.yaml — the VPC-gateway allowance, applied
 *     only where getS3EgressExtraCidrs() is non-empty (DigitalOcean), because
 *     DO resolves same-region Spaces endpoints to a VPC-internal address that
 *     the private-range exclusion above cuts off.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const load = (rel: string) => {
  const out: Record<string, never>[] = [];
  loadAll(
    readFileSync(fileURLToPath(new URL(`../../../carbon/k8s/${rel}`, import.meta.url)), 'utf8'),
    (d) => {
      if (d) out.push(d as Record<string, never>);
    },
  );
  return out;
};

const policies = (rel: string) => load(rel).filter((d) => d.kind === 'NetworkPolicy');

/** podSelector labels of every policy that allows TCP 443 egress. */
const s3EgressTargets = (rel: string) =>
  policies(rel)
    .filter((p) =>
      (p.spec?.egress ?? []).some((e: { ports?: { port?: number }[] }) =>
        (e.ports ?? []).some((port) => port.port === 443),
      ),
    )
    .map((p) => p.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name'])
    .filter(Boolean);

describe('k8s S3 egress coverage', () => {
  it('every VPC arm has a public-S3 sibling — the file says each mirrors one', () => {
    // A VPC arm without its sibling would allow the gateway but still deny
    // public S3 on providers that resolve publicly (Hetzner et al).
    const vpc = s3EgressTargets('base/s3-egress-vpc/s3-egress-vpc.yaml');
    const pub = [
      ...s3EgressTargets('base/network-policies.yaml'),
      ...s3EgressTargets('base/app/network-policy.yaml'),
      ...s3EgressTargets('base/registry/local-registry.yaml'),
    ];
    for (const t of vpc) {
      expect(pub, `${t} has a VPC arm but no public-S3 sibling`).toContain(t);
    }
  });

  it('the db keeps its own allowance — wal-g depends on it', () => {
    // Regression floor: wal-g backups and restores need both arms.
    expect(s3EgressTargets('base/network-policies.yaml')).toContain('supabase-db');
    expect(s3EgressTargets('base/s3-egress-vpc/s3-egress-vpc.yaml')).toContain('supabase-db');
  });

  it('the VPC file still renders its placeholder, never a literal CIDR', () => {
    const raw = readFileSync(
      fileURLToPath(
        new URL('../../../carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml', import.meta.url),
      ),
      'utf8',
    );
    const cidrs = [...raw.matchAll(/cidr: (\S+)/g)].map((m) => m[1]);
    // 2 arms: the registry left the S3-egress family when its backend moved
    // to the master's filesystem (registry-no-object-storage.test.ts, 2026-08-30)
    // and the storage service left with the service itself — app and db remain.
    expect(cidrs.length).toBeGreaterThanOrEqual(2);
    for (const c of cidrs) expect(c).toBe('__VPC_CIDR__');
  });
});
