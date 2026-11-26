/**
 * ensureOperatorIpAccessWarnAll lets the operator's address through every
 * named environment's firewall in one pass, each with its own provider's
 * token, for `status` (and, through ensureOperatorIpAccessWarn, `shell` and
 * `diagnose`). An address is saved project-wide, but a command pushes only
 * its own environment, so every environment carries the list its firewall
 * was last pushed (`operatorCidrsPushed`), and one whose record lacks the
 * operator's own CIDR is pushed the saved list. Any other difference is left
 * to `vibecarbon access`: a command lets its operator in and nothing more.
 * The gates of deploy, backup and the rest push their own environment on the
 * same rule.
 *
 * `vibecarbon access` pushes every environment too, each with its own token
 * (it used one provider's token for all of them), and carries on past a
 * failing environment.
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
  /** The operator's provider tokens, by provider id. */
  token: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    resolveProviderToken: (id: string) => m.token(id),
  };
});

// `vibecarbon access` and the gate's output: quiet, so the test output stays clean.
vi.mock('@clack/prompts', () => ({
  log: m.log,
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
import { requireEnvOperatorIpAccess } from '../../../src/lib/operator-ip-gate.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const ME = '203.0.113.7/32';
const TEAMMATE = '198.51.100.1/32';
/** An entry someone removed with `access remove`. */
const REMOVED = '192.0.2.99/32';

const entry = (cidr: string) => ({
  cidr,
  addedAt: '2026-11-01T00:00:00.000Z',
  lastUsedAt: '2026-11-01T00:00:00.000Z',
});

/** prod: Hetzner k8s HA (two firewalls). staging: DigitalOcean k8s (one). qa: Hetzner compose (one). */
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
const qa = (extra = {}) => ({
  provider: 'hetzner',
  deployMode: 'compose',
  servers: [{ name: 'qa', ip: '192.0.2.3' }],
  ...extra,
});

const sorted = (...cidrs: string[]) => [...cidrs].sort();

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

class Exit extends Error {}

/** Run `vibecarbon access ...` in the temp project; resolves to the exit code it asked for, if any. */
async function access(argv: string[]): Promise<number | null> {
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  let code: number | null = null;
  vi.spyOn(process, 'exit').mockImplementation(((c: number) => {
    code = c;
    throw new Exit();
  }) as never);
  try {
    await accessRun(argv);
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
  }
  return code;
}

const logged = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  dir = createTempDir('vc-everywhere-');
  m.pushes.length = 0;
  m.failing.clear();
  m.absent.clear();
  m.fetch.mockReset();
  m.token.mockReset();
  m.token.mockImplementation((id: string) => `token-${id}`);
  m.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '203.0.113.7' });
  for (const fn of Object.values(m.log)) fn.mockClear();
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

  it("an address already listed, in every environment's record, pushes nothing", async () => {
    const projectConfig = writeProject(
      {
        prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME) }),
        staging: staging({ operatorCidrsPushed: sorted(TEAMMATE, ME) }),
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

  it("a record that holds the operator's CIDR but differs in another entry is not pushed", async () => {
    // prod lacks the teammate's newer entry; staging still holds one someone
    // removed. Neither keeps this operator out, so neither is this command's
    // to change: a stale checkout must not re-open REMOVED or drop TEAMMATE.
    const projectConfig = writeProject(
      {
        prod: prod({ operatorCidrsPushed: [ME] }),
        staging: staging({ operatorCidrsPushed: sorted(ME, REMOVED) }),
      },
      [ME, TEAMMATE],
    );
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    expect(m.pushes).toEqual([]);
  });

  it('an address already listed reaches every environment whose record lacks it, and only those', async () => {
    // deploy saved this address and pushed its own environment only.
    const projectConfig = writeProject(
      {
        prod: prod(), // no record: pushed before records existed
        staging: staging({ operatorCidrsPushed: [TEAMMATE] }), // lacks ME
        qa: qa({ operatorCidrsPushed: sorted(TEAMMATE, ME) }), // holds ME
      },
      [TEAMMATE, ME],
    );
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging', 'qa'],
      cwd: dir,
    });
    expect(pushedTo()).toEqual([
      'demo-prod-primary-firewall',
      'demo-prod-standby-firewall',
      'demo-staging-firewall',
    ]);
    // The payload is the saved list, as every push sends.
    for (const push of m.pushes) expect(push.cidrs).toEqual([TEAMMATE, ME]);
    const envs = onDisk().environments;
    expect(envs.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
    expect(envs.staging.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
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
    expect(envs.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
    expect(envs.staging.operatorCidrsPushed).toEqual([TEAMMATE]);
    // The in-memory copy agrees with the file.
    expect(projectConfig.environments.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it('does not record an environment whose firewall was not found, so the next run pushes it again', async () => {
    const projectConfig = writeProject({ prod: prod() });
    m.absent.add('demo-prod-standby-firewall');
    await ensureOperatorIpAccessWarnAll({ projectConfig, environments: ['prod'], cwd: dir });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall']);
    expect(onDisk().environments.prod).not.toHaveProperty('operatorCidrsPushed');
  });

  it('when the address cannot be detected, it pushes nothing: there is no CIDR to check for', async () => {
    m.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const projectConfig = writeProject({ prod: prod(), staging: staging() });
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
    });
    expect(m.pushes).toEqual([]);
  });

  it('in CI it trusts the saved list: no detect, nothing saved, nothing pushed, even to an environment whose record lacks the address', async () => {
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

describe('the command gates push their own environment on the same rule', () => {
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
    expect(envs.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
    // staging was not pushed: its record still lacks the address.
    expect(envs.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('`backup staging` from an address `deploy prod` saved opens staging, and leaves prod alone', async () => {
    // deploy prod saved ME and pushed prod only.
    const projectConfig = writeProject(
      {
        prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME) }),
        staging: staging({ operatorCidrsPushed: [TEAMMATE] }),
      },
      [TEAMMATE, ME],
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const gate = (envName: string) =>
      requireEnvOperatorIpAccess({
        projectConfig,
        envName,
        envConfig: projectConfig.environments[envName],
        yes: true,
      });

    await gate('staging');
    expect(m.pushes).toEqual([
      {
        token: 'token-digitalocean',
        firewallName: 'demo-staging-firewall',
        cidrs: [TEAMMATE, ME],
      },
    ]);
    expect(onDisk().environments.staging.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
    expect(m.log.success).toHaveBeenCalledWith(`Firewall updated: SSH/k8s API now allow ${ME}`);

    m.pushes.length = 0;
    await gate('prod');
    expect(m.pushes).toEqual([]);
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
    expect(await access(['add', '192.0.2.50/32'])).toBeNull();
    const cidrs = [TEAMMATE, '192.0.2.50/32'];
    expect(m.pushes).toEqual([
      { token: 'token-hetzner', firewallName: 'demo-prod-primary-firewall', cidrs },
      { token: 'token-hetzner', firewallName: 'demo-prod-standby-firewall', cidrs },
      { token: 'token-digitalocean', firewallName: 'demo-staging-firewall', cidrs },
    ]);
    const envs = onDisk().environments;
    expect(envs.prod.operatorCidrsPushed).toEqual(sorted(...cidrs));
    expect(envs.staging.operatorCidrsPushed).toEqual(sorted(...cidrs));
  });

  it('remove carries on past a failing environment, then exits 1 naming it and the retry', async () => {
    writeProject({ prod: prod(), staging: staging() }, [TEAMMATE, ME, REMOVED]);
    m.failing.add('demo-prod-primary-firewall');
    expect(await access(['remove', REMOVED])).toBe(1);
    // prod came first and failed; staging after it was still pushed.
    expect(pushedTo()).toEqual(['demo-staging-firewall']);
    const error = logged(m.log.error);
    expect(error).toContain(`Removed ${REMOVED} from the list, but these firewalls still allow it`);
    expect(error).toContain('prod (firewall API answered 503)');
    expect(error).not.toContain('staging');
    expect(error).toContain(`rerun \`vibecarbon access remove ${REMOVED}\``);
    const envs = onDisk().environments;
    expect(envs.prod).not.toHaveProperty('operatorCidrsPushed');
    expect(envs.staging.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it('a rerun of remove for a CIDR already gone pushes the environments that may still allow it', async () => {
    writeProject(
      {
        prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME, REMOVED) }), // still holds it
        staging: staging({ operatorCidrsPushed: sorted(TEAMMATE, ME) }), // already without it
        qa: qa(), // no record: may hold it
      },
      [TEAMMATE, ME],
    );
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual([
      'demo-prod-primary-firewall',
      'demo-prod-standby-firewall',
      'demo-qa-firewall',
    ]);
    for (const push of m.pushes) expect(push.cidrs).toEqual([TEAMMATE, ME]);
    const envs = onDisk().environments;
    expect(envs.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
    expect(envs.qa.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it('a rerun of remove with every record already without the CIDR pushes nothing', async () => {
    writeProject(
      {
        prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME) }),
        staging: staging({ operatorCidrsPushed: sorted(TEAMMATE, ME) }),
      },
      [TEAMMATE, ME],
    );
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(m.pushes).toEqual([]);
    expect(logged(m.log.warn)).toContain(`${REMOVED} is not in the list, nothing to remove.`);
  });

  it('remove where the provider finds only one side of an HA environment exits 1 naming the side', async () => {
    const record = sorted(TEAMMATE, ME, REMOVED);
    writeProject(
      {
        prod: prod({ operatorCidrsPushed: record }),
        staging: staging({ operatorCidrsPushed: record }),
      },
      [TEAMMATE, ME, REMOVED],
    );
    m.absent.add('demo-prod-standby-firewall');
    expect(await access(['remove', REMOVED])).toBe(1);
    // The found side and the other environment are still pushed.
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-staging-firewall']);
    const error = logged(m.log.error);
    expect(error).toContain(`Removed ${REMOVED} from the list, but these firewalls still allow it`);
    expect(error).toMatch(/prod \(.*demo-prod-standby-firewall.*\)/);
    expect(error).not.toContain('staging');
    expect(error).toContain(`rerun \`vibecarbon access remove ${REMOVED}\``);
    const envs = onDisk().environments;
    // prod's record still holds the CIDR, so the rerun pushes prod again.
    expect(envs.prod.operatorCidrsPushed).toEqual(record);
    expect(envs.staging.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it("remove with one environment's token missing exits 1 naming it and the variable, and changes nothing", async () => {
    writeProject({ prod: prod(), staging: staging() }, [TEAMMATE, ME, REMOVED]);
    m.token.mockImplementation((id: string) => (id === 'digitalocean' ? undefined : `token-${id}`));
    expect(await access(['remove', REMOVED])).toBe(1);
    expect(logged(m.log.error)).toMatch(/staging.*DIGITALOCEAN_API_TOKEN/);
    // Refused before the list changed: the CIDR is still listed, nothing was pushed.
    expect(onDisk().operatorCidrs.map((e: { cidr: string }) => e.cidr)).toContain(REMOVED);
    expect(m.pushes).toEqual([]);
  });

  it('a token gone by the time of the push is a failure too, naming the environment and the variable', async () => {
    writeProject({ prod: prod(), staging: staging() }, [TEAMMATE, ME, REMOVED]);
    // There for the check before the list changes, gone for the push.
    let lookups = 0;
    m.token.mockImplementation((id: string) =>
      id === 'digitalocean' && lookups++ > 0 ? undefined : `token-${id}`,
    );
    expect(await access(['remove', REMOVED])).toBe(1);
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    const error = logged(m.log.error);
    expect(error).toContain(`Removed ${REMOVED} from the list, but these firewalls still allow it`);
    expect(error).toMatch(/staging \(.*DIGITALOCEAN_API_TOKEN.*\)/);
    expect(onDisk().environments.staging).not.toHaveProperty('operatorCidrsPushed');
  });
});
