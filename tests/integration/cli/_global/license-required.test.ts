import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintV2Key } from '../../../../scripts/generate-license.js';
import { loadE2EEnvFile } from '../../../e2e/utils/e2e-env-file.js';
import { testLicenseKey } from '../../_harness/index.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI = join(REPO_ROOT, 'src', 'cli.js');

// Licensing gates PROVISIONING, and nothing else.
//
// `deploy` consults the license only when it is standing a NEW environment
// up in a paid deploy mode (requireProvisionEntitlement() — see
// src/lib/licensing/index.js, and isProvisioningDeploy() in
// src/lib/deploy/prompts.js). Redeploying an environment that already
// exists, and every one of backup / restore / failover / scale, is free at
// every deploy mode: a subscription buys the ability to stand a paid mode
// up, never the right to keep one running.
//
// Provisioning Kubernetes needs Graphene ($19/project/month); either HA mode
// needs Fullerene ($39/project/month). A refusal exits NON-ZERO — a command
// that silently does nothing is a failed invocation, not a success.
//
// These run inside minimal project fixtures (so assertInProjectDir passes).
// Most run with an isolated EMPTY HOME, i.e. one with no
// ~/.vibecarbon/license, so nothing on the developer's machine can make a
// refusal disappear. The last case deliberately does the opposite: it plants
// the harness's genuine legacy key and proves it still entitles everything.

/** Every command that used to gate on its deploy mode. All free now. */
const OPERATE_COMMANDS = ['backup', 'deploy', 'failover', 'restore', 'scale'] as const;

// argv for each command against a single pre-existing "prod" environment.
// `-l` (list) on backup/restore avoids the interactive action prompt so the
// process reaches (and passes) the gate deterministically.
const OPERATE_ARGV: Record<string, string[]> = {
  backup: ['backup', 'prod', '-l'],
  deploy: ['deploy', 'prod'],
  failover: ['failover', 'prod'],
  restore: ['restore', 'prod', '-l'],
  scale: ['scale', 'prod'],
};

function writeProject(dir: string, envConfig?: Record<string, unknown>): void {
  const config: Record<string, unknown> = { projectName: 'lictest' };
  if (envConfig) {
    config.environments = { prod: envConfig };
  }
  writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
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
 * private key. Case (f) below is skipped where it is absent (CI holds
 * VIBECARBON_TEST_LICENSE_KEY, not the signing key); the same path is covered
 * unconditionally at the unit level against the real getLicense +
 * evaluateEntitlement + upsell in tests/unit/licensing/storage.test.ts.
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
    env: { ...process.env, HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeout: 30000,
  });
  return {
    ...result,
    plain: stripAnsi(`${result.stdout || ''}\n${result.stderr || ''}`),
  };
}

