/**
 * Cached `vibecarbon create` output, cloned per test.
 *
 * Synthetic fixtures don't match what users actually have. Every test
 * in tests/integration/cli/ runs against a real `vibecarbon create`
 * tree — same ~200 files, same template overrides, same package.json
 * scripts that real users hit.
 *
 * To keep cost reasonable: `vibecarbon create` runs ONCE per process
 * (~10s), the resulting project is cached, and each test gets a fresh
 * clone via `cp -a` (~50ms). Tests can then mutate the clone freely
 * without affecting other tests.
 *
 * Per-test customization (deployMode, multi-env, no-git) is applied
 * to the clone after copy — way cheaper than re-running create with
 * different args.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pmScrubbedEnv } from '../../_shared/pm-env.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.js');

export type DeployMode = 'compose' | 'compose-ha' | 'k8s' | 'k8s-ha';

export interface RealProjectOptions {
  /**
   * Set deployMode in .vibecarbon.json. Default: leaves whatever
   * `vibecarbon create` writes (compose).
   */
  deployMode?: DeployMode;
  /**
   * If false, removes .git after cloning. Default true (= keeps git
   * state from cached project, which itself was created without -git).
   */
  git?: boolean;
  /**
   * Environment names to populate in .vibecarbon.json under `envs`.
   * Default: ['prod'].
   */
  envs?: string[];
  /**
   * If true, pre-populates .vibecarbon/<env>.json as if a deploy
   * already succeeded. Needed for destroy / scale / failover / backup
   * tests.
   */
  withDeployedState?: boolean;
}

/** Process-wide cache. Populated by ensureCached(); cleaned up by `vitest`'s
 * tmpdir cleanup (the parent dir is in the OS tmpdir, so worst case the
 * OS reaps it). */
let cachedProjectPath: string | null = null;

/**
 * Run `vibecarbon create` once per process. Subsequent calls return the
 * same path. Synchronous since execFileSync blocks anyway.
 */
function ensureCached(): string {
  if (cachedProjectPath) return cachedProjectPath;
  const parent = mkdtempSync(join(tmpdir(), 'vc-real-cache-'));
  // The cached project would otherwise come out pnpm-based when run through
  // `pnpm test:integration` and npm-based when vitest is invoked directly — the
  // fixture would silently depend on how you started the run. See the module
  // doc on pmScrubbedEnv.
  const cleanEnv = pmScrubbedEnv();
  execFileSync(
    process.execPath,
    [
      CLI_PATH,
      'create',
      'test-app',
      '-y',
      '-skip-lockfile',
      '-admin-email',
      'test@example.com',
      '-admin-password',
      'testpass123',
    ],
    {
      cwd: parent,
      // eslint-disable-next-line no-restricted-syntax
      stdio: ['ignore', 'ignore', 'pipe'],
      // No -pm: the cached project must mirror what a customer gets, which
      // is npm. -skip-lockfile drops the `npm install --package-lock-only`
      // step that dominates create's wall time under parallel-suite load. No
      // realProject caller asserts lockfile presence — they exercise
      // CLI help/dry-run/state-file paths, not actual deploys. 60s is
      // plenty for pure scaffolding (~3-5s observed).
      timeout: 60_000,
      env: {
        ...cleanEnv,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    },
  );
  cachedProjectPath = join(parent, 'test-app');
  return cachedProjectPath;
}

/**
 * Clone the cached project to a fresh tmp dir and apply per-test
 * customizations. Each call returns a unique path that the caller
 * owns and should pass to destroyRealProject() in afterEach.
 */
export function realProject(opts: RealProjectOptions = {}): string {
  const cached = ensureCached();
  const parent = mkdtempSync(join(tmpdir(), 'vc-real-'));
  const clonePath = join(parent, 'app');
  // cp -a preserves perms + ownership + symlinks. Recursive by default.
  execFileSync('cp', ['-a', cached, clonePath], { stdio: 'ignore' });

  // Apply customizations to the clone.
  const configPath = join(clonePath, '.vibecarbon.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (opts.deployMode) {
    config.deployMode = opts.deployMode;
  }
  if (opts.envs) {
    config.envs = Object.fromEntries(
      opts.envs.map((env) => [env, { region: 'nbg1', domain: `${env}.example.com` }]),
    );
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  if (opts.git === false) {
    rmSync(join(clonePath, '.git'), { recursive: true, force: true });
  }

  if (opts.withDeployedState) {
    const envs = opts.envs ?? ['prod'];
    const stateDir = join(clonePath, '.vibecarbon');
    execFileSync('mkdir', ['-p', stateDir]);
    for (const env of envs) {
      const state = {
        environment: env,
        deployedAt: '2026-05-07T00:00:00.000Z',
        outputs: {
          serverIp: '10.0.0.1',
          floatingIp: '10.0.0.2',
          domain: `${env}.example.com`,
        },
      };
      writeFileSync(join(stateDir, `${env}.json`), `${JSON.stringify(state, null, 2)}\n`);
    }
  }

  return clonePath;
}

/** Remove the clone and its parent tmp dir. */
export function destroyRealProject(path: string): void {
  // path is <parent>/app — remove the parent so we don't leak tmp dirs.
  rmSync(dirname(path), { recursive: true, force: true });
}
