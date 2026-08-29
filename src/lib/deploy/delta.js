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
  const dirtyCount = dirtyOutput === null ? null : shipDirtyLines(dirtyOutput).length;

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

// Longest subject that fits beside the 11-char label + 7-char sha without
// wrapping inside clack's note box on an 80-col terminal — a wrapped subject
// destroys the two-column alignment (2026-08-26 screenshot).
const SUBJECT_MAX = 44;

function clip(text) {
  if (!text) return text;
  return text.length > SUBJECT_MAX ? `${text.slice(0, SUBJECT_MAX - 1)}…` : text;
}

// Identity styling: tests and any non-TTY consumer get plain strings.
const PLAIN = {
  sha: (s) => s,
  count: (s) => s,
  subject: (s) => s,
  warn: (s) => s,
  alert: (s) => s,
};

/**
 * Render the delta as note lines for the deploy summary. Pure.
 * Returns [] when there is nothing meaningful to show (delta null).
 * `style` maps the semantic pieces to strings — pass ANSI colorizers from
 * lib/colors for terminal output; defaults to plain text.
 */
export function formatDeployDeltaLines(delta, style = {}) {
  if (!delta) return [];
  const st = { ...PLAIN, ...style };
  const lines = [];
  const { deployed, current, commitsAhead, dirtyCount, subjects } = delta;

  const dirtySuffix =
    dirtyCount > 0
      ? [
          st.warn(
            `⚠ ${dirtyCount} uncommitted ${dirtyCount === 1 ? 'file' : 'files'} will be included in this build`,
          ),
        ]
      : [];

  if (!deployed) {
    lines.push(
      `Deploying: ${st.sha(short(current.sha))}${current.message ? `  ${st.subject(clip(current.message))}` : ''}`,
    );
    lines.push(st.subject('Live:      none recorded (first deploy, or before this was tracked)'));
    return [...lines, ...dirtySuffix];
  }

  const liveLabel = `${st.sha(short(deployed.sha))}${deployed.message ? `  ${st.subject(clip(deployed.message))}` : `  ${st.subject('(commit not in local history)')}`}`;

  if (deployed.sha === current.sha) {
    if (dirtyCount === 0) {
      lines.push(
        st.warn(
          `No changes — redeploying the version already live (${short(deployed.sha)}${delta.deployedDirty ? ', which included uncommitted edits' : ''})`,
        ),
      );
      return lines;
    }
    lines.push(`Live:      ${liveLabel}`);
    lines.push(`Deploying: ${st.warn('same commit + uncommitted edits')}`);
    return [...lines, ...dirtySuffix];
  }

  lines.push(`Live:      ${liveLabel}`);
  const aheadLabel =
    commitsAhead === null
      ? ''
      : commitsAhead === 0
        ? `  ${st.alert('(local is BEHIND the live commit)')}`
        : `  ${st.count(`(+${commitsAhead} commit${commitsAhead === 1 ? '' : 's'})`)}`;
  lines.push(`Deploying: ${st.sha(short(current.sha))}${aheadLabel}`);
  for (const [i, subject] of subjects.entries()) {
    if (i >= SUBJECT_LIMIT) {
      lines.push(st.subject(`  … and ${commitsAhead - SUBJECT_LIMIT} more`));
      break;
    }
    const [sha, ...rest] = subject.split(' ');
    lines.push(`  ${st.sha(sha)} ${st.subject(clip(rest.join(' ')))}`);
  }
  return [...lines, ...dirtySuffix];
}

/** True when the working tree has uncommitted changes; null when unknowable. */
/**
 * Porcelain lines for files that actually ride along in a build. The CLI's own
 * state — .vibecarbon.json and .vibecarbon/ — is excluded: the deploy itself
 * rewrites .vibecarbon.json on completion (deployedAt/deployedCommit), so
 * counting it would make every deploy after the first warn about "uncommitted
 * files", and both paths are dockerignored — they never ship in the build
 * these signals describe. Parsed by path, not column position: tryGit trims
 * the output, which strips the FIRST line's leading status space.
 */
function shipDirtyLines(porcelain) {
  return porcelain.split('\n').filter((line) => {
    if (line.trim() === '') return false;
    // "XY path", "XY \"quoted path\"", or a rename "XY old -> new" — the
    // status columns are 1-2 non-space chars once trimming has collapsed them.
    const path = line
      .trim()
      .replace(/^[^\s]{1,2}\s+/, '')
      .replace(/^"/, '');
    return !(path === '.vibecarbon.json' || path.startsWith('.vibecarbon/'));
  });
}

export function workingTreeDirty() {
  const out = tryGit(['status', '--porcelain']);
  return out === null ? null : shipDirtyLines(out).length > 0;
}
