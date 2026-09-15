import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintV2Key } from '../../../../scripts/generate-license.js';
// @ts-expect-error — JS module without types
import { COMPOSE_REQUIRED_ENV_FALLBACK } from '../../../../src/lib/project.js';
import { loadE2EEnvFile } from '../../../e2e/utils/e2e-env-file.js';
import { testLicenseKey } from '../../_harness/index.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI = join(REPO_ROOT, 'src', 'cli.js');

// Licensing gates DEPLOYS into a paid mode, and nothing else.
//
// `deploy` consults the license whenever its resolved deploy tier costs
// money, first deploy and redeploy alike (requireDeployEntitlement(); see
// src/lib/licensing/index.js). Kubernetes needs Graphene
// ($19/project/month); either HA mode needs Fullerene ($39/project/month).
// A refusal exits NON-ZERO: a command that silently does nothing is a failed
// invocation, not a success.
//
// backup / restore / failover / scale never check, in any deploy mode. A
// subscription buys deploys; asking for money in the middle of a restore
// would be the worst possible moment.
//
// These run inside minimal project fixtures (so assertInProjectDir passes)
// with an isolated HOME, so nothing on the developer's machine can make a
// refusal disappear. Every case also points VIBECARBON_API_BASE at a closed
// port: the gate's live check must never reach the real network from a test,
// and an unreachable server is itself one of the behaviours under test.

/** A port nothing listens on, so the live check always fails fast. */
const UNREACHABLE_API = 'http://127.0.0.1:9';

/** Commands that only ever operate an environment that already exists. */
const OPERATE_ARGV: Record<string, string[]> = {
  backup: ['backup', 'prod', '-l'],
  restore: ['restore', '-h'],
  scale: ['scale', '-h'],
  failover: ['failover', '-h'],
};

const DEPLOYED_K8S = {
  deployMode: 'kubernetes',
  status: 'deployed',
  servers: [{ ip: '10.0.0.1' }],
};
const DEPLOYED_COMPOSE = {
  deployMode: 'compose',
  status: 'deployed',
  servers: [{ ip: '10.0.0.1' }],
};

function writeProject(
  dir: string,
  envConfig?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  const config: Record<string, unknown> = { projectName: 'lictest', ...extra };
  if (envConfig) {
    config.environments = { prod: envConfig };
  }
  writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
  // The runtime-env preflight (deploy step 0d) runs before the license gate:
  // it is mode-independent and costs nothing, and a real project always has
  // these keys (`create` writes them). Give the fixture the same so the
  // refusal under test is the license one, not "the compose stack cannot
  // start".
  writeFileSync(
    join(dir, '.env'),
    `${COMPOSE_REQUIRED_ENV_FALLBACK.map((k) => `${k}=fixture`).join('\n')}\n`,
  );
}

/** A HOME carrying the harness's genuine legacy (lifetime) Fullerene key. */
function writeLegacyLicense(home: string): void {
  const key = testLicenseKey();
  mkdirSync(join(home, '.vibecarbon'), { recursive: true });
  writeFileSync(
    join(home, '.vibecarbon', 'license'),
    JSON.stringify(
      { key, customerId: key.split('-')[2], activatedAt: '2026-01-01T00:00:00.000Z' },
      null,
      2,
    ),
  );
}

/**
 * The Ed25519 signing key, when this machine has it.
 *
 * A v2 key must verify against the PUBLIC key compiled into validator.js,
 * and the spawned CLI has no way to be handed a different one: `publicKeyPem`
 * is a function argument, and no environment variable may influence the gate
 * (tests/unit/licensing/no-dev-bypass.test.ts). So the only way to plant a
 * genuinely valid v2 key for the real CLI is to sign one, which needs the
 * private key. The case below is skipped where it is absent (CI holds
 * VIBECARBON_TEST_LICENSE_KEY, not the signing key); the same path runs
 * unconditionally at the unit level, against the real activateLicense +
 * requireDeployEntitlement, in tests/unit/licensing/deploy-gate-seam.test.ts.
 */
function signingKeyOrNull(): string | null {
  if (!process.env.VIBECARBON_LICENSE_PRIVATE_KEY) {
    loadE2EEnvFile(join(REPO_ROOT, 'tests', '.env.e2e'), process.env);
  }
  return process.env.VIBECARBON_LICENSE_PRIVATE_KEY || null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching them
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function run(argv: string[], cwd: string, home: string) {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      VIBECARBON_API_BASE: UNREACHABLE_API,
    },
    timeout: 30000,
  });
  return {
    ...result,
    plain: stripAnsi(`${result.stdout || ''}\n${result.stderr || ''}`),
  };
}

