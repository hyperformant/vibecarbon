/**
 * Stale scratch-repo sweep (backlog audit 2026-08-28: 99 accumulated repos).
 *
 * Every e2e scenario creates a `vc-e2e-<mode>-<8hex>` GitHub repo as its push
 * target (setup-repo). teardown-repo deletes it ONLY on a green run; a failed
 * or kept run leaves it, deliberately (a kept rig's iterate loop pushes to
 * it), and the operator instruction to `gh repo delete` when done is exactly
 * the kind of manual step that never happens. The result was 99 stale repos.
 *
 * This sweep runs at run start: list the caller's repos, keep anything young
 * enough to belong to a live rig, delete the rest. STRICT scope, in order of
 * defense:
 *   1. name must match the machine-generated scratch shape
 *      (`vc-e2e-<mode-ish>-<8 hex>`) — the same namespace doctrine
 *      sweep-scope pins for cloud resources;
 *   2. pushedAt older than `maxAgeHours` (default 48h — a kept rig older
 *      than two days is abandoned by the kept-rig doctrine anyway);
 *   3. deletions are counted and reported, failures are per-repo warnings.
 *
 * Best-effort BY CONTRACT: any listing failure (no gh, no auth, rate limit)
 * returns `{ swept: [], skipped: true }` — a hygiene sweep must never block
 * a run.
 */

/** The machine-generated scratch-repo shape. Anchored both ends. */
export const SCRATCH_REPO_PATTERN = /^vc-e2e-[a-z0-9-]+-[0-9a-f]{8}$/;

export interface ScratchRepoSweepResult {
  swept: string[];
  kept: string[];
  skipped: boolean;
}

interface RepoRow {
  name: string;
  pushedAt?: string;
  updatedAt?: string;
}

/**
 * @param opts.exec - runs an argv, resolves stdout (injectable; default gh CLI)
 * @param opts.maxAgeHours - repos younger than this are kept (live rigs)
 * @param opts.nowMs - test seam
 * @param opts.log
 */
export async function sweepStaleScratchRepos(opts: {
  exec?: (argv: string[]) => Promise<string>;
  maxAgeHours?: number;
  nowMs?: number;
  log?: (msg: string) => void;
}): Promise<ScratchRepoSweepResult> {
  const {
    exec = defaultExec,
    maxAgeHours = 48,
    nowMs = Date.now(),
    log = (m) => console.log(m),
  } = opts;

  let rows: RepoRow[];
  try {
    const raw = await exec([
      'gh',
      'repo',
      'list',
      '--limit',
      '200',
      '--json',
      'name,pushedAt,updatedAt',
    ]);
    rows = JSON.parse(String(raw));
    if (!Array.isArray(rows)) throw new Error('unexpected gh repo list shape');
  } catch (err) {
    log(
      `[scratch-repo-sweep] skipped (cannot list repos): ${err instanceof Error ? err.message.split('\n')[0] : err}`,
    );
    return { swept: [], kept: [], skipped: true };
  }

  const cutoff = nowMs - maxAgeHours * 3_600_000;
  const swept: string[] = [];
  const kept: string[] = [];
  for (const row of rows) {
    if (!SCRATCH_REPO_PATTERN.test(row?.name ?? '')) continue;
    const stamp = Date.parse(row.pushedAt ?? row.updatedAt ?? '');
    if (!Number.isFinite(stamp) || stamp >= cutoff) {
      kept.push(row.name);
      continue;
    }
    try {
      await exec(['gh', 'repo', 'delete', row.name, '--yes']);
      swept.push(row.name);
    } catch (err) {
      log(
        `[scratch-repo-sweep] could not delete ${row.name}: ${err instanceof Error ? err.message.split('\n')[0] : err}`,
      );
      kept.push(row.name);
    }
  }
  if (swept.length > 0) {
    log(
      `[scratch-repo-sweep] deleted ${swept.length} stale scratch repo(s) older than ` +
        `${maxAgeHours}h: ${swept.join(', ')}`,
    );
  }
  if (kept.length > 0) {
    log(`[scratch-repo-sweep] kept ${kept.length} scratch repo(s) (young or undeletable).`);
  }
  return { swept, kept, skipped: false };
}

async function defaultExec(argv: string[]): Promise<string> {
  const { runCommandAsync } = await import('../../../src/lib/command.js');
  const out = await runCommandAsync(argv, { silent: true });
  return String(out ?? '');
}
