/**
 * Helpers for managing GitHub Environments + secrets/vars on the customer's
 * repo. Used by Phase 4.3b of the GitOps refactor — the deploy workflow
 * (.github/workflows/deploy.yml) reads per-environment `${{ secrets.X }}`
 * + `${{ vars.Y }}` to apply the vibecarbon-secrets Secret, the cert-manager
 * `hetzner` Secret (DNS-01 webhook token), and the kube-system/hcloud Secret
 * into the cluster.
 *
 * All calls go through the `gh` CLI (argv form, no shell interpolation) so
 * secret values never leak through ps/logs/shell history. Secret upload
 * pipes the value through stdin — `gh secret set NAME` (no --body) reads
 * stdin — to keep the value off argv.
 *
 * Decision: secret scope (1=org/repo-level, 2=per-environment) matches
 * the session 2026-04-20 discussion:
 *   Org-level:       HETZNER_API_TOKEN, CLOUDFLARE_API_TOKEN,
 *                    S3_ACCESS_KEY, S3_SECRET_KEY
 *   Per-env:         KUBECONFIG_B64, DB_PASSWORD, JWT_SECRET,
 *                    SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *                    REALTIME_SECRET, DB_ENC_KEY, VAULT_ENC_KEY,
 *                    PG_META_CRYPTO_KEY, LOGFLARE_API_KEY,
 *                    ADMIN_EMAIL, ADMIN_PASSWORD, SMTP_*
 *   Per-env vars:    HCLOUD_NETWORK_ID, SITE_URL, DNS_PROVIDER
 */

import { runCommandAsync } from './command.js';
import { DNS_PROVIDERS } from './dns-provider.js';

/**
 * Get the current repo's `owner/name` from the gh CLI. Relies on a git
 * remote being configured (which `vibecarbon create` sets up).
 */
async function getRepoSlug() {
  const out = await runCommandAsync(
    ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { silent: true },
  );
  return out.toString().trim();
}

/**
 * Ensure a GitHub Environment exists on the customer's repo. Idempotent.
 * `gh api -X PUT` creates if missing, no-op if present.
 */
export async function ensureEnvironment(envName) {
  const repo = await getRepoSlug();
  await runCommandAsync(['gh', 'api', `repos/${repo}/environments/${envName}`, '-X', 'PUT'], {
    silent: true,
  });
}

/**
 * Set a secret value via `gh secret set`, piping the value through stdin.
 *
 * Pipes stdin instead of passing the value on argv — `gh secret set NAME`
 * (no --body) reads from stdin. Previously used `--body-file <path>` but
 * that flag was removed from `gh` (verified 2026-04-22: only `-b/--body`,
 * `-f/--env-file`, and stdin remain). Stdin has the same security
 * properties as a 0600 temp file — never on argv, never on disk.
 *
 * `env` = undefined → repo-level secret; `env` = "prod" → environment-level.
 *
 * Returns false if the value is empty (skips the call — GH rejects empty
 * secrets). True on successful write.
 */
async function setSecretFromBodyFile(key, value, env) {
  if (!value) return false;
  const args = ['gh', 'secret', 'set', key];
  if (env) args.push('--env', env);
  await runCommandAsync(args, { silent: true, input: value });
  return true;
}

/**
 * Set a variable (non-secret) value. `gh variable set` doesn't support
 * --body-file, so the value goes on argv. Acceptable since these are
 * non-secret (network IDs, URLs).
 */
async function setVariable(key, value, env) {
  if (value === undefined || value === null || value === '') return false;
  const args = ['gh', 'variable', 'set', key, '--body', String(value)];
  if (env) args.push('--env', env);
  await runCommandAsync(args, { silent: true });
  return true;
}

/**
 * Seed the org-level (repo-level) secrets. Called once per repo — values
 * are shared across all environments. If any are already set, they're
 * overwritten (rotation path).
 *
 * @param {object} [providerCreds] - Flat operator-secret values, resolved
 *   from process.env by the caller (configure.js) — see config-registry.js's
 *   operator-secret class.
 * @param {string} [providerCreds.hetznerApiToken]
 * @param {Record<string, string>} [providerCreds.dnsTokens] - DNS token
 *   candidates keyed by env-var name, registry-derived from DNS_PROVIDERS
 *   (empty values are skipped; native rows share the compute token's env
 *   var, so seeding stays deduped).
 * @param {string} [providerCreds.s3AccessKey]
 * @param {string} [providerCreds.s3SecretKey]
 */
