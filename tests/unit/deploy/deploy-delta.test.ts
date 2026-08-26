import { beforeEach, describe, expect, it, vi } from 'vitest';

// collectDeployDelta shells out to git; mock runCommand so tests are hermetic
// and can simulate every repo state (no repo, dirty tree, behind-live, etc.).
vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runCommand: vi.fn() };
});

const { runCommand } = await import('../../../src/lib/command.js');
const { collectDeployDelta, formatDeployDeltaLines, workingTreeDirty } = await import(
  '../../../src/lib/deploy/delta.js'
);

const mocked = vi.mocked(runCommand);

/** Route mocked git calls by subcommand; `null` response means throw. */
function gitResponds(responses: Record<string, string | null>) {
  mocked.mockImplementation((argv: string[]) => {
    const key = argv.slice(1).join(' ');
    for (const [prefix, value] of Object.entries(responses)) {
      if (key.startsWith(prefix)) {
        if (value === null) throw new Error(`git ${prefix} failed`);
        return value;
      }
    }
    throw new Error(`unexpected git call: ${key}`);
  });
}

beforeEach(() => {
  mocked.mockReset();
});

describe('collectDeployDelta', () => {
  it('returns null outside a git repo', () => {
    gitResponds({ 'rev-parse HEAD': null });
    expect(collectDeployDelta({ deployedCommit: 'abc' })).toBeNull();
  });

  it('collects ahead-of-live state with subjects and dirty count', () => {
    gitResponds({
      'rev-parse HEAD': 'ccccccc1111\n',
      'log --format=%s -1 HEAD': 'newest subject',
      'status --porcelain': ' M a.ts\n?? b.ts',
      'log --format=%s -1 aaaaaaa0000': 'live subject',
      'rev-list --count': '3',
      'log --format=%h %s': 'ccccccc new one\nbbbbbbb middle\naaaaaa2 oldest',
    });
    const delta = collectDeployDelta({ deployedCommit: 'aaaaaaa0000', deployedAt: 'T' });
    expect(delta).toMatchObject({
      deployed: { sha: 'aaaaaaa0000', message: 'live subject', at: 'T' },
      current: { sha: 'ccccccc1111', message: 'newest subject' },
      commitsAhead: 3,
      dirtyCount: 2,
    });
    expect(delta?.subjects).toHaveLength(3);
  });

  it('degrades when the live commit is not in local history', () => {
    gitResponds({
      'rev-parse HEAD': 'ccccccc1111',
      'log --format=%s -1 HEAD': 'head subject',
      'status --porcelain': '',
      'log --format=%s -1 dddddd': null,
      'rev-list --count': null,
    });
    const delta = collectDeployDelta({ deployedCommit: 'dddddd9999' });
    expect(delta?.deployed).toMatchObject({ sha: 'dddddd9999', message: null });
    expect(delta?.commitsAhead).toBeNull();
    expect(delta?.dirtyCount).toBe(0);
  });
});

describe('formatDeployDeltaLines', () => {
  const base = {
    deployed: { sha: 'aaaaaaa0000', message: 'live subject', at: null },
    deployedDirty: null,
    current: { sha: 'ccccccc1111', message: 'new subject' },
    commitsAhead: 2,
    dirtyCount: 0,
    subjects: ['ccccccc new subject', 'bbbbbbb middle subject'],
  };

  it('returns [] for a null delta', () => {
    expect(formatDeployDeltaLines(null)).toEqual([]);
  });

  it('renders live/deploying with commit count and subjects', () => {
    const lines = formatDeployDeltaLines(base);
    expect(lines[0]).toBe('Live:      aaaaaaa  live subject');
    expect(lines[1]).toBe('Deploying: ccccccc  (+2 commits)');
    expect(lines[2]).toContain('ccccccc new subject');
    expect(lines).toHaveLength(4);
  });

  it('flags an identical clean redeploy loudly', () => {
    const lines = formatDeployDeltaLines({
      ...base,
      current: { sha: 'aaaaaaa0000', message: 'live subject' },
      commitsAhead: 0,
      subjects: [],
    });
    expect(lines).toEqual(['No changes — redeploying the version already live (aaaaaaa)']);
  });

  it('warns when uncommitted files ride along', () => {
    const lines = formatDeployDeltaLines({ ...base, dirtyCount: 3 });
    expect(lines.at(-1)).toBe('⚠ 3 uncommitted files will be included in this build');
  });

  it('marks same-commit-plus-edits distinctly', () => {
    const lines = formatDeployDeltaLines({
      ...base,
      current: { sha: 'aaaaaaa0000', message: 'live subject' },
      commitsAhead: 0,
      subjects: [],
      dirtyCount: 1,
    });
    expect(lines).toContain('Deploying: same commit + uncommitted edits');
    expect(lines.at(-1)).toBe('⚠ 1 uncommitted file will be included in this build');
  });

  it('handles first deploy (no recorded live commit)', () => {
    const lines = formatDeployDeltaLines({ ...base, deployed: null });
    expect(lines[0]).toBe('Deploying: ccccccc  new subject');
    expect(lines[1]).toContain('none recorded');
  });

  it('truncates subject lists past the limit', () => {
    const subjects = Array.from({ length: 6 }, (_, i) => `sha${i} subject ${i}`);
    const lines = formatDeployDeltaLines({ ...base, commitsAhead: 9, subjects });
    expect(lines.at(-1)).toBe('  … and 4 more');
  });

  it('clips over-long subjects so columns never wrap', () => {
    const long =
      'copy(cta): subheading -> "Production-grade infrastructure in minutes with automated everything."';
    const lines = formatDeployDeltaLines({
      ...base,
      deployed: { sha: 'aaaaaaa0000', message: long, at: null },
      subjects: [`ccccccc ${long}`],
      commitsAhead: 1,
    });
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(70);
    expect(lines[0]).toContain('…');
  });

  it('applies style hooks to shas, counts, and warnings', () => {
    const tag = (name: string) => (s: string) => `<${name}>${s}</${name}>`;
    const lines = formatDeployDeltaLines(
      { ...base, dirtyCount: 2 },
      { sha: tag('sha'), count: tag('count'), subject: tag('dim'), warn: tag('warn') },
    );
    expect(lines[0]).toContain('<sha>aaaaaaa</sha>');
    expect(lines[1]).toContain('<count>(+2 commits)</count>');
    expect(lines.at(-1)).toContain('<warn>');
  });

  it('calls out a local checkout BEHIND the live commit', () => {
    const lines = formatDeployDeltaLines({ ...base, commitsAhead: 0, subjects: [] });
    expect(lines[1]).toContain('BEHIND the live commit');
  });
});

describe('workingTreeDirty', () => {
  it('true when porcelain reports entries, false when clean, null on failure', () => {
    gitResponds({ 'status --porcelain': ' M x' });
    expect(workingTreeDirty()).toBe(true);
    gitResponds({ 'status --porcelain': '' });
    expect(workingTreeDirty()).toBe(false);
    gitResponds({ 'status --porcelain': null });
    expect(workingTreeDirty()).toBeNull();
  });
});
