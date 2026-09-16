import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { COMPOSE_REQUIRED_ENV_FALLBACK } from '../../../../src/lib/project.js';
import { signingKeyOrNull, startLicenseStub } from '../../_harness/index.js';

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
// refusal disappear. VIBECARBON_API_BASE defaults to a closed port: the
// gate's live check must never reach the real network from a test, and an
// unreachable server is itself one of the behaviours under test. The cases
// that need a real verdict point it at the local licence stub instead.

/** A port nothing listens on, so the live check always fails fast. */
const UNREACHABLE_API = 'http://127.0.0.1:9';

const PERIOD_END = '2099-01-01';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROJECT_ID = '99999999-8888-4777-8666-555555555555';

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

/** The shape `activate` writes into the project: the key, and nothing else. */
function writeProjectLicense(dir: string, key: string): void {
  writeFileSync(
    join(dir, '.vibecarbon.license'),
    `${JSON.stringify({ key, activatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' }, null, 2)}\n`,
  );
}

/**
 * The Ed25519 signing key, when this machine has it (see
 * tests/e2e/utils/license-stub.js).
 *
 * A key must verify against the PUBLIC key compiled into validator.js, and
 * the spawned CLI has no way to be handed a different one: `publicKeyPem` is
 * a function argument, and no environment variable may influence the gate
 * (tests/unit/licensing/no-dev-bypass.test.ts). So the only way to plant a
 * genuinely valid key for the real CLI is to sign one, which needs the
 * private key. The cases below are skipped where it is absent; the same
 * paths run unconditionally at the unit level, against the real
 * activateLicense + requireDeployEntitlement, in
 * tests/unit/licensing/deploy-gate-seam.test.ts.
 */
const signingKey = signingKeyOrNull();
type LicenseStub = Awaited<ReturnType<typeof startLicenseStub>>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching them
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface GateRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  plain: string;
}

/**
 * Spawn the CLI and collect its output.
 *
 * Asynchronous on purpose: the licence stub listens IN THIS PROCESS, and
 * spawnSync would park the event loop for the whole child run, so the stub
 * could never answer and every stubbed case would fail as a timeout. See
 * runCliAsync in tests/integration/_harness/run-cli.ts.
 */
function run(
  argv: string[],
  cwd: string,
  home: string,
  apiBase: string = UNREACHABLE_API,
): Promise<GateRun> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        VIBECARBON_API_BASE: apiBase,
      },
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end('');
    child.on('close', (status, signal) => {
      done({ status, signal, plain: stripAnsi(`${stdout}\n${stderr}`) });
    });
  });
}

