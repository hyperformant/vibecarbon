/**
 * What a kept rig's teardown runs after `vibecarbon destroy -purge`, so
 * `scripts/iter-step.js <rig> destroy -purge` cleans up as the lifecycle's own
 * final cleanup does: the provider's orphan sweep, the throwaway GitHub repo,
 * and the local build images. It used to stop at the destroy. On Linode that
 * left a rig's unread CSI volumes and its public test repo on the account,
 * with nothing to say so (2026-11-08).
 *
 * Only after a destroy that ran to its end (exit 0, or 2 for "ran but left
 * resources"). A destroy that crashed keeps everything, the rig file too, for
 * the operator to read. And only for `-purge`: plain destroy keeps the backup
 * bucket on purpose, and the sweep would delete it.
 */
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { testConfig } from '../../config.js';
import { reapLocalBuildArtifacts } from './local-artifacts.js';
import { orphanTotal, type ProjectSweep, sweepProjectOrphans } from './sweep-provider.js';

export interface KeptRig {
  provider: string;
  projectName: string;
  repoSlug?: string | null;
}

export type RigTeardownVerdict = 'PASS' | 'LEAKED' | 'UNVERIFIED' | 'FAIL';

export interface RigTeardownDeps {
  sweep: typeof sweepProjectOrphans;
  deleteRepo: (slug: string) => Promise<void>;
  reap: (tag: string, projectName: string) => Promise<void>;
  removeRigFile: (path: string) => void;
}

const run = promisify(execFile);

const defaultDeps: RigTeardownDeps = {
  sweep: sweepProjectOrphans,
  deleteRepo: async (slug) => {
    await run('gh', ['repo', 'delete', slug, '--yes'], { timeout: 60_000 });
  },
  reap: reapLocalBuildArtifacts,
  removeRigFile: (path) => rmSync(path, { force: true }),
};

/** The env var holding a provider's compute token, from the provider registry. */
export function computeTokenEnvFor(provider: string): string | undefined {
  const providers: Record<string, { computeTokenEnv?: string }> = testConfig.e2e.providers;
  return providers[provider]?.computeTokenEnv;
}

/**
 * @param o.destroyExit - the destroy's own exit code
 * @param o.log - one line of output (iter-step writes it to stdout and its log)
 * @returns the step's verdict and the exit code iter-step leaves with
 */
export async function finishRigTeardown(o: {
  rig: KeptRig;
  rigPath: string;
  destroyExit: number;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  deps?: Partial<RigTeardownDeps>;
}): Promise<{ verdict: RigTeardownVerdict; exitCode: number }> {
  const { rig, rigPath, destroyExit, env, log } = o;
  const deps = { ...defaultDeps, ...o.deps };
  const tag = '[iter]';

  if (destroyExit !== 0 && destroyExit !== 2) {
    log(`${tag} destroy did not finish: nothing swept, rig file kept (${rigPath})`);
    return { verdict: 'FAIL', exitCode: destroyExit };
  }

  // The scenario's own provider token, never another provider's.
  const tokenEnv = computeTokenEnvFor(rig.provider);
  const token = tokenEnv ? env[tokenEnv] : undefined;
  let sweep: ProjectSweep | null = null;
  if (!token) {
    log(
      `${tag} UNVERIFIED: no ${tokenEnv ?? `compute token for provider '${rig.provider}'`} in the environment, so the orphan sweep did not run`,
    );
  } else {
    sweep = await deps.sweep({
      tag,
      provider: rig.provider,
      projectName: rig.projectName,
      token,
      env,
    });
  }

  // Non-fatal, as in the lifecycle's teardown-repo step: a repo already gone
  // or a token without delete scope is a note, not a failed teardown.
  if (rig.repoSlug) {
    try {
      await deps.deleteRepo(rig.repoSlug);
      log(`${tag} deleted the test repo ${rig.repoSlug}`);
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log(`${tag} could not delete the test repo ${rig.repoSlug} (non-fatal): ${why}`);
    }
  }

  await deps.reap(tag, rig.projectName);

  if (!sweep || sweep.enumFailed) {
    if (sweep) log(`${tag} UNVERIFIED: the orphan sweep could not read every list to its end`);
    log(`${tag} rig file kept, since residue cannot be ruled out (${rigPath})`);
    return { verdict: 'UNVERIFIED', exitCode: 2 };
  }

  // Swept clean or swept what the destroy left: either way the rig is gone.
  deps.removeRigFile(rigPath);
  const found = orphanTotal(sweep.counts);
  if (found > 0) {
    log(
      `${tag} LEAK: the destroy left ${found} resource(s) that the sweep then deleted: ${JSON.stringify(sweep.counts)}`,
    );
    return { verdict: 'LEAKED', exitCode: 2 };
  }
  if (destroyExit === 2) return { verdict: 'LEAKED', exitCode: 2 };
  return { verdict: 'PASS', exitCode: 0 };
}