export async function seedOrgSecrets(providerCreds = {}) {
  const applied = [];
  if (await setSecretFromBodyFile('HETZNER_API_TOKEN', providerCreds.hetznerApiToken ?? ''))
    applied.push('HETZNER_API_TOKEN');
  // DNS tokens, one candidate per DNS_PROVIDERS row — the pre-convergence
  // hand-list seeded CLOUDFLARE_API_TOKEN only, so any other DNS backend's
  // CI/CD deploy couldn't authenticate its solver (seam-audit hazard H18).
  for (const row of Object.values(DNS_PROVIDERS)) {
    if (applied.includes(row.tokenEnv)) continue;
    if (await setSecretFromBodyFile(row.tokenEnv, providerCreds.dnsTokens?.[row.tokenEnv] ?? ''))
      applied.push(row.tokenEnv);
  }
  if (await setSecretFromBodyFile('S3_ACCESS_KEY', providerCreds.s3AccessKey ?? ''))
    applied.push('S3_ACCESS_KEY');
  if (await setSecretFromBodyFile('S3_SECRET_KEY', providerCreds.s3SecretKey ?? ''))
    applied.push('S3_SECRET_KEY');
  return applied;
}

/**
 * Seed repo-level GitHub Actions variables that the build workflow
 * (vibecarbon-build.yml) reads as `--build-arg` inputs. Vite inlines these
 * VITE_* values into the browser bundle at image-build time; without them the
 * CI-built GHCR image ships empty VITE_SUPABASE_* and crashes at page load
 * ("Missing Supabase environment variables").
 *
 * These are non-secret build inputs (VITE_SUPABASE_ANON_KEY is a publishable
 * client key shipped to browsers), so they go to repo VARIABLES, not secrets.
 * Repo-level (not per-environment) because vibecarbon-build.yml builds one
 * push-triggered image per repo — it reflects the most recent push-mode
 * deploy's domain/config. Multi-domain setups should use local-build deploys
 * for non-canonical environments.
 *
 * Empty values are skipped (setVariable returns false) so optional VITE_*
 * (e.g. unconfigured analytics) don't create blank variables.
 *
 * @param {Record<string,string>} viteArgs - VITE_* build args (from collectComposeBuildArgs).
 * @returns {Promise<string[]>} applied variable names.
 */
export async function seedBuildVars(viteArgs) {
  const applied = [];
  for (const [key, value] of Object.entries(viteArgs)) {
    if (!key.startsWith('VITE_')) continue;
    if (await setVariable(key, value)) applied.push(key);
  }
  return applied;
}

/**
 * Seed the per-environment secrets + variables. `envVars` are sourced from
 * .env.local (read by the caller) so we can re-use the same values as the
 * imperative deploy path sources.
 *
 * @param {string} envName - "dev" | "staging" | "prod"
 * @param {object} secrets - Key-value map of secret names → values.
 * @param {object} vars - Key-value map of variable names → values.
 */
export async function seedEnvironmentSecrets(envName, secrets, vars = {}) {
  await ensureEnvironment(envName);

  const appliedSecrets = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (await setSecretFromBodyFile(key, value, envName)) appliedSecrets.push(key);
  }

  const appliedVars = [];
  for (const [key, value] of Object.entries(vars)) {
    if (await setVariable(key, value, envName)) appliedVars.push(key);
  }
  return { secrets: appliedSecrets, vars: appliedVars };
}

/**
 * Upload the cluster kubeconfig as a base64-encoded env secret. The deploy
 * workflow base64-decodes it with `printf ... | base64 -d` into a file and
 * points `$KUBECONFIG` at it. Base64 is used (rather than raw YAML) because
 * the downstream shell interpolation needs a single-line value.
 */
export async function uploadKubeconfig(envName, kubeconfigPath) {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(kubeconfigPath, 'utf-8');
  const b64 = Buffer.from(raw, 'utf-8').toString('base64');
  await ensureEnvironment(envName);
  await setSecretFromBodyFile('KUBECONFIG_B64', b64, envName);
}

/**
 * Trigger the customer's deploy workflow for a given environment and
 * optionally wait for it to complete. `gh workflow run` fires it; the
 * workflow's concurrency group serializes per-env so only one runs at a
 * time.
 */
export async function triggerDeployWorkflow(envName) {
  await runCommandAsync(
    ['gh', 'workflow', 'run', 'deploy.yml', '--ref', 'main', '-F', `environment=${envName}`],
    { silent: true },
  );
}

/**
 * Block until the most recent run of deploy.yml completes. Polls
 * `gh run list` every 5s; surfaces the final status when done.
 */