describe('vibecarbon: the license gates every deploy into a paid mode', () => {
  let proj: string;
  let home: string;
  let stub: LicenseStub | null = null;

  beforeAll(async () => {
    if (signingKey) stub = await startLicenseStub({ privateKeyPem: signingKey });
  });

  afterAll(async () => {
    await stub?.close();
  });

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'vc-licproj-'));
    home = mkdtempSync(join(tmpdir(), 'vc-lichome-'));
    stub?.calls.splice(0, stub.calls.length);
    stub?.state.clear();
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // (1) Single-server Compose is the free tier, and the default.
  it('deploy -y on a fresh project defaults to compose and never says "License required"', async () => {
    writeProject(proj);
    const result = await run(['deploy', 'prod', '-provider', 'hetzner', '-y'], proj, home);

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
    it(`deploy -mode ${mode} on a fresh project refuses, naming ${tierName} and ${price}`, async () => {
      writeProject(proj);
      const result = await run(
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
      // The link carries the TIER, not a project id: the key is bought before
      // any project is named, and the binding happens later at `activate`.
      expect(result.plain, `-mode ${mode}: subscribe link must carry the tier`).toContain(
        `https://vibecarbon.com/pricing?tier=${tierName.toLowerCase()}`,
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
  it('redeploying an existing Kubernetes environment without a key refuses', async () => {
    writeProject(proj, DEPLOYED_K8S);
    const result = await run(['deploy', 'prod', '-y'], proj, home);

    expect(
      result.status,
      `redeploy: expected non-zero exit. status=${result.status}\n${result.plain}`,
    ).not.toBe(0);
    expect(result.plain).toContain('License required');
    expect(result.plain).toContain('Graphene');
    expect(result.plain).toContain('Deploy mode: Kubernetes');
  });

  // (5) Redeploying Compose stays free, same as standing it up.
  it('redeploying an existing Compose environment without a key never gates', async () => {
    writeProject(proj, DEPLOYED_COMPOSE);
    const result = await run(['deploy', 'prod', '-y'], proj, home);

    expect(result.signal, `process was killed (likely hung)\n${result.plain}`).toBeNull();
    expect(result.plain).not.toContain('License required');
  });

  // (6) A key bound to THIS project, with a live subscription, clears the
  // gate. The verdict is signed by the stub with the same private key the
  // CLI's embedded public key verifies against, so this is the production
  // path, not a bypass.
  it.skipIf(!signingKey)(
    'an activated key bound to this project deploys with "Subscription checked"',
    async () => {
      const s = stub as LicenseStub;
      writeProject(proj, undefined, { projectId: PROJECT_ID });
      const { key, licenseId } = s.mintKey();
      s.seed({
        licenseId,
        projectId: PROJECT_ID,
        tier: 'fullerene',
        status: 'active',
        periodEndYmd: PERIOD_END,
      });
      writeProjectLicense(proj, key);

      const result = await run(
        ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s', '-y'],
        proj,
        home,
        s.baseUrl,
      );

      expect(result.plain, 'bound key: the live check must have answered').toContain(
        'Subscription checked',
      );
      expect(result.plain, 'bound key: must clear the gate').not.toContain('License required');
      // A live verdict is cached per machine so the next deploy survives an
      // outage.
      expect(existsSync(join(home, '.vibecarbon', 'license-checks', `${PROJECT_ID}.json`))).toBe(
        true,
      );
    },
  );

  // (6b) and (6c) Binding problems are refusals in their own words, never the
  // generic "License required": the buyer HAS a subscription, it is just
  // pointed somewhere else (or nowhere yet), and telling them to go buy one
  // would be wrong.
  it.skipIf(!signingKey)('an unbound key refuses with "License not bound"', async () => {
    const s = stub as LicenseStub;
    writeProject(proj, undefined, { projectId: PROJECT_ID });
    const { key, licenseId } = s.mintKey();
    s.seed({
      licenseId,
      projectId: null,
      tier: 'fullerene',
      status: 'active',
      periodEndYmd: PERIOD_END,
    });
    writeProjectLicense(proj, key);

    const result = await run(
      ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s', '-y'],
      proj,
      home,
      s.baseUrl,
    );

    expect(result.status, `unbound: expected non-zero exit\n${result.plain}`).not.toBe(0);
    expect(result.plain).toContain('License not bound');
    expect(result.plain).toContain('vibecarbon activate <key>');
    expect(result.plain, 'unbound is not "go buy a license"').not.toContain('License required');
  });

  it.skipIf(!signingKey)(
    'a key bound to another project refuses with "License bound elsewhere"',
    async () => {
      const s = stub as LicenseStub;
      writeProject(proj, undefined, { projectId: PROJECT_ID });
      const { key, licenseId } = s.mintKey();
      s.seed({
        licenseId,
        projectId: OTHER_PROJECT_ID,
        tier: 'fullerene',
        status: 'active',
        periodEndYmd: PERIOD_END,
      });
      writeProjectLicense(proj, key);

      const result = await run(
        ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s', '-y'],
        proj,
        home,
        s.baseUrl,
      );

      expect(result.status, `wrong project: expected non-zero exit\n${result.plain}`).not.toBe(0);
      expect(result.plain).toContain('License bound elsewhere');
      expect(result.plain, 'mis-bound is not "go buy a license"').not.toContain('License required');
    },
  );

  // (7) Offline is fail-open. An unreachable vibecarbon.com with no usable
  // cached verdict warns and proceeds; it must never become a refusal, or a
  // flaky network would block a deploy someone has paid for. No seed: being
  // unreachable is the whole point, so the key is only ever minted here.
  it.skipIf(!signingKey)(
    'an activated project key with an unreachable server warns and deploys anyway',
    async () => {
      writeProject(proj, undefined, { projectId: PROJECT_ID });
      writeProjectLicense(proj, (stub as LicenseStub).mintKey().key);

      const result = await run(
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
      it(`${name} never says "License required"`, async () => {
        writeProject(proj, DEPLOYED_K8S);
        const result = await run(argv, proj, home);

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