describe('vibecarbon — the license gates provisioning only', () => {
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

  // (a) An environment that already exists is never gated, at any tier.
  describe('an existing environment is free to operate, in every deploy mode', () => {
    const DEPLOYED_FIXTURES: Record<string, Record<string, unknown>> = {
      compose: { deployMode: 'compose', status: 'deployed', servers: [{ ip: '10.0.0.1' }] },
      'compose-ha': { deployMode: 'compose-ha', status: 'deployed', servers: [{ ip: '10.0.0.1' }] },
      kubernetes: { deployMode: 'kubernetes', status: 'deployed', servers: [{ ip: '10.0.0.1' }] },
      'kubernetes+ha': {
        deployMode: 'kubernetes',
        // Real persisted shape (see orchestrator.js) — ha is always an
        // object with `enabled`, never a bare boolean.
        ha: { enabled: true },
        status: 'deployed',
        servers: [{ ip: '10.0.0.1' }],
      },
    };

    for (const [fixtureName, envConfig] of Object.entries(DEPLOYED_FIXTURES)) {
      for (const name of OPERATE_COMMANDS) {
        it(`${name} (${fixtureName}, deployed) → never says "License required"`, () => {
          writeProject(proj, envConfig);
          const result = run(OPERATE_ARGV[name], proj, home);
          expect(
            result.signal,
            `${name}: process was killed (likely hung)\n${result.plain}`,
          ).toBeNull();
          expect(result.plain, `${name}: unexpectedly emitted "License required"`).not.toContain(
            'License required',
          );
        });
      }
    }
  });

  // (b) Provisioning a paid mode refuses, naming the tier its price buys.
  describe('provisioning a paid deploy mode refuses, by required tier', () => {
    // -mode flag, tier name, price, deploy-mode proof line
    const PROVISION_CASES: Array<[string, string, string, string]> = [
      ['k8s', 'Graphene', '$19', 'Kubernetes'],
      ['k8s-ha', 'Fullerene', '$39', 'Kubernetes HA'],
      ['compose-ha', 'Fullerene', '$39', 'Compose HA'],
    ];

    for (const [mode, tierName, price, modeLabel] of PROVISION_CASES) {
      it(`deploy -mode ${mode} on a fresh project → refuses, names ${tierName} and ${price}`, () => {
        writeProject(proj); // no environments key at all
        // -provider is required for a NEW env under -y (2026-08-08, PR 2
        // opening commit) — without it the provider-explicitness error would
        // fire before this test's subject (the license gate) is reached.
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
        expect(upsell, `-mode ${mode}: no em dash in user-facing copy`).not.toContain('—');
      });
    }
  });

  // (c) Free tier: provisioning single-server Compose never gates.
  it('deploy -y on a fresh project defaults to compose → no "License required"', () => {
    writeProject(proj); // no environments key at all
    const result = run(['deploy', 'prod', '-provider', 'hetzner', '-y'], proj, home);
    expect(
      result.signal,
      `deploy -y: process was killed (likely hung)\n${result.plain}`,
    ).toBeNull();
    expect(result.plain, 'deploy -y: unexpectedly emitted "License required"').not.toContain(
      'License required',
    );
  });

  // (d) A resumed first deploy is still provisioning: the skeleton save
  // persists deployMode long before anything is actually stood up.
  it('resuming an unfinished first deploy (status: deploying) still refuses', () => {
    writeProject(proj, { deployMode: 'kubernetes', status: 'deploying' });
    const result = run(['deploy', 'prod', '-y'], proj, home);

    expect(
      result.status,
      `resume: expected non-zero exit. status=${result.status}\n${result.plain}`,
    ).not.toBe(0);
    expect(result.plain).toContain('License required');
    expect(result.plain).toContain('Graphene');
    expect(result.plain).toContain('Deploy mode: Kubernetes');
  });

  // (e) The legacy lifetime key keeps entitling everything, everywhere.
  it('a legacy lifetime key in HOME clears the gate for k8s-ha provisioning', () => {
    writeProject(proj);
    writeLegacyLicense(home);

    const result = run(
      ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s-ha', '-y'],
      proj,
      home,
    );
    expect(
      result.signal,
      `legacy key: process was killed (likely hung)\n${result.plain}`,
    ).toBeNull();
    expect(result.plain, 'legacy key: must clear the gate').not.toContain('License required');
    // Proves the run got PAST the gate rather than dying before it: an
    // unlicensed run of this exact argv refuses (see the case above), so
    // reaching any later stage at all is the entitlement working.
    expect(
      result.plain.trim().length,
      'legacy key: expected output from the deploy flow',
    ).toBeGreaterThan(0);
  });

  // (f) A `.vibecarbon.license` checked in from ANOTHER project must be named
  // as such. Saying "no license" there would send someone to buy a second
  // subscription for a key they already hold.
  const signingKey = signingKeyOrNull();
  it.skipIf(!signingKey)(
    'a valid v2 key for a different project refuses, printing both project ids',
    () => {
      writeProject(proj);
      // The gate backfills this project's own id into .vibecarbon.json on
      // first run, so only the FOREIGN key has to be minted up front.
      const otherProjectId = '99999999-9999-9999-9999-999999999999';
      const key = mintV2Key(signingKey as string, {
        tier: 'fullerene',
        customerId: 'a1b2c3d4',
        projectId: otherProjectId,
        paidThrough: '2030-12-31',
      });
      writeFileSync(
        join(proj, '.vibecarbon.license'),
        `${JSON.stringify(
          {
            key,
            format: 'v2',
            tier: 'fullerene',
            customerId: 'a1b2c3d4',
            projectId: otherProjectId,
            paidThrough: '2030-12-31',
            activatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual',
          },
          null,
          2,
        )}\n`,
      );

      const result = run(
        ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s', '-y'],
        proj,
        home,
      );

      expect(
        result.status,
        `wrong-project: expected non-zero exit. status=${result.status}\n${result.plain}`,
      ).not.toBe(0);
      expect(result.plain).toContain('License required');
      expect(result.plain, "must name the key's project").toContain(
        `The stored key is for project ${otherProjectId}`,
      );
      // The id the gate backfilled into .vibecarbon.json is this project's.
      const thisProjectId = JSON.parse(
        readFileSync(join(proj, '.vibecarbon.json'), 'utf-8'),
      ).projectId;
      expect(thisProjectId, 'the gate must have backfilled a project id').toBeTruthy();
      expect(result.plain, 'must name this project too').toContain(
        `this project is ${thisProjectId}. Each project has its own subscription.`,
      );
    },
  );
});
