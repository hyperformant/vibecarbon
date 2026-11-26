/**
 * ensureOperatorIpAccessWarnAll lets the operator's address through every
 * named environment's firewall in one pass, each with its own provider's
 * token, for `status` (and, through ensureOperatorIpAccessWarn, `shell` and
 * `diagnose`). An address is saved project-wide, but deploy, diagnose and
 * shell push only their own environment, so every environment carries the
 * list its firewall was last pushed (`operatorCidrsPushed`) and one that lags
 * the project list is pushed again.
 *
 * `vibecarbon access` pushes every environment too, each with its own token
 * (it used one provider's token for all of them).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Push = { token: string; firewallName: string; cidrs: string[] };

const m = vi.hoisted(() => ({
  pushes: [] as Push[],
  /** Firewall names whose push throws. */
  failing: new Set<string>(),
  /** Firewall names the provider does not find. */
  absent: new Set<string>(),
  fetch: vi.fn(),
}));

vi.mock('../../../src/lib/fetch-retry.js', () => ({ fetchWithRetry: m.fetch }));

vi.mock('../../../src/lib/providers/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/providers/index.js')>();
  const fake = (NAME: string, TOKEN_ENV: string) =>
    class {
      static NAME = NAME;
      static TOKEN_ENV = TOKEN_ENV;
      token: string;
      constructor(token: string) {
        this.token = token;
      }
      async applyOperatorCidrs({ firewallName, cidrs }: { firewallName: string; cidrs: string[] }) {
        if (m.failing.has(firewallName)) throw new Error('firewall API answered 503');
        if (m.absent.has(firewallName)) return false;
        m.pushes.push({ token: this.token, firewallName, cidrs });
        return true;
      }
    };
  const classes: Record<string, unknown> = {
    hetzner: fake('Hetzner Cloud', 'HETZNER_API_TOKEN'),
    digitalocean: fake('DigitalOcean', 'DIGITALOCEAN_API_TOKEN'),
  };
  return {
    ...original,
    providerFor: (envConfig: { provider?: string }) => classes[envConfig?.provider ?? 'hetzner'],
    resolveProviderToken: (id: string) => `token-${id}`,
  };
});

// `vibecarbon access` output: quiet, so the test output stays clean.
vi.mock('@clack/prompts', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
}));
vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock('../../../src/lib/colors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/colors.js')>()),
  printBanner: () => {},
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: () => {} }));

import { run as accessRun } from '../../../src/access.js';
import { loadProjectConfig } from '../../../src/lib/config.js';
import {
  ensureOperatorIpAccess,
  ensureOperatorIpAccessWarnAll,
} from '../../../src/lib/operator-ip.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const ME = '203.0.113.7/32';
const TEAMMATE = '198.51.100.1/32';

const entry = (cidr: string) => ({
  cidr,
  addedAt: '2026-11-01T00:00:00.000Z',
  lastUsedAt: '2026-11-01T00:00:00.000Z',
});

/** prod: Hetzner k8s HA (two firewalls). staging: DigitalOcean k8s (one). */
const prod = (extra = {}) => ({
  provider: 'hetzner',
  deployMode: 'kubernetes',
  ha: { enabled: true },
  servers: [{ name: 'prod-master', ip: '192.0.2.1' }],
  ...extra,
});
const staging = (extra = {}) => ({
  provider: 'digitalocean',
  deployMode: 'kubernetes',
  servers: [{ name: 'staging-master', ip: '192.0.2.2' }],
  ...extra,
});

let dir: string;
let errors: string[];

function writeProject(environments: Record<string, object>, cidrs: string[] = [TEAMMATE]) {
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({ projectName: 'demo', operatorCidrs: cidrs.map(entry), environments }),
  );
  return loadProjectConfig(dir);
}

const onDisk = () => JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
const pushedTo = () => m.pushes.map((p) => p.firewallName);

