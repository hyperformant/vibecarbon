/**
 * Every promotion ends with a base backup on the new timeline (H2b, B5).
 *
 * A promotion (a failover's promote, a restore's end of recovery) starts a new
 * timeline. Until a base is pushed on it, the newest base in the lineage folder
 * is one from before the promotion, and a later `restore latest` starts from
 * that base and has to replay across the switch. So every command that
 * promotes a database also calls pushBaseBackupAfterPromote
 * (src/lib/walg/post-promote-backup.js), which requires `pushed`.
 *
 * The census walks src/ for the promote primitives and every function that
 * reaches one, and asserts that the command function that holds the
 * promotion also holds the push (a deps default counts: the failovers inject
 * it). A function that only wraps a promotion for its callers is followed to
 * those callers; the allowlist names the one function that promotes nothing
 * new, with its reason.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const srcFiles = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
  { cwd: ROOT, encoding: 'utf-8' },
)
  .stdout.split('\n')
  .filter((f) => f.endsWith('.js'));

const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);

/**
 * A line with its string literals' text dropped (a `${...}` interpolation is
 * kept: it is code). A name in a message or a kubectl description is not a
 * use. One line at a time, which is enough for how src/ writes strings.
 */
function codeOf(line: string) {
  let out = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === null) {
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else out += ch;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '`' && depth === 0 && ch === '$' && line[i + 1] === '{') {
      depth = 1;
      i++;
      out += ' ';
      continue;
    }
    if (depth > 0) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      out += depth > 0 ? ch : ' ';
      continue;
    }
    if (ch === quote) quote = null;
  }
  return out;
}

/**
 * The promote primitives: what promotes a database, or proves a restore
 * promoted and retires the cluster from before it.
 */
const PRIMITIVES = [
  'promoteWithProof',
  'promoteStandby',
  'promoteComposeStandby',
  'pg_promote',
  'restoreCompose',
  'runK8sRestore',
  'finishDeployRestore',
  'RETIRE_PREVIOUS_SH',
  'restorePromotedWalgRole',
  'restoreComposeWalgRole',
];

/**
 * Functions that promote for their callers and push nothing themselves: the
 * census follows each to its callers.
 */
const WRAPPERS: Record<string, string> = {
  'src/lib/deploy/replication.js#promoteStandby': 'the k8s promote primitive; failoverHA pushes',
  'src/lib/deploy/compose/ha.js#promoteComposeStandby':
    'the compose promote primitive; failoverComposeHA pushes',
  'src/failover.js#promoteStandbyDatabase': "failoverHA's promote seam; failoverHA pushes",
  'src/lib/deploy/compose/index.js#restoreCompose':
    'the compose restore; restore and scale push after it returns',
  'src/lib/deploy/k8s/k3s.js#finishDeployRestore':
    'the deploy -restore proof and marker clear; deployK3s pushes once the app is up',
  'src/lib/deploy/k8s/k3s.js#applyK3sManifests':
    'runs finishDeployRestore; deployK3s pushes after it returns',
};

/** Functions that reach a primitive and must not push, with the reason. */
const ALLOWLIST: Record<string, string> = {
  'src/lib/deploy/compose/ha.js#composeFailoverAbortBackend':
    'failover -abort re-arms the old primary, which stays on its own timeline: nothing was promoted',
};

type Fn = { file: string; name: string; start: number; end: number; body: string };

/** Top-level functions: a column-0 `function` line up to the next column-0 `}`. */
function topLevelFunctions(file: string, text: string): Fn[] {
  const lines = text.split('\n');
  const out: Fn[] = [];
  lines.forEach((l, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/.exec(l);
    if (!m) return;
    let end = lines.findIndex((x, j) => j > i && /^\}\s*$/.test(x));
    if (end === -1) end = lines.length - 1;
    const body = lines
      .slice(i, end + 1)
      .filter((x) => !isComment(x))
      .join('\n');
    out.push({ file, name: m[1], start: i, end, body });
  });
  return out;
}

const PUSH = /\bpushBaseBackupAfterPromote\b/;

