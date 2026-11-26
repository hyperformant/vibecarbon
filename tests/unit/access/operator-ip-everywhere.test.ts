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

  it('an environment with no provider token is named and skipped when the address is new', async () => {
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

  it('a missing provider token for an address already on the list is skipped without a word', async () => {
    // status is mostly run without tokens: naming every such environment on
    // every run is noise, and an address on the list is usually let in.
    const projectConfig = writeProject({ prod: prod(), staging: staging() }, [TEAMMATE, ME]);
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
      tokenFor: (envConfig: { provider?: string }) =>
        envConfig.provider === 'digitalocean' ? undefined : 'token-hetzner',
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    expect(errors.join('\n')).not.toMatch(/staging|DIGITALOCEAN_API_TOKEN/);
  });

  it('a second run within a day leaves .vibecarbon.json byte-identical', async () => {
    // Projects commit the file: an interactive status must not dirty it.
    writeProject({ prod: prod(), staging: staging() });
    const once = () =>
      ensureOperatorIpAccessWarnAll({
        projectConfig: loadProjectConfig(dir),
        environments: ['prod', 'staging'],
        cwd: dir,
      });
    await once(); // adds ME, pushes and records both
    const after = readFileSync(join(dir, '.vibecarbon.json'), 'utf-8');
    m.pushes.length = 0;
    await once();
    expect(m.pushes).toEqual([]);
    expect(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).toBe(after);
  });

  it("refreshes an entry's lastUsedAt once it is a day old, and re-adds one removed meanwhile", async () => {
    const projectConfig = writeProject(
      { prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME) }) },
      [TEAMMATE, ME],
    );
    await ensureOperatorIpAccessWarnAll({ projectConfig, environments: ['prod'], cwd: dir });
    const mine = () => onDisk().operatorCidrs.find((e: { cidr: string }) => e.cidr === ME);
    expect(Date.now() - new Date(mine().lastUsedAt).getTime()).toBeLessThan(60_000);
    expect(mine().addedAt).toBe('2026-11-01T00:00:00.000Z');

    // Another terminal removed it from the file this command loaded.
    const cfg = onDisk();
    cfg.operatorCidrs = cfg.operatorCidrs.filter((e: { cidr: string }) => e.cidr !== ME);
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(cfg));
    await ensureOperatorIpAccessWarnAll({ projectConfig, environments: ['prod'], cwd: dir });
    expect(mine()).toBeDefined();
  });

  it('pushes the list as it is on disk at the push, so an access remove meanwhile is not undone', async () => {
    // status saved [TEAMMATE, REMOVED, ME]; then, before its pushes, an
    // `access remove REMOVED` in another terminal wrote the list and pushed
    // and recorded staging.
    const projectConfig = writeProject({ prod: prod(), staging: staging() }, [TEAMMATE, REMOVED]);
    let meanwhile = true;
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod', 'staging'],
      cwd: dir,
      tokenFor: (envConfig: { provider?: string }) => {
        if (meanwhile) {
          meanwhile = false;
          const cfg = onDisk();
          expect(cfg.operatorCidrs.map((e: { cidr: string }) => e.cidr)).toEqual([
            TEAMMATE,
            REMOVED,
            ME,
          ]);
          cfg.operatorCidrs = cfg.operatorCidrs.filter((e: { cidr: string }) => e.cidr !== REMOVED);
          cfg.environments.staging.operatorCidrsPushed = sorted(TEAMMATE, ME);
          writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(cfg));
        }
        return `token-${envConfig.provider}`;
      },
    });
    // staging was recorded by the other terminal: not pushed again.
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    for (const push of m.pushes) expect(push.cidrs).toEqual([TEAMMATE, ME]);
    expect(onDisk().environments.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it('leaves an environment alone when its own address was taken off the list meanwhile', async () => {
    const projectConfig = writeProject({ prod: prod() });
    await ensureOperatorIpAccessWarnAll({
      projectConfig,
      environments: ['prod'],
      cwd: dir,
      tokenFor: () => {
        const cfg = onDisk();
        cfg.operatorCidrs = cfg.operatorCidrs.filter((e: { cidr: string }) => e.cidr !== ME);
        writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(cfg));
        return 'token-hetzner';
      },
    });
    expect(m.pushes).toEqual([]);
    expect(errors.join('\n')).toContain(`${ME} was taken off the list meanwhile`);
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

  it('a second gated command within a day leaves .vibecarbon.json byte-identical', async () => {
    // The same path serves deploy, the gates and, through WarnAll, shell and diagnose.
    writeProject({ prod: prod() });
    const gate = () =>
      ensureOperatorIpAccess({
        projectConfig: loadProjectConfig(dir),
        environment: 'prod',
        isHA: true,
        apiToken: 'token-hetzner',
        cwd: dir,
      });
    await gate();
    const after = readFileSync(join(dir, '.vibecarbon.json'), 'utf-8');
    const again = await gate();
    expect(again).toMatchObject({ added: false, pushed: false, updated: [], missed: [] });
    expect(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).toBe(after);
  });

  it('a push that finds one HA side of two reports itself as partial, not pushed', async () => {
    const projectConfig = writeProject({ prod: prod() });
    m.absent.add('demo-prod-standby-firewall');
    const result = await ensureOperatorIpAccess({
      projectConfig,
      environment: 'prod',
      isHA: true,
      apiToken: 'token-hetzner',
      cwd: dir,
    });
    expect(result).toMatchObject({
      added: true,
      pushed: false,
      updated: ['demo-prod-primary-firewall'],
      missed: ['demo-prod-standby-firewall'],
    });
  });

  it('a gate for some sides of an HA environment pushes only those, and records nothing', async () => {
    // configure cicd on k8s-ha with only the primary's kubeconfig here hands
    // over the primary alone, so its gate lets the operator through that
    // side's firewall. The record is the environment's, both sides, so it is
    // not written: the next gated command still pushes the standby.
    const projectConfig = writeProject({ prod: prod() });
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await requireEnvOperatorIpAccess({
      projectConfig,
      envName: 'prod',
      envConfig: projectConfig.environments.prod,
      yes: true,
      sides: ['prod-primary'],
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall']);
    expect(onDisk().environments.prod).not.toHaveProperty('operatorCidrsPushed');
    expect(m.log.warn).not.toHaveBeenCalled();

    // Both sides named are the whole environment: pushed and recorded.
    m.pushes.length = 0;
    await requireEnvOperatorIpAccess({
      projectConfig,
      envName: 'prod',
      envConfig: projectConfig.environments.prod,
      yes: true,
      sides: ['prod-primary', 'prod-standby'],
    });
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    expect(onDisk().environments.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it('a push that throws carries whether the address was new', async () => {
    const run = (cidrs: string[]) =>
      ensureOperatorIpAccess({
        projectConfig: writeProject({ qa: qa() }, cidrs),
        environment: 'qa',
        apiToken: 'token-hetzner',
        cwd: dir,
      });
    m.failing.add('demo-qa-firewall');
    await expect(run([TEAMMATE])).rejects.toMatchObject({
      name: 'FirewallPushError',
      message: 'firewall API answered 503',
      added: true,
      cidr: ME,
    });
    await expect(run([TEAMMATE, ME])).rejects.toMatchObject({ added: false, cidr: ME });
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

  it('add carries on past a failing environment, then exits 1 naming it and the retry', async () => {
    writeProject({ prod: prod(), staging: staging() }, [TEAMMATE, ME]);
    m.failing.add('demo-staging-firewall');
    expect(await access(['add', REMOVED])).toBe(1);
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    const error = logged(m.log.error);
    expect(error).toContain(
      `${REMOVED} is in the list, but these firewalls do not allow it yet: staging (firewall API answered 503).`,
    );
    expect(error).toContain(`rerun \`vibecarbon access add ${REMOVED}\` to push again`);
    const disk = onDisk();
    expect(disk.operatorCidrs.map((e: { cidr: string }) => e.cidr)).toContain(REMOVED);
    expect(disk.environments.prod.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME, REMOVED));
    expect(disk.environments.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('prune that fails on an environment exits 1 naming the pruned CIDRs and how to finish', async () => {
    const fresh = new Date().toISOString();
    const old = '2026-01-01T00:00:00.000Z';
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'demo',
        operatorCidrs: [
          { cidr: ME, addedAt: fresh, lastUsedAt: fresh },
          { cidr: REMOVED, addedAt: old, lastUsedAt: old },
        ],
        environments: { prod: prod(), staging: staging() },
      }),
    );
    m.failing.add('demo-staging-firewall');
    expect(await access(['prune'])).toBe(1);
    const error = logged(m.log.error);
    expect(error).toContain(
      `Pruned ${REMOVED} from the list, but these firewalls still allow them: staging (firewall API answered 503).`,
    );
    expect(error).toContain('run `vibecarbon access remove <cidr>` for each of them to push again');
    expect(onDisk().operatorCidrs.map((e: { cidr: string }) => e.cidr)).toEqual([ME]);
    expect(onDisk().environments.prod.operatorCidrsPushed).toEqual([ME]);
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

  // A skeleton: the entry a first deploy writes before any server is
  // recorded. Its firewall may exist (a single-k8s first deploy that failed
  // after Pulumi made the cluster) or not (one that stopped earlier), so it
  // is pushed best-effort: never a failure, never a token demand.
  const skeleton = (extra = {}) => staging({ servers: [], status: 'deploying', ...extra });

  it('a skeleton whose firewall exists is pushed by remove, and recorded, exit 0', async () => {
    writeProject({ prod: prod(), staging: skeleton() }, [TEAMMATE, ME, REMOVED]);
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual([
      'demo-prod-primary-firewall',
      'demo-prod-standby-firewall',
      'demo-staging-firewall',
    ]);
    expect(m.pushes.find((p) => p.firewallName === 'demo-staging-firewall')?.token).toBe(
      'token-digitalocean',
    );
    expect(onDisk().environments.staging.operatorCidrsPushed).toEqual(sorted(TEAMMATE, ME));
  });

  it('a skeleton whose firewall does not exist: exit 0, no failure line, no record', async () => {
    writeProject({ prod: prod(), staging: skeleton() }, [TEAMMATE, ME, REMOVED]);
    m.absent.add('demo-staging-firewall');
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
    expect(logged(m.log.error)).toBe('');
    expect(onDisk().environments.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('a skeleton on another provider with no token: add and remove exit 0 with one note naming it, never asking for the token', async () => {
    writeProject({ prod: prod(), staging: skeleton() }, [TEAMMATE, ME]);
    m.token.mockImplementation((id: string) => (id === 'digitalocean' ? undefined : `token-${id}`));
    const prodSides = ['demo-prod-primary-firewall', 'demo-prod-standby-firewall'];

    expect(await access(['add', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual(prodSides);
    const note = (calls: string) => calls.split('\n').filter((l) => l.includes('staging'));
    expect(note(logged(m.log.info))).toEqual([
      expect.stringMatching(/staging.*DIGITALOCEAN_API_TOKEN/),
    ]);

    m.pushes.length = 0;
    m.log.info.mockClear();
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual(prodSides);
    expect(note(logged(m.log.info))).toHaveLength(1);

    // Neither run asked for it: no error line, no refusal before the list changed.
    expect(logged(m.log.error)).toBe('');
    expect(onDisk().environments.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('a skeleton whose firewall was found but failed to update fails remove, exit 1', async () => {
    // Found and not updated, it may still admit the CIDR: not a silent skip.
    writeProject({ prod: prod(), staging: skeleton() }, [TEAMMATE, ME, REMOVED]);
    m.failing.add('demo-staging-firewall');
    expect(await access(['remove', REMOVED])).toBe(1);
    expect(logged(m.log.error)).toMatch(/staging \(firewall API answered 503\)/);
    expect(onDisk().environments.staging).not.toHaveProperty('operatorCidrsPushed');
  });

  it('a rerun of remove pushes a skeleton best-effort too', async () => {
    writeProject(
      {
        prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME) }),
        staging: skeleton(), // no record: its firewall, if any, may still allow it
      },
      [TEAMMATE, ME],
    );
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual(['demo-staging-firewall']);

    // No firewall there: the rerun still exits 0, with no failure line.
    m.pushes.length = 0;
    m.absent.add('demo-staging-firewall');
    writeProject(
      { prod: prod({ operatorCidrsPushed: sorted(TEAMMATE, ME) }), staging: skeleton() },
      [TEAMMATE, ME],
    );
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(m.pushes).toEqual([]);
    expect(logged(m.log.error)).toBe('');
  });

  it('a k8s-HA environment whose clusters are recorded only under ha.primary/ha.standby still counts as deployed', async () => {
    // A first k8s-HA deploy that failed after both clusters came up: the
    // side records are written, the flat servers list is not yet.
    writeProject(
      {
        prod: prod({
          servers: [],
          ha: {
            enabled: true,
            primary: { ingressIp: '192.0.2.10' },
            standby: { ingressIp: '192.0.2.11' },
          },
        }),
      },
      [TEAMMATE, ME, REMOVED],
    );
    expect(await access(['remove', REMOVED])).toBeNull();
    expect(pushedTo()).toEqual(['demo-prod-primary-firewall', 'demo-prod-standby-firewall']);
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
