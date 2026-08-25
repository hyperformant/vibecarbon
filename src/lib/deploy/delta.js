/**
 * What-changes-if-I-deploy: compares the environment's recorded live commit
 * (`envConfig.deployedCommit`, written by the orchestrator on completion)
 * against local HEAD and the working tree, so the deploy summary can say
 * whether this run ships nothing, one fix, or twenty-three commits — and
 * whether uncommitted edits ride along (local builds build the working tree).
 *
 * Every git call is best-effort: outside a repo, or with a live commit that
 * isn't in local history, the summary degrades to what it can prove rather
 * than failing the deploy.
 */

import { runCommand } from '../command.js';

const SUBJECT_LIMIT = 5;

function git(args) {
  return runCommand(['git', ...args], {
    encoding: 'utf-8',
    silent: true,
    cleanEnv: true,
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const short = (sha) => (sha ? sha.slice(0, 7) : sha);

/**
 * Gather the delta between the recorded live deployment and the local repo.
 * All fields null when unknowable. Pure data — formatting lives in
 * formatDeployDeltaLines so it can be unit-tested without git.
 */
export function collectDeployDelta(envConfig) {
  const deployedSha = envConfig?.deployedCommit || null;
  const currentSha = tryGit(['rev-parse', 'HEAD']);
  if (currentSha === null) {
    // Not a git repo (or git missing) — nothing to compare.
    return null;
  }

  const currentMessage = tryGit(['log', '--format=%s', '-1', 'HEAD']);
  const dirtyOutput = tryGit(['status', '--porcelain']);
  const dirtyCount =
    dirtyOutput === null ? null : dirtyOutput === '' ? 0 : dirtyOutput.split('\n').length;

  let deployedMessage = null;
  let commitsAhead = null;
  let subjects = [];
  if (deployedSha) {
    deployedMessage = tryGit(['log', '--format=%s', '-1', deployedSha]);
    const count = tryGit(['rev-list', '--count', `${deployedSha}..HEAD`]);
    commitsAhead = count === null ? null : Number.parseInt(count, 10);
    if (commitsAhead > 0) {
      const log = tryGit([
        'log',
        '--format=%h %s',
        '-n',
        String(SUBJECT_LIMIT + 1),
        `${deployedSha}..HEAD`,
      ]);
      if (log) subjects = log.split('\n');
    }
  }

  return {
    deployed: deployedSha
      ? { sha: deployedSha, message: deployedMessage, at: envConfig?.deployedAt ?? null }
      : null,
    deployedDirty: envConfig?.deployedDirty ?? null,
    current: { sha: currentSha, message: currentMessage },
    commitsAhead,
    dirtyCount,
    subjects,
  };
}

/**
 * Render the delta as plain note lines for the deploy summary. Pure.
 * Returns [] when there is nothing meaningful to show (delta null).
 */
export function formatDeployDeltaLines(delta) {
  if (!delta) return [];
  const lines = [];
  const { deployed, current, commitsAhead, dirtyCount, subjects } = delta;

  const dirtySuffix =
    dirtyCount > 0
      ? [
          `⚠ ${dirtyCount} uncommitted ${dirtyCount === 1 ? 'file' : 'files'} will be included in this build`,
        ]
      : [];

  if (!deployed) {
    lines.push(`Deploying: ${short(current.sha)}${current.message ? `  ${current.message}` : ''}`);
    lines.push('Live:      none recorded (first deploy, or deployed before this was tracked)');
    return [...lines, ...dirtySuffix];
  }

  const liveLabel = `${short(deployed.sha)}${deployed.message ? `  ${deployed.message}` : '  (commit not in local history)'}`;

  if (deployed.sha === current.sha) {
    if (dirtyCount === 0) {
      lines.push(
        `No changes — redeploying the version already live (${short(deployed.sha)}${delta.deployedDirty ? ', which included uncommitted edits' : ''})`,
      );
      return lines;
    }
    lines.push(`Live:      ${liveLabel}`);
    lines.push('Deploying: same commit + uncommitted edits');
    return [...lines, ...dirtySuffix];
  }

  lines.push(`Live:      ${liveLabel}`);
  const aheadLabel =
    commitsAhead === null
      ? ''
      : commitsAhead === 0
        ? '  (local is BEHIND the live commit)'
        : `  (+${commitsAhead} commit${commitsAhead === 1 ? '' : 's'})`;
  lines.push(`Deploying: ${short(current.sha)}${aheadLabel}`);
  for (const [i, subject] of subjects.entries()) {
    if (i >= SUBJECT_LIMIT) {
      lines.push(`  … and ${commitsAhead - SUBJECT_LIMIT} more`);
      break;
    }
    lines.push(`  ${subject}`);
  }
  return [...lines, ...dirtySuffix];
}

/** True when the working tree has uncommitted changes; null when unknowable. */
export function workingTreeDirty() {
  const out = tryGit(['status', '--porcelain']);
  return out === null ? null : out !== '';
}
