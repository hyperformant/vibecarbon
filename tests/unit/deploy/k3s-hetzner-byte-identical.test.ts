/**
 * M3 Task 2 — Hetzner byte-identical pin.
 *
 * The k8s pipeline's static-IP + image literals (`10.0.1.1`/`10.0.1.2`
 * registry refs, `ubuntu-24.04` node image) became data driven by
 * `infraOutputs.masterPrivateIp`/`supabasePrivateIp` and the new
 * `ProviderClass.K8S_IMAGE` static — required because DigitalOcean's VPC
 * can't pin private IPs the way Hetzner's Pulumi program does. THE
 * NON-NEGOTIABLE this file proves: Hetzner's rendered artifacts stay
 * byte-identical, because Hetzner's program still exports the SAME static
 * `'10.0.1.1'`/`'10.0.1.2'` outputs and every refactored call site defaults
 * to those exact values when a caller (deployK3s, in production) doesn't
 * pass them explicitly.
 *
 * `tests/fixtures/k3s-hetzner-ca-config.json` was captured by calling the
 * PRE-refactor `renderCarbonAutoscalerConfig` (commit 16b683e, before this
 * task's changes) with the real `HetznerProvider` class and the same
 * Hetzner-shaped args used below — see task-2-report.md for the capture
 * command. This is a fixture DIFF, not a re-assertion of field-by-field
 * shape (that's k3s-render-ca-config.test.ts's job) — a single byte
 * anywhere in the rendered document (including the embedded cloud-init
 * script) fails this test.
 *
 * RE-CAPTURED 2026-08-05 (private-NIC guard): worker-init.sh gained the
 * guard, so the embedded `cloudInit` changed by design. The invariants this
 * file exists for are unaffected — Hetzner still exports the same static
 * 10.0.1.1/10.0.1.2, and the `image`/`tagPrefix` assertions below are
 * independent of the stored bytes. Re-capture deliberately on an intended
 * template change; never to make a red test go green.
 *
 * RE-CAPTURED 2026-08-20 (apt dpkg-lock timeout): worker-init.sh traded its
 * `fuser` lock-poll loop for `apt-get -o DPkg::Lock::Timeout=300` (see
 * src/lib/deploy/apt.js), so the embedded `cloudInit` changed by design
 * again. Same reasoning as above — the static-IP invariants this file
 * exists to prove are untouched; the diff is confined to the removed loop
 * and the two apt-get lines.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  lastBuildLocalImageOptions: null as Record<string, unknown> | null,
}));

// buildAppImage delegates to buildLocalImage (src/lib/deploy/image.js) for
// the actual `docker build` shell-out — mocked here so the pin exercises
// ONLY buildAppImage's own contribution (the tagPrefix it constructs from
// masterPrivateIp), without needing a real Dockerfile/docker daemon.
vi.mock('../../../src/lib/deploy/image.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    buildLocalImage: vi.fn(async (_projectDir: string, options: Record<string, unknown>) => {
      H.lastBuildLocalImageOptions = options;
      return {
        tag: `${options.tagPrefix}/proj:abc1234-20260101000000`,
        gitSha: 'abc1234',
        isDirty: false,
      };
    }),
  };
});

const { renderCarbonAutoscalerConfig, buildAppImage, pushImageToLocalRegistry } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

const fixturePath = join(__dirname, '../../fixtures/k3s-hetzner-ca-config.json');

describe('M3 Task 2 — Hetzner byte-identical pin', () => {
  beforeEach(() => {
    H.lastBuildLocalImageOptions = null;
  });

  it('renderCarbonAutoscalerConfig(HetznerProvider) is byte-identical to the pre-refactor fixture, with or without an explicit masterPrivateIp', async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    // Re-stringify (not a raw read) so the comparison is immune to the
    // fixture file's own trailing newline / formatting — the DOCUMENT is
    // what's pinned, not incidental file bytes.
    const expected = JSON.stringify(fixture, null, 2);

    const args = {
      k3sVersion: 'v1.31.5+k3s1',
      k3sToken: 'deadbeefcafe1234567890abcdef',
      clusterName: 'acme-prod',
      environment: 'prod',
      providerId: 'hetzner',
      ProviderClass: HetznerProvider,
      region: 'nbg1',
      workerServerType: 'cx23',
      minWorkers: 1,
      maxWorkers: 4,
    };

    // Production shape: deployK3s never passes masterPrivateIp when
    // infraOutputs lacks it (pre-M3 persisted state) — the renderer's own
    // '10.0.1.1' default must still produce this exact document.
    expect(await renderCarbonAutoscalerConfig(args)).toBe(expected);

    // Production shape (post-M3): deployK3s DOES pass masterPrivateIp,
    // sourced from infraOutputs.masterPrivateIp — Hetzner's program exports
    // the same static '10.0.1.1', so passing it explicitly must produce
    // IDENTICAL bytes to the implicit-default path above.
    expect(await renderCarbonAutoscalerConfig({ ...args, masterPrivateIp: '10.0.1.1' })).toBe(
      expected,
    );

    // The image field specifically — the literal this task's refactor
    // touched most directly (was hardcoded 'ubuntu-24.04', now
    // ProviderClass.K8S_IMAGE).
    expect(JSON.parse(expected).nodeGroups['worker-pool'].image).toBe('ubuntu-24.04');
  });

  it('buildAppImage constructs the SAME 10.0.1.1:5000 registry-ref tagPrefix whether masterPrivateIp is passed explicitly or defaulted', async () => {
    // No 5th arg — mirrors every pre-M3 call site (deployK3s now always
    // passes one, but the default must still match).
    await buildAppImage('/tmp/proj', 'proj', false, undefined);
    expect(H.lastBuildLocalImageOptions?.tagPrefix).toBe('10.0.1.1:5000');

    // Explicit Hetzner static — the value deployK3s now threads from
    // infraOutputs.masterPrivateIp on a Hetzner deploy.
    await buildAppImage('/tmp/proj', 'proj', false, undefined, '10.0.1.1');
    expect(H.lastBuildLocalImageOptions?.tagPrefix).toBe('10.0.1.1:5000');
  });

  it('pushImageToLocalRegistry still requires (and validates against) the 10.0.1.1:5000/ prefix by default', async () => {
    // Validation runs before any spawn()/SSH call, so no child_process
    // mocking is needed to reach this assertion — see
    // k3s-push-image.test.ts for the full spawn-mocked push-flow pins,
    // left untouched by this refactor (their unmodified pass is itself
    // corroborating evidence of byte-identical default behavior).
    await expect(
      pushImageToLocalRegistry({
        tag: 'wrong.example.com:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
      }),
    ).rejects.toThrow(/expected tag prefixed with '10\.0\.1\.1:5000\/'/);

    // Explicit Hetzner static must reject the SAME way.
    await expect(
      pushImageToLocalRegistry({
        tag: 'wrong.example.com:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
        masterPrivateIp: '10.0.1.1',
      }),
    ).rejects.toThrow(/expected tag prefixed with '10\.0\.1\.1:5000\/'/);
  });
});
