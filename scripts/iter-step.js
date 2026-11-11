#!/usr/bin/env node
/**
 * Pattern 2 iteration helper — re-runs a single CLI step against a kept
 * e2e rig.
 *
 * Workflow:
 *   1. Run the lifecycle once with `--keep` to stand up infra:
 *        pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --skip-steps failover,verify-failover --keep
 *      That skips the failing step, deploys + verifies, and writes a sentinel
 *      at tests/results/.rig-<provider>-<mode>.json instead of tearing down.
 *   2. Iterate the failing step against the surviving rig:
 *        node scripts/iter-step.js hetzner/k8s-ha failover
 *      Each call is timed, tee'd to
 *      tests/results/iter-<provider>-<mode>-<step>-<ts>.log, and exits
 *      non-zero on failure so xargs / shell loops can react.
 *   3. When done debugging, tear the rig down:
 *        node scripts/iter-step.js hetzner/k8s-ha destroy -purge
 *      After the destroy it runs the cleanup the lifecycle runs after its
 *      own final destroy, which --keep skipped in step 1: the provider's
 *      orphan sweep, deleting the throwaway GitHub repo, reaping local build
 *      images, then removing the rig file (tests/e2e/utils/rig-teardown.ts).
 *      -purge is required — plain destroy preserves the backup bucket by
 *      design (production recovery), so it gets none of that cleanup: the
 *      sweep would delete the very bucket it kept.
 *
 * The first argument is a QUALIFIED scenario token, the same `provider/mode`
 * identity the selection grammar uses (`--scenario hetzner/k8s-ha`). It is
 * required, not optional: two providers can keep a rig of the same mode
 * simultaneously, and guessing which one a bare `k8s-ha` meant would risk
 * pointing a `destroy` at the wrong live infra.
 *
 * Usage:
 *   node scripts/iter-step.js <provider>/<mode> <step> [extra-args...]
 * Examples:
 *   node scripts/iter-step.js hetzner/k8s-ha failover
 *   node scripts/iter-step.js digitalocean/compose-ha failover -dry
 *   node scripts/iter-step.js hetzner/k8s scale
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  e2eCliEnv,
  REPO_ROOT,
  resolveE2EAcmeCa,
  setupE2EEnv,
} from '../tests/e2e/utils/e2e-env.js';
import { E2EDbImageError } from '../tests/e2e/utils/db-image-select.js';
import { ensureStepDbImage, ITER_STEPS, isPurgeDestroy, iterStepCliArgs } from '../tests/e2e/utils/iter-step-args.js';

const VALID_STEPS = new Set(ITER_STEPS);

const [, , scenarioToken, step, ...extraArgs] = process.argv;

// Resolved from this file, not process.cwd() — iterating a step is usually
// done from the kept rig's project dir, not the repo root.
const repoRoot = REPO_ROOT;
const resultsDir = join(repoRoot, 'tests', 'results');

/**
 * Every kept rig currently on disk, as `provider/mode` tokens. Read from the
 * sentinels' own fields rather than parsed back out of the filename, so a
 * provider id containing a dash can never be mis-split.
 */
function listKeptRigs() {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((f) => f.startsWith('.rig-') && f.endsWith('.json'))
    .map((f) => {
      try {
        const rig = JSON.parse(readFileSync(join(resultsDir, f), 'utf-8'));
        return rig.provider && rig.mode ? `${rig.provider}/${rig.mode}` : f;
      } catch {
        return f;
      }
    })
    .sort();
}

function usage() {
  console.error('Usage: node scripts/iter-step.js <provider>/<mode> <step> [extra-args...]');
  console.error('  scenario: a qualified token, e.g. hetzner/k8s-ha or digitalocean/compose');
  console.error(`  steps: ${[...VALID_STEPS].join(' | ')}`);
  const rigs = listKeptRigs();
  console.error(
    rigs.length ? `  kept rigs available: ${rigs.join(', ')}` : '  kept rigs available: (none)',
  );
}

