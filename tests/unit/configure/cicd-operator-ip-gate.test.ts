/**
 * `configure cicd <k8s env>` reaches the k8s API from this machine, so it
 * lets the operator's address through the firewall first
 * (requireEnvOperatorIpAccess), before any GitOps step. A gate that stops
 * the command stops it before anything is seeded or handed to Flux, and a
 * run with no terminal is headless (`yes`), as `deploy -y` is.
 *
 * Drives the real runConfigureCicd in a temp project: Stage 1's GitHub calls,
 * the gate and the GitOps module are fakes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const m = vi.hoisted(() => ({
  order: [] as string[],
  projectConfig: {} as Record<string, unknown>,
  gate: vi.fn(),
  deploy: vi.fn(),
  note: vi.fn(),
}));

vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['info', 'step', 'success', 'warn', 'error'],
    spinner: true,
    fns: ['intro', 'outro', 'note'],
  }),
);
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => m.projectConfig,
}));
vi.mock('../../../src/lib/version-channel.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useRecordedImageSet: () => {},
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
  installDeployWorkflowFile: () => false,
  installWorkflowFile: () => false,
  updateImageReferences: () => {},
}));
vi.mock('../../../src/lib/operator-ip-gate.js', () => ({ requireEnvOperatorIpAccess: m.gate }));
vi.mock('../../../src/lib/deploy/app-storage-credential.js', () => ({
  localAppStorageSecrets: () => ({}),
  storedAppStoragePair: async () => ({ accessKey: 'a', secretKey: 'b' }),
}));
vi.mock('../../../src/lib/deploy/k8s/gitops-deploy.js', () => ({
  deployK8sGitOps: m.deploy,
  gitopsTargets: (envName: string) => [{ suffix: null, envName, role: 'primary' }],
  noteUnreadTokenSecrets: m.note,
}));

const { runConfigureCicd } = await import('../../../src/configure.js');

const envConfig = {
  status: 'deployed',
  provider: 'hetzner',
  deployMode: 'kubernetes',
  region: 'nbg1',
  domain: 'app.example.test',
};

let cwd: ReturnType<typeof vi.spyOn>;
const ttyWas = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const setTTY = (value: boolean | undefined) =>
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });

beforeEach(() => {
  m.order.length = 0;
  vi.clearAllMocks();
  const dir = createTempDir('vc-cicd-gate-');
  m.projectConfig = { projectName: 'proj', environments: { prod: envConfig } };
  writeFileSync(join(dir, '.vibecarbon.json'), `${JSON.stringify(m.projectConfig)}\n`);
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  writeFileSync(join(dir, '.vibecarbon', 'kubeconfig-prod'), 'apiVersion: v1\n');
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  m.gate.mockImplementation(async () => {
    m.order.push('gate');
  });
  m.note.mockImplementation(async () => {
    m.order.push('note');
    return [];
  });
  m.deploy.mockImplementation(async () => {
    m.order.push('deploy');
    return { pushed: true };
  });
});

afterEach(() => {
  cwd.mockRestore();
  if (ttyWas) Object.defineProperty(process.stdin, 'isTTY', ttyWas);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('configure cicd <k8s env> lets the operator in first', () => {
  it('gates the environment before any GitOps step, headless without a terminal', async () => {
    setTTY(undefined);
    await runConfigureCicd('prod');
    expect(m.order).toEqual(['gate', 'note', 'deploy']);
    expect(m.gate).toHaveBeenCalledWith({
      projectConfig: m.projectConfig,
      envName: 'prod',
      envConfig,
      yes: true,
    });
  });

  it('in a terminal the gate may ask', async () => {
    setTTY(true);
    await runConfigureCicd('prod');
    expect(m.gate.mock.calls[0][0].yes).toBe(false);
  });

  it('a gate that stops the command stops it before anything is seeded or handed to Flux', async () => {
    // The real gate exits 1; a throw stands in for it.
    m.gate.mockRejectedValue(new Error('the firewall check failed'));
    await expect(runConfigureCicd('prod')).rejects.toThrow('the firewall check failed');
    expect(m.note).not.toHaveBeenCalled();
    expect(m.deploy).not.toHaveBeenCalled();
  });
});