beforeEach(() => {
  dir = createTempDir('vc-everywhere-');
  m.pushes.length = 0;
  m.failing.clear();
  m.absent.clear();
  m.fetch.mockReset();
  m.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '203.0.113.7' });
  // Auto-detect, as on an operator's machine (the unit tier runs with CI=true).
  vi.stubEnv('CI', '');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('ensureOperatorIpAccessWarnAll', () => {
  it('a new address reaches every named environment, both sides of an HA one, each with its own token', async () => {
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    const cidrs = [TEAMMATE, ME];
    expect(m.pushes).toEqual([
      { token: 'token-hetzner', firewallName: 'demo-prod-primary-firewall', cidrs },
      { token: 'token-hetzner', firewallName: 'demo-prod-standby-firewall', cidrs },
      { token: 'token-digitalocean', firewallName: 'demo-staging-firewall', cidrs },
    ]);
    expect(onDisk().operatorCidrs.map((e: { cidr: string }) => e.cidr)).toEqual(cidrs);
  });

  it('an address already listed, with every environment in sync, pushes nothing', async () => {
    // The record is sorted; the list is in the order it was added. Same CIDRs, in sync.
    const projectConfig = writeProject(
      {
        prod: prod({ operatorCidrsPushed: [TEAMMATE, ME] }),
        staging: staging({ operatorCidrsPushed: [TEAMMATE, ME] }),
      },
      [ME, TEAMMATE],
    );
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    expect(m.fetch).toHaveBeenCalled();
    expect(m.pushes).toEqual([]);
  });

  it('an address already listed reaches the one environment whose record lags, and only it', async () => {
    // deploy prod saved this address and pushed prod only, before records existed.
    const projectConfig = writeProject(
      { prod: prod(), staging: staging({ operatorCidrsPushed: [ME] }) },
      [ME],
    );
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    expect(onDisk().environments.prod.operatorCidrsPushed).toEqual([ME]);
  });

  it('records the pushed list after a push that succeeded, and keeps the old record after one that failed', async () => {
    const projectConfig = writeProject({
      prod: prod({ operatorCidrsPushed: [TEAMMATE] }),
      staging: staging({ operatorCidrsPushed: [TEAMMATE] }),
    });
    m.failing.add('demo-staging-firewall');
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    const envs = onDisk().environments;
    expect(envs.prod.operatorCidrsPushed).toEqual([TEAMMATE, ME].sort());
    expect(envs.staging.operatorCidrsPushed).toEqual([TEAMMATE]);
    // The in-memory copy agrees with the file.
    expect(projectConfig.environments.prod.operatorCidrsPushed).toEqual([TEAMMATE, ME].sort());
  });

  it('does not record an environment whose firewall was not found, so the next run pushes it again', async () => {
    const projectConfig = writeProject({ prod: prod() });
    m.absent.add('demo-prod-standby-firewall');
    await ensureOperatorIpAccessWarnAll({ projectConfig, environments: ['prod'], cwd: dir });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall']);
    expect(onDisk().environments.prod).not.toHaveProperty('operatorCidrsPushed');
  });

  it('in CI it trusts the saved list: no detect, nothing saved, nothing pushed, even to an environment whose record lags', async () => {
    vi.stubEnv('CI', 'true');
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    const before = readFileSync(join(dir, '.vibecarbon.json'), 'utf-8');
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      yes: true,
      cwd: dir,
    });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).toBe(before);
    expect(m.pushes).toEqual([]);
  });

  it('one firewall that fails is named, and the others are still updated', async () => {
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    m.failing.add('demo-staging-firewall');
    // The failing environment first: it must not stop the ones after it.
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['staging', 'prod'],
      cwd: dir,
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    expect(errors.join('\n')).toMatch(/staging.*firewall API answered 503/);
  });

  it('an environment with no provider token is named and skipped', async () => {
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
      tokenFor: (envConfig: { provider?: string }) =>
        envConfig.provider === 'digitalocean' ? undefined : 'token-hetzner',
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    expect(errors.join('\n')).toMatch(/staging.*DIGITALOCEAN_API_TOKEN/);
    expect(onDisk().environments.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('writes to stderr only, so -json stdout stays clean', async () => {
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    m.failing.add('demo-staging-firewall');
    const stdout = vi.spyOn(process.stdout, 'write');
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('every firewall push records what it pushed', () => {
  it("the deploy gate's push (ensureOperatorIpAccess) records it on its environment", async () => {
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    await ensureOperatorIpAccess({
      projectConfig,
      environment: 'prod',
      isHA: true,
      apiToken: 'token-hetzner',
      cwd: dir,
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    const envs = onDisk().environments;
    expect(envs.prod.operatorCidrsPushed).toEqual([TEAMMATE, ME].sort());
    // staging was not pushed: its record still lags, so status pushes it.
    expect(envs.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('no source file but operator-ip.js calls applyToFirewall, so no push goes unrecorded', () => {
    const callers = sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] }).filter(
      (f) =>
        !f.endsWith(join('lib', 'operator-ip.js')) &&
        readFileSync(f, 'utf-8').includes('applyToFirewall('),
    );
    expect(callers).toEqual([]);
  });
});

describe('vibecarbon access', () => {
  it('pushes a Hetzner and a DigitalOcean environment each with its own token, and records both', async () => {
    writeProject({ prod: prod(), staging: staging() });
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await accessRun(['add', '192.0.2.50/32']);
    const cidrs = [TEAMMATE, '192.0.2.50/32'];
    expect(m.pushes).toEqual([
      { token: 'token-hetzner', firewallName: 'demo-prod-primary-firewall', cidrs },
      { token: 'token-hetzner', firewallName: 'demo-prod-standby-firewall', cidrs },
      { token: 'token-digitalocean', firewallName: 'demo-staging-firewall', cidrs },
    ]);
    const envs = onDisk().environments;
    expect(envs.prod.operatorCidrsPushed).toEqual([...cidrs].sort());
    expect(envs.staging.operatorCidrsPushed).toEqual([...cidrs].sort());
  });
});
