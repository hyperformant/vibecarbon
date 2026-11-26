/**
 * `configure cicd <k8s env>` reaches the k8s API from this machine, so it
 * lets the operator's address through the firewall first
 * (requireEnvOperatorIpAccess), before any GitOps step. A gate that stops
 * the command stops it before anything is seeded or handed to Flux, and a
 * run with no terminal is headless (`yes`), as `deploy -y` is.
 *
 * Which clusters it hands over is read from the environment's record
 * (gitopsTargets) and each cluster's own kubeconfig: a k8s-ha environment
 * has one per side, `kubeconfig-<env>-primary` and `-standby`. A side whose
 * kubeconfig is not here is skipped, said once and in the outro; with none
 * here, the command stops naming each path. The gate, the leftover notes and
 * the pull credential cover only the sides handed over.
 *
 * The project's own refusals (a Flux tree with a placeholder, a cluster file
 * still on https) are local, so they come before the gate and before any
 * token is asked for.
 *
 * Drives the real runConfigureCicd in a temp project: Stage 1's GitHub calls,
 * the gate, the notes, the pull credential and the per-cluster handover are
 * fakes; gitopsTargets and refuseUnreadyGitopsProject are real.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const m = vi.hoisted(() => ({
  order: [] as string[],
  projectConfig: {} as Record<string, unknown>,
  gate: vi.fn(),
  deploy: vi.fn(),
  note: vi.fn(),
  leftover: vi.fn(),
  pull: vi.fn(),
  log: {
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  outro: vi.fn(),
  /** Every prompt: none is expected, so one that runs fails the test. */
  prompt: vi.fn(() => {
    throw new Error('unexpected prompt');
  }),
}));

vi.mock('@clack/prompts', async (orig) => ({
  ...(await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: [],
    spinner: true,
    fns: ['intro', 'note'],
  }),
  log: m.log,
  outro: m.outro,
  text: m.prompt,
  password: m.prompt,
  confirm: m.prompt,
  select: m.prompt,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => m.projectConfig,
}));
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertScaffoldSupportsRoleFile: () => {},
}));
// Stage 1: gh is there and signed in, and the repo is acme/proj.
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkDependency: () => true,
  runCommand: () => '',
}));
vi.mock('../../../src/lib/ci-setup.js', () => ({
  detectGitHubUsername: () => 'acme',
  getGitHubRepo: () => ({ owner: 'acme', name: 'proj' }),
  getImageTag: () => 'main',
  installWorkflowFile: () => false,
  updateImageReferences: () => {},
}));
vi.mock('../../../src/lib/operator-ip-gate.js', () => ({ requireEnvOperatorIpAccess: m.gate }));
vi.mock('../../../src/lib/deploy/k8s/gitops-deploy.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  deployK8sGitOps: m.deploy,
  noteLeftoverGitopsCopies: m.leftover,
  noteUnreadTokenSecrets: m.note,
  resolveOwnerAndRepo: () => ({ owner: 'acme', name: 'proj' }),
}));
vi.mock('../../../src/lib/deploy/k8s/ghcr-pull-secret.js', () => ({
  resolveGhcrPull: m.pull,
}));

const { runConfigureCicd } = await import('../../../src/configure.js');

const envConfig = {
  status: 'deployed',
  provider: 'hetzner',
  deployMode: 'kubernetes',
  region: 'nbg1',
  domain: 'app.example.test',
};

/** A k8s-ha environment as its deploy records it. */
const haEnvConfig = {
  status: 'deployed',
  provider: 'hetzner',
  deployMode: 'kubernetes-ha',
  region: 'nbg1',
  secondaryRegion: 'fsn1',
  domain: 'app.example.test',
  ha: {
    enabled: true,
    failoverRegion: 'fsn1',
    primary: { stack: 'prod-primary', region: 'nbg1' },
    standby: { stack: 'prod-standby', region: 'fsn1' },
  },
};

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

let dir: string;
let cwd: ReturnType<typeof vi.spyOn>;
const ttyWas = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const setTTY = (value: boolean | undefined) =>
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });

/** The project's record for prod, and the kubeconfigs this machine has (by stack). */
function project(prod: Record<string, unknown>, kubeconfigs: string[]) {
  m.projectConfig = { projectName: 'proj', environments: { prod } };
  writeFileSync(join(dir, '.vibecarbon.json'), `${JSON.stringify(m.projectConfig)}\n`);
  for (const stack of kubeconfigs) {
    writeFileSync(join(dir, '.vibecarbon', `kubeconfig-${stack}`), 'apiVersion: v1\n');
  }
}