/**
 * Walk the primitives to the functions that must push. Returns the pushing
 * sites, the wrappers and allowlist rows that were used, and the failures.
 */
function census(files: Array<{ file: string; text: string }>) {
  const fns = files.flatMap(({ file, text }) => topLevelFunctions(file, text));
  const key = (f: Fn) => `${f.file}#${f.name}`;
  const byName = (name: string) => fns.filter((f) => f.name === name);
  const tokens = [...PRIMITIVES];
  const seen = new Set<string>();
  const sites = new Set<string>();
  const usedWrappers = new Set<string>();
  const usedAllow = new Set<string>();
  const bad: string[] = [];
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    const ref = new RegExp(`(?<![\\w.])${token}\\b`);
    for (const { file, text } of files) {
      const lines = text.split('\n');
      lines.forEach((raw, i) => {
        // pg_promote is SQL: it only ever appears inside a command string.
        const l = token === 'pg_promote' ? raw : codeOf(raw);
        if (isComment(raw) || !ref.test(l)) return;
        // Definitions and imports are not uses.
        if (new RegExp(`\\bfunction\\s+${token}\\s*\\(|\\bconst\\s+${token}\\s*=`).test(l)) return;
        if (/^\s*import\b|^\s*\}\s*from\s|^\s*\w+,\s*$|^\s*\w+ as \w+,\s*$/.test(l)) return;
        const fn = fns.find((f) => f.file === file && f.start <= i && i <= f.end);
        if (!fn) {
          bad.push(`${file}:${i + 1}: ${token} outside any top-level function`);
          return;
        }
        const k = key(fn);
        if (seen.has(`${k}<${token}`)) return;
        seen.add(`${k}<${token}`);
        if (fn.name === token) return;
        if (WRAPPERS[k]) {
          usedWrappers.add(k);
          if (!tokens.includes(fn.name)) tokens.push(fn.name);
          return;
        }
        if (ALLOWLIST[k]) {
          usedAllow.add(k);
          return;
        }
        // The callee itself pushes (runK8sRestore holds its own push).
        const pushingCallee = byName(token).find((def) => PUSH.test(def.body));
        if (pushingCallee) {
          sites.add(key(pushingCallee));
          return;
        }
        if (PUSH.test(fn.body)) {
          sites.add(k);
          return;
        }
        bad.push(`${file}:${i + 1}: ${fn.name} reaches ${token} but never pushes a base backup`);
      });
    }
  }
  return { sites: [...sites].sort(), usedWrappers, usedAllow, bad };
}

describe('every promotion ends with a base backup on the new timeline (census)', () => {
  const files = srcFiles.map((file) => ({
    file,
    text: readFileSync(join(ROOT, file), 'utf-8'),
  }));
  const result = census(files);

  it('every function that holds a promotion pushes a base after it', () => {
    expect(result.bad).toEqual([]);
  });

  it('finds the promote sites: both failovers, both restores, scale, deploy -restore', () => {
    expect(result.sites).toEqual(
      expect.arrayContaining([
        'src/failover.js#failoverHA',
        'src/lib/deploy/compose/ha.js#failoverComposeHA',
        'src/restore.js#runComposeRestore',
        'src/restore.js#runK8sRestore',
        'src/scale.js#scaleServers',
        'src/lib/deploy/k8s/k3s.js#deployK3s',
      ]),
    );
    expect(result.sites.length).toBeGreaterThanOrEqual(6);
  });

  it('every wrapper and allowlist row is still real', () => {
    expect([...result.usedWrappers].sort()).toEqual(Object.keys(WRAPPERS).sort());
    expect([...result.usedAllow].sort()).toEqual(Object.keys(ALLOWLIST).sort());
  });

  it('the census catches a promote with no push', () => {
    const snippet = [
      'export async function failoverSomething() {',
      '  await promoteStandby(ip, key);',
      '}',
    ].join('\n');
    expect(census([{ file: 'src/x.js', text: snippet }]).bad).toHaveLength(1);
    const ok = [
      'export async function failoverSomething({ push = pushBaseBackupAfterPromote } = {}) {',
      '  await promoteStandby(ip, key);',
      '  await push({});',
      '}',
    ].join('\n');
    expect(census([{ file: 'src/x.js', text: ok }]).bad).toEqual([]);
  });
});