if (!scenarioToken || !step) {
  usage();
  process.exit(2);
}

// Qualified token required — see the header. A bare mode is rejected rather
// than resolved by guesswork: `hetzner/k8s` and `digitalocean/k8s` can be
// live at the same time, and `destroy` against the wrong one is not
// recoverable.
if (!scenarioToken.includes('/')) {
  console.error(
    `Scenario must be qualified as <provider>/<mode> — got '${scenarioToken}'. ` +
      `Same identity the runner uses (--scenario hetzner/${scenarioToken}).`,
  );
  usage();
  process.exit(2);
}
const [provider, mode] = scenarioToken.split('/');
if (!provider || !mode) {
  console.error(`Malformed scenario token '${scenarioToken}' — expected <provider>/<mode>.`);
  usage();
  process.exit(2);
}

if (!VALID_STEPS.has(step)) {
  console.error(`Unknown step: ${step}. Valid: ${[...VALID_STEPS].join(', ')}`);
  process.exit(2);
}

const rigPath = join(resultsDir, `.rig-${provider}-${mode}.json`);
if (!existsSync(rigPath)) {
  console.error(`No rig sentinel at ${rigPath}.`);
  const rigs = listKeptRigs();
  if (rigs.length) console.error(`Kept rigs available: ${rigs.join(', ')}`);
  console.error('Stand one up first:');
  console.error(
    `  pnpm test:e2e:batch -- --scenario ${provider}/${mode} --skip-steps ${step} --keep`,
  );
  process.exit(2);
}

let rig;
try {
  rig = JSON.parse(readFileSync(rigPath, 'utf-8'));
} catch (err) {
  console.error(`Failed to read rig sentinel ${rigPath}: ${err.message}`);
  process.exit(2);
}

const { projectDir, envPrefix, provider: rigProvider } = rig;
if (!projectDir || !envPrefix) {
  console.error(`Rig sentinel missing projectDir or envPrefix: ${JSON.stringify(rig)}`);
  process.exit(2);
}
// The sentinel carries its own `provider` (mandatory on every rig since
// tests/e2e/scenarios/types.ts made `ScenarioConfig.provider` mandatory) AND
// the filename encodes it. They must agree: a mismatch means the file was
// hand-edited or renamed, and the two halves disagree about which cloud this
// rig is running on — exactly the confusion a `destroy` must not act on.
// Re-create rather than guess, per the clean-break rule; no implicit
// 'hetzner' default here.
if (!rigProvider || rigProvider !== provider) {
  console.error(
    `Rig sentinel ${rigPath} says provider='${rigProvider ?? '(missing)'}' but its name says ` +
      `'${provider}' — stale or hand-edited rig, re-create it:`,
  );
  console.error(
    `  pnpm test:e2e:batch -- --scenario ${provider}/${mode} --skip-steps ${step} --keep`,
  );
  process.exit(2);
}
if (!existsSync(projectDir)) {
  console.error(`Rig project dir no longer exists: ${projectDir}`);
  console.error(`The rig was probably destroyed externally — re-create with --keep.`);
  process.exit(2);
}

const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const logDir = resultsDir;
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
// Provider in the name for the same reason it's in the sentinel's: two
// providers can be iterating the same mode+step at once.
const logPath = join(logDir, `iter-${provider}-${mode}-${step}-${ts}.log`);

// The env positional and `-y` only where the step's command declares them,
// plus backup's `-action create` default (tests/e2e/utils/iter-step-args.js).
const cliArgs = await iterStepCliArgs(step, envPrefix, extraArgs);

// Establish the SAME process environment tests/e2e/runner.ts does — public
// DNS pinning, ssh-askpass guards, the Let's Encrypt STAGING ACME directory,
// the operator's tests/.env.e2e tokens, and explicit trust of the LE staging
// roots. Iterating a step used to run without any of it: deploys burned the
// production LE rate limit (5 certs/week/identifier) and the health probe
// failed for want of the runner's TLS setup, which cost real debugging time
// during the M3 battery until someone prefixed the env by hand.
const { envFileKeys, tls: tlsSetup } = setupE2EEnv();