/** runConfigureCicd, with a process.exit it asked for as the rejection. */
const run = () => runConfigureCicd('prod');

/** What a log or the outro was handed, without its colour. */
const said = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.map((c) => stripVTControlCharacters(String(c[0])));

beforeEach(() => {
  m.order.length = 0;
  vi.clearAllMocks();
  dir = createTempDir('vc-cicd-gate-');
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  project(envConfig, ['prod']);
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
  m.gate.mockImplementation(async () => {
    m.order.push('gate');
  });
  m.note.mockImplementation(async () => {
    m.order.push('note');
    return [];
  });
  m.leftover.mockImplementation(async () => {
    m.order.push('leftover');
    return [];
  });
  m.pull.mockImplementation(async () => {
    m.order.push('pull');
    return { mode: 'public' };
  });
  m.deploy.mockImplementation(async () => {
    m.order.push('deploy');
    return { pushed: true };
  });
});

afterEach(() => {
  cwd.mockRestore();
  vi.restoreAllMocks();
  if (ttyWas) Object.defineProperty(process.stdin, 'isTTY', ttyWas);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('configure cicd <k8s env> lets the operator in first', () => {
  it('gates the environment before any GitOps step, headless without a terminal', async () => {
    setTTY(undefined);
    await run();
    // The pull credential once, before the per-cluster handover gets it.
    expect(m.order).toEqual(['gate', 'note', 'leftover', 'pull', 'deploy']);
    expect(m.pull.mock.calls[0][0]).toMatchObject({
      owner: 'acme',
      repo: 'proj',
      projectName: 'proj',
      envName: 'prod',
      clusters: [{ envName: 'prod', kubeconfigPath: expect.stringMatching(/kubeconfig-prod$/) }],
    });
    expect(m.deploy.mock.calls[0][0].ghcrPull).toEqual({ mode: 'public' });
    expect(m.gate).toHaveBeenCalledWith({
      projectConfig: m.projectConfig,
      envName: 'prod',
      envConfig,
      yes: true,
      sides: ['prod'],
    });
    expect(said(m.outro)).toEqual([
      expect.stringContaining(
        'flux now pulls main into prod. push under k8s/ to deploy. after you change a secret, run vibecarbon deploy prod',
      ),
    ]);
  });

  it('in a terminal the gate may ask', async () => {
    setTTY(true);
    await run();
    expect(m.gate.mock.calls[0][0].yes).toBe(false);
  });

  it('a gate that stops the command stops it before anything is seeded or handed to Flux', async () => {
    // The real gate exits 1; a throw stands in for it.
    m.gate.mockRejectedValue(new Error('the firewall check failed'));
    await expect(run()).rejects.toThrow('the firewall check failed');
    expect(m.note).not.toHaveBeenCalled();
    expect(m.pull).not.toHaveBeenCalled();
    expect(m.deploy).not.toHaveBeenCalled();
  });
});

describe('configure cicd <k8s-ha env> hands over each side whose kubeconfig is here', () => {
  const PRIMARY = /\.vibecarbon\/kubeconfig-prod-primary$/;
  const STANDBY = /\.vibecarbon\/kubeconfig-prod-standby$/;

  it('with both per-side kubeconfigs it hands over both, with one pull credential', async () => {
    project(haEnvConfig, ['prod-primary', 'prod-standby']);
    await run();
    expect(m.order).toEqual(['gate', 'note', 'leftover', 'pull', 'deploy', 'deploy']);
    expect(m.pull).toHaveBeenCalledTimes(1);
    expect(m.pull.mock.calls[0][0].clusters).toEqual([
      { envName: 'prod-primary', kubeconfigPath: expect.stringMatching(PRIMARY) },
      { envName: 'prod-standby', kubeconfigPath: expect.stringMatching(STANDBY) },
    ]);
    expect(m.deploy.mock.calls.map(([a]) => [a.environment, a.kubeconfigPath])).toEqual([
      ['prod-primary', expect.stringMatching(PRIMARY)],
      ['prod-standby', expect.stringMatching(STANDBY)],
    ]);
    for (const [a] of m.deploy.mock.calls) expect(a.ghcrPull).toEqual({ mode: 'public' });
    expect(m.gate.mock.calls[0][0]).toMatchObject({
      envName: 'prod',
      sides: ['prod-primary', 'prod-standby'],
    });
    expect(m.leftover.mock.calls[0][0].envNames).toEqual(['prod-primary', 'prod-standby']);
    expect(said(m.log.warn)).toEqual([]);
    expect(said(m.outro)).toEqual([
      expect.stringContaining('flux now pulls main into prod-primary and prod-standby.'),
    ]);
  });

  it("with only the primary's it hands over the primary, and the warning and the outro name the standby as skipped", async () => {
    project(haEnvConfig, ['prod-primary']);
    await run();
    expect(m.deploy).toHaveBeenCalledTimes(1);
    expect(m.deploy.mock.calls[0][0]).toMatchObject({ environment: 'prod-primary' });
    // The gate, the notes and the pull credential cover the primary only.
    expect(m.gate.mock.calls[0][0].sides).toEqual(['prod-primary']);
    expect(m.leftover.mock.calls[0][0].envNames).toEqual(['prod-primary']);
    expect(m.pull.mock.calls[0][0].clusters).toEqual([
      { envName: 'prod-primary', kubeconfigPath: expect.stringMatching(PRIMARY) },
    ]);
    // Said once, before the gate: which side, why, and how to fetch it.
    expect(said(m.log.warn)).toEqual([
      'skipping prod-standby: its kubeconfig (.vibecarbon/kubeconfig-prod-standby) is not on ' +
        'this machine, so this run cannot reach that cluster. a deploy from here fetches it: ' +
        'vibecarbon deploy prod\nthen hand it over with: vibecarbon configure cicd prod',
    ]);
    const [outro] = said(m.outro);
    expect(outro).toContain('flux now pulls main into prod-primary.');
    expect(outro).toContain('prod-standby was skipped');
    expect(outro).not.toMatch(/into [^.]*prod-standby/);
    expect(outro).toMatch(/run vibecarbon deploy prod$/);
  });

  it('with neither it stops, naming both paths, with the command last', async () => {
    project(haEnvConfig, []);
    await expect(run()).rejects.toThrow(new Exit(1));
    const [message] = said(m.log.error);
    expect(message).toContain('.vibecarbon/kubeconfig-prod-primary');
    expect(message).toContain('.vibecarbon/kubeconfig-prod-standby');
    // The record already has the mode, so the command has no -mode flag.
    expect(message).toMatch(/: vibecarbon deploy prod$/);
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.pull).not.toHaveBeenCalled();
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it('a single k8s env with no kubeconfig stops the same way', async () => {
    rmSync(join(dir, '.vibecarbon', 'kubeconfig-prod'));
    await expect(run()).rejects.toThrow(new Exit(1));
    expect(said(m.log.error)).toEqual([
      expect.stringMatching(/\.vibecarbon\/kubeconfig-prod is missing.*: vibecarbon deploy prod$/),
    ]);
    expect(m.gate).not.toHaveBeenCalled();
  });
});

describe('configure cicd refuses what is wrong in the project before it asks anything', () => {
  it('a cluster file still on https refuses with no prompt, no gate and no pull token resolve', async () => {
    setTTY(true);
    const clusterFile = join(dir, 'k8s', 'flux', 'clusters', 'primary', 'vibecarbon.yaml');
    mkdirSync(join(clusterFile, '..'), { recursive: true });
    writeFileSync(
      clusterFile,
      [
        'apiVersion: source.toolkit.fluxcd.io/v1',
        'kind: GitRepository',
        'metadata:',
        '  name: vibecarbon',
        '  namespace: flux-system',
        'spec:',
        '  url: https://github.com/acme/proj',
        '',
      ].join('\n'),
    );
    await expect(run()).rejects.toThrow(new Exit(1));
    expect(said(m.log.error)).toEqual([
      expect.stringContaining('still has flux read your repo over https'),
    ]);
    expect(said(m.log.error)[0]).toContain('ssh://git@github.com/acme/proj');
    expect(m.prompt).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.note).not.toHaveBeenCalled();
    expect(m.leftover).not.toHaveBeenCalled();
    expect(m.pull).not.toHaveBeenCalled();
    expect(m.deploy).not.toHaveBeenCalled();
  });
});
