/**
 * M3 Task 9c: `renderS3EgressVpcManifest` (src/lib/deploy/k8s/k3s.js) is the
 * seam that resolves the `__VPC_CIDR__` placeholder
 * carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml ships instead of
 * hardcoding a provider's CIDR literal.
 *
 * Dedicated, direct test of the render function (mirrors
 * k3s-storage-class-render.test.ts's reasoning) — reads the REAL checked-in
 * template off disk (not hand-copied) so a future edit to the shipped
 * manifest can't silently drift out of sync with what this test pins.
 *
 * NetworkPolicy fields are mutable (unlike the PVC storageClassName
 * renderK8sStorageClassPlaceholder resolves pre-apply), so this manifest is
 * applied via plain `kubectl apply -f -`, not a pre-apply temp-dir kustomize
 * render — see applyK3sManifests's step 5a and this function's own doc.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderS3EgressVpcManifest } from '../../../src/lib/deploy/k8s/k3s.js';

const ROOT = join(__dirname, '../../..');
const REAL_TEMPLATE = join(ROOT, 'carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml');

function kustomizeBuild(path: string) {
  const result = spawnSync('kubectl', ['kustomize', path], { cwd: ROOT, encoding: 'utf-8' });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const POLICY_NAMES = ['app-s3-vpc-egress', 'registry-s3-vpc-egress', 'supabase-db-s3-vpc-egress'];

describe('renderS3EgressVpcManifest', () => {
  it('the real checked-in s3-egress-vpc.yaml ships the placeholder for all 4 policies, not a hardcoded literal', () => {
    // Sanity precondition — if this ever fails, the fixture drifted and the
    // rest of this suite would be testing nothing. Matches actual `cidr:`
    // lines specifically (not a bare `__VPC_CIDR__` substring count) — the
    // header comment also documents the token by name (same idiom as
    // repl-gateway.yaml's own placeholder-listing header), which is prose,
    // not a value this test needs to count.
    const raw = readFileSync(REAL_TEMPLATE, 'utf-8');
    for (const name of POLICY_NAMES) {
      expect(raw).toContain(`name: ${name}`);
    }
    // 4 since 2026-08-21: the storage pod gained its arm when the k8s
    // storage service was finally wired to S3 at all. It had no egress
    // allowance because it had never been able to make an S3 call.
    expect(raw.match(/cidr: __VPC_CIDR__/g)?.length).toBe(4);
    expect(raw).not.toMatch(/cidr: \d+\.\d+\.\d+\.\d+\/\d+/);
  });

  it('DigitalOcean: resolves every placeholder to the given CIDR, one ipBlock per policy', () => {
    const template = readFileSync(REAL_TEMPLATE, 'utf-8');
    const rendered = renderS3EgressVpcManifest(template, ['10.10.0.0/20']);

    expect(rendered).not.toContain('__VPC_CIDR__');
    const cidrMatches = rendered.match(/cidr: 10\.10\.0\.0\/20/g);
    expect(cidrMatches?.length).toBe(4);
    for (const name of POLICY_NAMES) {
      expect(rendered).toContain(`name: ${name}`);
    }
  });

  it('is pinned against whatever CIDR is passed — not hardcoded to DO’s default', () => {
    const template = readFileSync(REAL_TEMPLATE, 'utf-8');
    const rendered = renderS3EgressVpcManifest(template, ['10.20.0.0/16']);

    expect(rendered.match(/cidr: 10\.20\.0\.0\/16/g)?.length).toBe(4);
    // The header comment's RCA prose legitimately mentions the observed
    // rig's real value ('10.10.0.0/20') for documentation, independent of
    // whatever CIDR is actually rendered — so the precise check is that no
    // EGRESS RULE (a `cidr:` line) resolved to it here, not a bare
    // substring-anywhere check.
    expect(rendered).not.toMatch(/cidr: 10\.10\.0\.0\/20/);
  });

  it('throws on an empty CIDR list instead of applying a broken policy', () => {
    const template = readFileSync(REAL_TEMPLATE, 'utf-8');
    expect(() => renderS3EgressVpcManifest(template, [])).toThrow(/non-empty array/);
  });

  it('throws on more than one CIDR — the template supports exactly one today', () => {
    const template = readFileSync(REAL_TEMPLATE, 'utf-8');
    expect(() => renderS3EgressVpcManifest(template, ['10.10.0.0/20', '10.20.0.0/16'])).toThrow(
      /supports exactly one/,
    );
  });
});

describe('s3-egress-vpc.yaml kustomize-build validation', () => {
  // Warm kubectl once before the timed test below — see
  // manifest-dry-run.test.ts's identical beforeAll for why (cold-runner
  // first-invocation latency).
  beforeAll(() => {
    spawnSync('kubectl', ['kustomize', 'carbon/k8s/base/s3-egress-vpc'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
  }, 60_000);

  it('the standalone kustomization (unrendered — placeholder in place) builds without error', () => {
    // Unlike {{K8S_STORAGE_CLASS}}'s deliberately-invalid curly-brace
    // syntax, __VPC_CIDR__ is a syntactically ordinary YAML scalar, so the
    // raw template builds fine — it's just semantically not a real CIDR
    // (harmless: this file is applied only via applyK3sManifests's own
    // conditional `readFileSync` + render + `apply -f -`, never through a
    // bare `kubectl apply -k` of this directory).
    const result = kustomizeBuild('carbon/k8s/base/s3-egress-vpc');
    if (!result.ok) {
      throw new Error(`kustomize build failed:\n${result.stderr}\n${result.stdout}`);
    }
    expect(result.stdout).toContain('__VPC_CIDR__');
    for (const name of POLICY_NAMES) {
      expect(result.stdout).toContain(`name: ${name}`);
    }
  });

  it('is NOT referenced by the parent carbon/k8s/base kustomization (byte-identical for every provider)', () => {
    const baseKustomization = readFileSync(
      join(ROOT, 'carbon/k8s/base/kustomization.yaml'),
      'utf-8',
    );
    expect(baseKustomization).not.toContain('s3-egress-vpc');
  });
});
