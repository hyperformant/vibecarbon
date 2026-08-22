/**
 * Every pod that talks to S3 needs an egress allowance — on both paths.
 *
 * The namespace is default-deny-egress (allow-dns + allow-intra-namespace-egress
 * select every pod with an Egress type), so a pod without an explicit S3
 * allowance simply cannot reach object storage.
 *
 * The storage service had NO allowance at all, on any provider, for as long as
 * the k8s tier has existed. It went unnoticed because storage was ALSO shipped
 * with no S3 credentials and no endpoint (5b2e8dfa), so it never attempted a
 * connection that could be dropped — and the e2e storage checks skipped on a
 * bucket nothing created, so nothing ever tried an upload. Two independent
 * faults stacked behind one skip. Live DO k8s, 2026-08-21: the first upload
 * attempt failed on credentials, the very next failed here with
 * `connect ECONNREFUSED 10.10.15.254:443` — the VPC gateway address
 * s3-egress-vpc.yaml's own header documents.
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
  it('the storage pod has a public-S3 egress allowance', () => {
    expect(s3EgressTargets('base/network-policies.yaml')).toContain('supabase-storage');
  });

  it('the storage pod has the DO VPC-gateway allowance too', () => {
    // Without this arm, DO storage fails with ECONNREFUSED against the VPC
    // gateway even once credentials are correct — exactly what happened live.
    expect(s3EgressTargets('base/s3-egress-vpc/s3-egress-vpc.yaml')).toContain('supabase-storage');
  });

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
    // Regression floor: this pre-dated the storage work and must not be
    // disturbed by it.
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
    expect(cidrs.length).toBeGreaterThanOrEqual(4);
    for (const c of cidrs) expect(c).toBe('__VPC_CIDR__');
  });
});
