/**
 * Template lockstep in every command that ships or applies the scaffold, or
 * moves the wal-g role (B9). deploy is pinned in preflight-role-file.test.ts;
 * this file drives the real run() of scale, restore, failover and
 * `configure cicd <k8s env>` in a project whose walg-env.sh predates the role
 * file, and checks each one refuses with the one line naming
 * `vibecarbon upgrade`, before its first remote or cloud call.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTemplate } from '../helpers/copy-template.js';

const errors: string[] = [];
const infos: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note() {},
    outro() {},
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info: (m: string) => infos.push(m),
      warn() {},
      step: (m: string) => infos.push(m),
      success() {},
      message() {},
      error: (m: string) => errors.push(m),
    },
  };
});

let projectConfig: Record<string, unknown> = {};
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => projectConfig,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));

/** Every remote or cloud entry point a command reaches first, as a recorder. */
const remote = vi.hoisted(() => ({
  operatorIp: vi.fn(async () => ({ added: false })),
  retiredFence: vi.fn(async () => ({ fenced: [], unreachable: [] })),
  ssh: vi.fn(async () => ''),
  command: vi.fn(() => ''),
}));
class ReachedRemote extends Error {}
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: async (...a: unknown[]) => {
    remote.operatorIp(...a);
    throw new ReachedRemote('operator-ip');
  },
}));
vi.mock('../../../src/lib/deploy/retired-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  reconcileRetiredFence: remote.retiredFence,
}));
vi.mock('../../../src/lib/ssh.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  sshRun: remote.ssh,
}));
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  sshRun: remote.ssh,
  sshRunAsync: remote.ssh,
  sshRunChecked: remote.ssh,
}));
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommand: remote.command,
  checkDependency: remote.command,
}));

const REFUSAL =
  "This project's scaffold predates the wal-g role file. Run `vibecarbon upgrade`, then deploy again.";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
/** A copy of the shipped scaffold whose walg-env.sh lacks the role parser. */
async function staleProject() {
  const { WALG_ROLE_PARSE_SH } = await import('../../../src/lib/deploy/walg-role.js');
  const dir = mkdtempSync(join(tmpdir(), 'vc-stale-scaffold-'));
  dirs.push(dir);
  copyTemplate(dir);
  const env = join(dir, 'volumes/db/walg-env.sh');
  writeFileSync(env, readFileSync(env, 'utf-8').replace(WALG_ROLE_PARSE_SH, ''));
  return dir;
}

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}
const composeHa = () => ({
  status: 'deployed',
  provider: 'hetzner',
  deployMode: 'compose-ha',
  region: 'nbg1',
  ha: { enabled: true },
  servers: [
    { id: 1, role: 'primary', ip: '203.0.113.10', region: 'nbg1' },
    { id: 2, role: 'standby', ip: '203.0.113.11', region: 'ash' },
  ],
});
const k8sHa = () => ({
  status: 'deployed',
  provider: 'hetzner',
  deployMode: 'kubernetes',
  region: 'nbg1',
  ha: {
    enabled: true,
    primary: { masterIp: '203.0.113.20', region: 'nbg1' },
    standby: { masterIp: '203.0.113.21', region: 'ash' },
  },
});

beforeEach(async () => {
  errors.length = 0;
  infos.length = 0;
  for (const fn of Object.values(remote)) fn.mockClear();
  const dir = await staleProject();
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  // A provider token is on hand, so each command WOULD refresh the operator-IP
  // firewall (its first remote change) if the refusal did not come first.
  vi.stubEnv('HETZNER_API_TOKEN', 'a'.repeat(64));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function expectRefusedBeforeRemote(run: () => Promise<unknown>) {
  const err = await run().then(
    () => undefined,
    (e) => e,
  );
  expect(err, `expected exit 1, got ${err}`).toBeInstanceOf(Exit);
  expect((err as Exit).code).toBe(1);
  expect(errors).toEqual([REFUSAL]);
  for (const [name, fn] of Object.entries(remote)) {
    expect(fn, `${name} was reached before the refusal`).not.toHaveBeenCalled();
  }
}

describe('a scaffold that predates the wal-g role file', () => {
  it.each([
    ['compose-ha', composeHa],
    ['k8s-ha', k8sHa],
  ])('scale (%s) refuses before any remote call', async (_tier, env) => {
    projectConfig = { projectName: 'proj', environments: { prod: env() } };
    const { run } = await import('../../../src/scale.js');
    await expectRefusedBeforeRemote(() => run(['prod', '-y', '-type', 'cpx32']));
  });

  it.each([
    ['compose-ha', composeHa],
    ['k8s-ha', k8sHa],
  ])('restore (%s) refuses before the bucket read or any remote call', async (_tier, env) => {
    projectConfig = { projectName: 'proj', environments: { prod: env() } };
    const resolveS3Config = vi.fn();
    const createS3Client = vi.fn();
    const { run } = await import('../../../src/restore.js');
    await expectRefusedBeforeRemote(() =>
      run(['prod', '-y', '-source', 'latest'], { resolveS3Config, createS3Client }),
    );
    expect(resolveS3Config).not.toHaveBeenCalled();
    expect(createS3Client).not.toHaveBeenCalled();
  });

  it.each([
    ['compose-ha', composeHa],
    ['k8s-ha', k8sHa],
  ])(
    'failover (%s) refuses before the firewall refresh or the retirement fence',
    async (_t, env) => {
      projectConfig = { projectName: 'proj', environments: { prod: env() } };
      const { run } = await import('../../../src/failover.js');
      await expectRefusedBeforeRemote(() => run(['prod', '-y']));
    },
  );

  it('failover resumed from its journal is let finish (it already promoted)', async () => {
    const env = composeHa() as ReturnType<typeof composeHa> & { ha: Record<string, unknown> };
    env.ha.failoverInFlight = { attemptId: 'a1', startedAt: '2026-11-01T00:00:00Z' };
    projectConfig = { projectName: 'proj', environments: { prod: env } };
    const { run } = await import('../../../src/failover.js');
    // HETZNER_API_TOKEN set, so the first remote step is the firewall refresh.
    const err = await run(['prod', '-y']).catch((e) => e);
    expect(errors).not.toContain(REFUSAL);
    expect(err).toBeInstanceOf(Exit); // the stubbed firewall refresh failed it
    expect(remote.operatorIp).toHaveBeenCalled();
  });

  it('configure cicd <k8s env> refuses before Stage 1 installs the workflow that applies k8s/', async () => {
    projectConfig = { projectName: 'proj', environments: { prod: k8sHa() } };
    const { runConfigureCicd } = await import('../../../src/configure.js');
    await expectRefusedBeforeRemote(() => runConfigureCicd('prod'));
    expect(infos.join('\n')).not.toMatch(/Stage 1|CI\/CD \(GitHub Actions\)/);
  });

  it('configure cicd <compose env> does not check (its CI applies no project manifests)', async () => {
    projectConfig = { projectName: 'proj', environments: { prod: composeHa() } };
    const { runConfigureCicd } = await import('../../../src/configure.js');
    await runConfigureCicd('prod').catch(() => {});
    expect(errors).not.toContain(REFUSAL);
  });
});
