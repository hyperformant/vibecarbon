/**
 * Stale scratch-repo sweep — the fix for the class behind the 2026-08-28
 * audit's 99 accumulated `vc-e2e-*` repos: teardown-repo deletes only on
 * green runs; failed/kept runs leave their push-target repo forever.
 *
 * Blast-radius doctrine mirrors the cloud sweeps: only names matching the
 * MACHINE-GENERATED shape are ever deleted, young repos are kept (a kept
 * rig's iterate loop pushes to its repo), and everything fails open.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SCRATCH_REPO_PATTERN,
  sweepStaleScratchRepos,
} from '../../../tests/e2e/utils/scratch-repo-sweep.js';

const NOW = Date.parse('2026-08-28T12:00:00Z');
const old = '2026-08-25T00:00:00Z'; // 3.5 days — stale
const young = '2026-08-28T06:00:00Z'; // 6h — a live kept rig

const LISTING = JSON.stringify([
  { name: 'vc-e2e-k8s-ha-47ea200d', pushedAt: old },
  { name: 'vc-e2e-compose-9a1b2c3d', pushedAt: young },
  { name: 'vibecarbon-public', pushedAt: old }, // real repo — shape mismatch
  { name: 'vc-e2e-state-local', pushedAt: old }, // no 8-hex tail — mismatch
  { name: 'vc-e2e-compose-ha-00c0ffee', updatedAt: old }, // pushedAt absent → updatedAt
]);

describe('SCRATCH_REPO_PATTERN', () => {
  it('matches only the machine-generated shape', () => {
    expect(SCRATCH_REPO_PATTERN.test('vc-e2e-k8s-ha-47ea200d')).toBe(true);
    expect(SCRATCH_REPO_PATTERN.test('vibecarbon-public')).toBe(false);
    expect(SCRATCH_REPO_PATTERN.test('vc-e2e-state-local')).toBe(false);
    expect(SCRATCH_REPO_PATTERN.test('vc-e2e-compose-XYZ12345')).toBe(false);
  });
});

describe('sweepStaleScratchRepos', () => {
  it('deletes only stale machine-named repos; keeps young ones; never touches real repos', async () => {
    const deleted: string[] = [];
    const exec = vi.fn(async (argv: string[]) => {
      if (argv.includes('list')) return LISTING;
      if (argv.includes('delete')) {
        deleted.push(argv[3]);
        return '';
      }
      return '';
    });
    const res = await sweepStaleScratchRepos({ exec, nowMs: NOW, log: () => {} });
    expect(res.skipped).toBe(false);
    expect(res.swept.sort()).toEqual(['vc-e2e-compose-ha-00c0ffee', 'vc-e2e-k8s-ha-47ea200d']);
    expect(res.kept).toEqual(['vc-e2e-compose-9a1b2c3d']);
    expect(deleted).not.toContain('vibecarbon-public');
    expect(deleted).not.toContain('vc-e2e-state-local');
  });

  it('fails open when the listing is unavailable (no gh / no auth)', async () => {
    const exec = vi.fn(async () => {
      throw new Error('gh: command not found');
    });
    const res = await sweepStaleScratchRepos({ exec, nowMs: NOW, log: () => {} });
    expect(res).toEqual({ swept: [], kept: [], skipped: true });
  });

  it('a per-repo delete failure keeps the repo and continues (no throw)', async () => {
    const exec = vi.fn(async (argv: string[]) => {
      if (argv.includes('list')) return LISTING;
      if (argv[3] === 'vc-e2e-k8s-ha-47ea200d') throw new Error('403');
      return '';
    });
    const res = await sweepStaleScratchRepos({ exec, nowMs: NOW, log: () => {} });
    expect(res.swept).toEqual(['vc-e2e-compose-ha-00c0ffee']);
    expect(res.kept).toContain('vc-e2e-k8s-ha-47ea200d');
  });

  it('a repo with no readable timestamp is KEPT (never delete on missing evidence)', async () => {
    const exec = vi.fn(async (argv: string[]) =>
      argv.includes('list') ? JSON.stringify([{ name: 'vc-e2e-k8s-12345678' }]) : '',
    );
    const res = await sweepStaleScratchRepos({ exec, nowMs: NOW, log: () => {} });
    expect(res.swept).toEqual([]);
    expect(res.kept).toEqual(['vc-e2e-k8s-12345678']);
  });
});