// ── the helper itself ────────────────────────────────────────────────────────

const backupCompose = vi.fn();
const triggerBackupJob = vi.fn();
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  backupCompose: (...a: unknown[]) => backupCompose(...a),
}));
vi.mock('../../../src/backup.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  triggerBackupJob: (...a: unknown[]) => triggerBackupJob(...a),
}));

const { pushBaseBackupAfterPromote, PostPromoteBackupError, postPromoteBackupFailedMessage } =
  await import('../../../src/lib/walg/post-promote-backup.js');

afterEach(() => {
  backupCompose.mockReset();
  triggerBackupJob.mockReset();
});

describe('pushBaseBackupAfterPromote', () => {
  const args = {
    ip: '10.0.0.9',
    sshKeyPath: '/k',
    projectName: 'myapp',
    envName: 'prod',
    retain: 14,
  };

  it('compose: pushes through backupCompose with the env retention and returns the name', async () => {
    backupCompose.mockResolvedValue({ result: 'pushed', name: 'base_000000020000000000000005' });
    await expect(pushBaseBackupAfterPromote({ tier: 'compose', ...args })).resolves.toEqual({
      name: 'base_000000020000000000000005',
    });
    expect(backupCompose).toHaveBeenCalledWith('10.0.0.9', '/k', 'myapp', { retain: 14 });
    expect(triggerBackupJob).not.toHaveBeenCalled();
  });

  it('k8s: pushes through the backup Job', async () => {
    triggerBackupJob.mockResolvedValue({
      result: 'pushed',
      name: 'base_000000030000000000000009',
      job: 'backup-manual-x',
    });
    await expect(pushBaseBackupAfterPromote({ tier: 'k8s', ...args })).resolves.toEqual({
      name: 'base_000000030000000000000009',
    });
    expect(triggerBackupJob).toHaveBeenCalledWith('10.0.0.9', '/k');
  });

  it('a skip is a failure: the new timeline still has no base', async () => {
    backupCompose.mockResolvedValue({ result: 'skipped', reason: 'standby-role' });
    const err = await pushBaseBackupAfterPromote({ tier: 'compose', ...args }).catch((e) => e);
    expect(err).toBeInstanceOf(PostPromoteBackupError);
    expect(err.message).toBe(
      'promoted, but the first base backup on the new timeline failed: the backup was skipped ' +
        '(standby-role); run vibecarbon backup prod now',
    );
  });

  it('a failed push fails with its first line as the cause', async () => {
    triggerBackupJob.mockRejectedValue(
      new Error('Backup job backup-manual-x did not complete:\nlogs'),
    );
    const err = await pushBaseBackupAfterPromote({ tier: 'k8s', ...args }).catch((e) => e);
    expect(err).toBeInstanceOf(PostPromoteBackupError);
    expect(err.message).toBe(
      postPromoteBackupFailedMessage('Backup job backup-manual-x did not complete:', 'prod'),
    );
  });

  it('a retention failure after the push is not a missing base: it warns and returns the name', async () => {
    const warn = vi.fn();
    backupCompose.mockResolvedValue({
      result: 'pushed',
      name: 'base_000000020000000000000005',
      retentionError: 'retention failed: i/o timeout',
    });
    await expect(
      pushBaseBackupAfterPromote({ tier: 'compose', ...args, deps: { warn } }),
    ).resolves.toEqual({ name: 'base_000000020000000000000005' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retention failed: i/o timeout'));
  });

  it('refuses an unknown tier before it touches anything', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: the bad input is the test.
      pushBaseBackupAfterPromote({ tier: 'swarm' as any, ...args }),
    ).rejects.toThrow(/tier/);
    expect(backupCompose).not.toHaveBeenCalled();
    expect(triggerBackupJob).not.toHaveBeenCalled();
  });
});