export async function waitForLatestWorkflowRun(timeoutSec = 1800) {
  const deadline = Date.now() + timeoutSec * 1000;
  const startedAt = Date.now();
  // Give GitHub a couple seconds to register the run before we poll.
  await new Promise((r) => setTimeout(r, 3000));
  // Periodic state snapshot — every 2 min, log which workflow step is
  // currently in-progress. Without this, a 60-minute wait is a black
  // box; with it, the deploy log shows where the workflow spent its
  // time. Captured by the deploy logger (#6) so it persists past
  // teardown. Snapshot every ~24th poll (5s × 24 = 120s) — short enough
  // to catch a mid-step hang, long enough to not spam.
  let lastSnapshotAt = 0;
  while (Date.now() < deadline) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (Date.now() - lastSnapshotAt >= 120_000) {
      try {
        const stateOut = await runCommandAsync(
          [
            'gh',
            'run',
            'list',
            '--workflow',
            'deploy.yml',
            '--limit',
            '1',
            '--json',
            'databaseId,status,conclusion,jobs',
          ],
          { silent: true, ignoreError: true },
        );
        if (stateOut) {
          const info = JSON.parse(stateOut.toString())[0];
          const jobs = (info?.jobs ?? [])
            .map((j) => {
              const inFlight =
                j.steps?.find((s) => s.status === 'in_progress')?.name ??
                (j.status === 'completed' ? `(done: ${j.conclusion})` : `(${j.status})`);
              return `    ${j.name}: ${inFlight}`;
            })
            .join('\n');
          console.log(
            `[wait ${elapsed}s] deploy.yml run=${info?.databaseId ?? '?'} status=${info?.status ?? '?'}\n${jobs}`,
          );
        }
      } catch {
        /* snapshot is best-effort — never break the wait */
      }
      lastSnapshotAt = Date.now();
    }
    const out =
      (
        await runCommandAsync(
          [
            'gh',
            'run',
            'list',
            '--workflow',
            'deploy.yml',
            '--limit',
            '1',
            '--json',
            'status,conclusion,databaseId',
          ],
          { silent: true, ignoreError: true },
        )
      )?.toString() ?? '[]';
    let run;
    try {
      run = JSON.parse(out)[0];
    } catch {
      run = null;
    }
    if (run?.status === 'completed') {
      if (run.conclusion === 'success') return { ok: true, runId: run.databaseId };
      // Fetch the failing-step log inline so the caller has something to
      // act on. The throwaway repo used by e2e tests is destroyed
      // right after a failure; post-mortem `gh run view` then 404s. Even
      // outside e2e, surfacing the actual failure at throw time is
      // far more useful than a "go look at this URL" pointer the operator
      // then has to re-fetch manually. Best-effort — if the log fetch
      // itself fails (403, run not yet indexed), proceed with the short
      // error so we don't hide the original failure.
      let logTail = '';
      try {
        const logOut = await runCommandAsync(
          ['gh', 'run', 'view', String(run.databaseId), '--log-failed'],
          { silent: true, ignoreError: true, timeout: 60_000 },
        );
        if (logOut) {
          const text = logOut.toString();
          // Tail size 20KB — deploy.yml's failure dump (CoreDNS config +
          // CoreDNS logs + CCM logs + node info + pod network probes) can
          // total 10-15KB; a 3KB tail truncates every useful line and
          // leaves only the final error marker.
          const tail = text.length > 20000 ? `…\n${text.slice(-20000)}` : text;
          logTail = `\n--- failing-step log (last 20KB) ---\n${tail}`;
        }
      } catch {
        /* best-effort */
      }
      throw new Error(
        `deploy.yml run ${run.databaseId} finished with conclusion=${run.conclusion}. ` +
          `Inspect: gh run view ${run.databaseId} --log-failed${logTail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  // Timeout: grab a log tail of the still-running workflow inline. In
  // e2e runs the throwaway repo is deleted seconds after this
  // throws, so a post-hoc `gh run view` 404s — we need the state now or
  // we fly blind. Best-effort; a dry runId pointer is better than
  // nothing when the log fetch itself fails.
  let runId = null;
  let logTail = '';
  try {
    const out = await runCommandAsync(
      [
        'gh',
        'run',
        'list',
        '--workflow',
        'deploy.yml',
        '--limit',
        '1',
        '--json',
        'databaseId,status',
      ],
      { silent: true, ignoreError: true },
    );
    if (out) {
      const parsed = JSON.parse(out.toString())[0];
      runId = parsed?.databaseId ?? null;
      if (runId) {
        // `gh run view --log` 404s on in-flight runs — the archive doesn't
        // exist until the run completes. For in-flight state, parse the
        // structured jobs JSON: it gives each job's status + per-step
        // conclusion + timing, which is exactly the "which step is hung"
        // signal we need.
        const jobsOut = await runCommandAsync(
          ['gh', 'run', 'view', String(runId), '--json', 'status,conclusion,jobs,url,createdAt'],
          { silent: true, ignoreError: true, timeout: 60_000 },
        );
        if (jobsOut) {
          try {
            const info = JSON.parse(jobsOut.toString());
            const stepSummary = (info.jobs ?? [])
              .map((j) => {
                const steps = (j.steps ?? [])
                  .map(
                    (s) =>
                      `    ${s.conclusion ?? s.status}  ${s.name}${s.startedAt ? ` (${s.startedAt})` : ''}`,
                  )
                  .join('\n');
                return `  job: ${j.name} [${j.status}${j.conclusion ? `/${j.conclusion}` : ''}]\n${steps}`;
              })
              .join('\n');
            logTail =
              `\n--- in-flight run ${runId} @ ${info.url ?? '(no url)'} ---\n` +
              `  status=${info.status} conclusion=${info.conclusion ?? '(pending)'} started=${info.createdAt}\n` +
              stepSummary;
          } catch {
            /* JSON parse failed — silent */
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }
  throw new Error(
    `deploy.yml run did not complete within ${timeoutSec}s.${runId ? ` run=${runId}` : ''}${logTail}`,
  );
}