// ...and the same db image choice as the runner: the release tag, or this
// branch's dev channel build when the release is not published yet (sets
// VIBECARBON_DB_IMAGE, which e2eCliEnv hands to the child). Fails before the
// step runs rather than deploying an image the tree does not match. Steps that
// never pull it (destroy, status, diagnose) skip the check, so tearing a rig
// down works with ghcr.io unreachable.
try {
  await ensureStepDbImage(step);
} catch (err) {
  if (!(err instanceof E2EDbImageError)) throw err;
  console.error(`[iter] e2e db image: ${err.message}`);
  process.exit(1);
}

console.log(`[iter] scenario=${provider}/${mode} step=${step} env=${envPrefix}`);
console.log(`[iter] projectDir=${projectDir}`);
console.log(`[iter] log=${logPath}`);
console.log(
  `[iter] env: ACME=${resolveE2EAcmeCa().ca}` +
    `${tlsSetup ? `, ${tlsSetup.rootCount} LE staging roots trusted` : ''}` +
    `${envFileKeys.length ? `, ${envFileKeys.length} key(s) from tests/.env.e2e` : ''}`,
);
console.log(`[iter] cmd=vibecarbon ${cliArgs.join(' ')}`);

const startedAt = Date.now();
const logStream = createWriteStream(logPath);
const cliBin = join(repoRoot, 'src', 'cli.js');

// Child env comes from the same builder cli-runner.ts uses, so this step runs
// exactly as it would inside a full lifecycle run. REAL_INFRA is the runner's
// safety gate (set by the `pnpm test:e2e*` scripts); iterating a step against
// an already-live rig is by definition a real-infra operation.
const child = spawn('node', [cliBin, ...cliArgs], {
  cwd: projectDir,
  env: e2eCliEnv({ REAL_INFRA: 'true' }, process.env, provider),
  stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
});

child.on('close', async (destroyOrStepCode) => {
  let code = destroyOrStepCode ?? 1;
  // `destroy` exit 2 is its own verdict: the teardown RAN but left resources
  // behind (see src/lib/destroy/leak-ledger.js). Reporting that as a bare FAIL
  // sends the operator hunting for a crash that never happened — the leak
  // report is already above this line in the log, and the fix is to go delete
  // what it names, not to re-run the step.
  let verdict = code === 0 ? 'PASS' : step === 'destroy' && code === 2 ? 'LEAKED' : 'FAIL';
  const log = (line) => {
    process.stdout.write(`${line}\n`);
    logStream.write(`${line}\n`);
  };
  if (await isPurgeDestroy(step, extraArgs)) {
    try {
      // tsx loads the TypeScript sweeps from this plain-node script.
      const { tsImport } = await import('tsx/esm/api');
      const { finishRigTeardown } = await tsImport(
        '../tests/e2e/utils/rig-teardown.ts',
        import.meta.url,
      );
      ({ verdict, exitCode: code } = await finishRigTeardown({
        rig,
        rigPath,
        destroyExit: code,
        env: process.env,
        log,
      }));
    } catch (err) {
      log(`[iter] UNVERIFIED: the post-destroy cleanup failed: ${err?.message ?? err}`);
      verdict = 'UNVERIFIED';
      code = 2;
    }
  }
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = `[iter] ${verdict} scenario=${provider}/${mode} step=${step} elapsed=${elapsedS}s exit=${code}\n`;
  process.stdout.write(summary);
  logStream.write(summary);
  if (verdict === 'LEAKED') {
    const note = `[iter] destroy completed but leaked — grep the log above for '^\\s*LEAK' / 'UNVERIFIED'\n`;
    process.stdout.write(note);
    logStream.write(note);
  }
  // The step's own exit code, or the teardown's after a purge destroy, so
  // shell loops keep reacting.
  logStream.end(() => process.exit(code));
});