describe('vibecarbon: the license gates every deploy into a paid mode', () => {
  let proj: string;
  let home: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'vc-licproj-'));
    home = mkdtempSync(join(tmpdir(), 'vc-lichome-'));
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // (1) Single-server Compose is the free tier, and the default.
  it('deploy -y on a fresh project defaults to compose and never says "License required"', () => {
    writeProject(proj);
    const result = run(['deploy', 'prod', '-provider', 'hetzner', '-y'], proj, home);

    expect(result.signal, `process was killed (likely hung)\n${result.plain}`).toBeNull();
    expect(result.plain).not.toContain('License required');
  });

  // (2) and (3) A paid mode refuses, naming the tier its price buys.
  // `-provider` is required for a NEW env under -y, or the provider
  // explicitness error would fire before the gate this test is about.
  const PAID_CASES: Array<[string, string, string, string]> = [
    ['k8s', 'Graphene', '$19', 'Kubernetes'],
    ['k8s-ha', 'Fullerene', '$39', 'Kubernetes HA'],
  ];

  for (const [mode, tierName, price, modeLabel] of PAID_CASES) {
    it(`deploy -mode ${mode} on a fresh project refuses, naming ${tierName} and ${price}`, () => {
      writeProject(proj);
      const result = run(
        ['deploy', 'prod', '-provider', 'hetzner', '-mode', mode, '-y'],
        proj,
        home,
      );

      expect(
        result.status,
        `-mode ${mode}: expected non-zero exit. status=${result.status}\n${result.plain}`,
      ).not.toBe(0);
      expect(result.plain).toContain('License required');
      expect(result.plain, `-mode ${mode}: must name the required tier`).toContain(tierName);
      expect(result.plain, `-mode ${mode}: must name the subscription price`).toContain(
        `${price} per project per month`,
      );
      expect(result.plain, `-mode ${mode}: must name the deploy mode`).toContain(
        `Deploy mode: ${modeLabel}`,
      );
      expect(result.plain, `-mode ${mode}: must say what stays free`).toContain(
        'Single-server Compose needs no key.',
      );
      expect(result.plain, `-mode ${mode}: subscribe link must carry the tier`).toContain(
        'https://vibecarbon.com/pricing?project=',
      );

      // Retired copy: no one-time price, no agency channel, no em dash.
      expect(result.plain).not.toContain('$149');
      expect(result.plain).not.toContain('one-time');
      expect(result.plain).not.toContain('Agencies');
      expect(result.plain).not.toContain('Diamond');
      const upsell = result.plain.slice(result.plain.indexOf('License required'));
      // U+2014 by escape, not literally: this file is itself held to the
      // no-em-dash rule it is asserting.
      expect(upsell, `-mode ${mode}: no em dash in user-facing copy`).not.toContain('\u2014');
    });
  }

  // (4) The behaviour change: a REDEPLOY of a paid environment is gated too.
  // A subscription is a subscription, so a cancelled plan cannot keep
  // shipping releases to a Kubernetes production stack indefinitely.
  it('redeploying an existing Kubernetes environment without a key refuses', () => {
    writeProject(proj, DEPLOYED_K8S);
    const result = run(['deploy', 'prod', '-y'], proj, home);

    expect(
      result.status,
      `redeploy: expected non-zero exit. status=${result.status}\n${result.plain}`,
    ).not.toBe(0);
    expect(result.plain).toContain('License required');
    expect(result.plain).toContain('Graphene');
    expect(result.plain).toContain('Deploy mode: Kubernetes');
  });

  // (5) Redeploying Compose stays free, same as standing it up.
  it('redeploying an existing Compose environment without a key never gates', () => {
    writeProject(proj, DEPLOYED_COMPOSE);
    const result = run(['deploy', 'prod', '-y'], proj, home);

    expect(result.signal, `process was killed (likely hung)\n${result.plain}`).toBeNull();
    expect(result.plain).not.toContain('License required');
  });

  // (6) The legacy lifetime key keeps entitling everything, everywhere, and
  // is never checked against the server: it has no subscription to check.
  it('a legacy lifetime key in HOME clears k8s-ha without contacting vibecarbon.com', () => {
    writeProject(proj);
    writeLegacyLicense(home);

    const result = run(
      ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s-ha', '-y'],
      proj,
      home,
    );

    expect(result.signal, `legacy key: process was killed\n${result.plain}`).toBeNull();
    expect(result.plain, 'legacy key: must clear the gate').not.toContain('License required');
    expect(result.plain, 'legacy key: must not be checked against the server').not.toContain(
      'vibecarbon.com to verify',
    );
    // Proves the run got PAST the gate rather than dying before it: an
    // unlicensed run of this exact argv refuses (see the case above), so
    // reaching any later stage at all is the entitlement working.
    expect(
      result.plain.trim().length,
      'legacy key: expected output from the deploy flow',
    ).toBeGreaterThan(0);
  });

  // (7) Offline is fail-open. An unreachable vibecarbon.com with no usable
  // cached verdict warns and proceeds; it must never become a refusal, or a
  // flaky network would block a deploy someone has paid for.
  const signingKey = signingKeyOrNull();
  it.skipIf(!signingKey)(
    'an activated project key with an unreachable server warns and deploys anyway',
    () => {
      const projectId = '11111111-2222-4333-8444-555555555555';
      writeProject(proj, undefined, { projectId });
      const key = mintV2Key(signingKey as string, { customerId: 'a1b2c3d4', projectId });
      writeFileSync(
        join(proj, '.vibecarbon.license'),
        `${JSON.stringify(
          { key, activatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' },
          null,
          2,
        )}\n`,
      );

      const result = run(
        ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s', '-y'],
        proj,
        home,
      );

      expect(result.plain).toContain('Could not reach vibecarbon.com to verify');
      expect(result.plain, 'a reachability failure is not a missing license').not.toContain(
        'License required',
      );
      // Nothing verified, so nothing may be cached: a cache entry written
      // from a failed check would be a verdict no signature ever backed.
      expect(existsSync(join(home, '.vibecarbon', 'license-checks'))).toBe(false);
    },
  );

  // (8) Operating what already exists is free, at every tier.
  describe('operating an existing Kubernetes environment is free', () => {
    for (const [name, argv] of Object.entries(OPERATE_ARGV)) {
      it(`${name} never says "License required"`, () => {
        writeProject(proj, DEPLOYED_K8S);
        const result = run(argv, proj, home);

        expect(
          result.signal,
          `${name}: process was killed (likely hung)\n${result.plain}`,
        ).toBeNull();
        expect(result.plain, `${name}: unexpectedly emitted "License required"`).not.toContain(
          'License required',
        );
      });
    }
  });
});
