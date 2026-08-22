/**
 * Behavioral coverage for the CI file installers in src/lib/ci-setup.js.
 *
 * Regression target: `installWorkflowFile()` ensures `.nvmrc` (the shipped
 * workflow resolves its Node version from it via `node-version-file`, and
 * setup-node hard-fails on a missing path) but returns false when the WORKFLOW
 * already existed. `ensureCIImageReady()` gated its commit+push on that return
 * value, so for a project scaffolded before `.nvmrc` shipped the file was
 * written to disk and then never staged — an unrequested, untracked mutation
 * of the operator's working tree, in a module that explicitly stages only its
 * own files. The next `vibecarbon upgrade` would then swap in the
 * node-version-file workflow and CI would die at setup-node on a path that was
 * never committed.
 *
 * `installCiFiles()` reports both writes; callers that auto-commit gate on
 * `needsCommit`. These tests drive the real filesystem (and a real git repo for
 * the staging check) rather than mocking `node:fs` / `node:child_process` —
 * mocking node: builtins is flaky under the parallel unit run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import {
  installCiFiles,
  installNodeVersionFile,
  installWorkflowFile,
} from '../../../src/lib/ci-setup.js';

const WORKFLOW_REL = '.github/workflows/vibecarbon-build.yml';
const NVMRC_REL = '.nvmrc';
/** What the CLI ships — the generated project's .nvmrc must match it byte for byte. */
const TEMPLATE_NVMRC = readFileSync(join(process.cwd(), 'carbon', '.nvmrc'), 'utf-8');

describe('ci-setup: .nvmrc install + commit gating', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'vc-ci-setup-'));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  /** Simulate a project that already has the build workflow committed. */
  function writeExistingWorkflow() {
    const target = join(project, WORKFLOW_REL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'name: Build & Push\n# pre-existing\n');
  }

  describe('installNodeVersionFile', () => {
    it('writes the shipped .nvmrc when absent', () => {
      expect(installNodeVersionFile(project)).toBe(true);
      expect(readFileSync(join(project, NVMRC_REL), 'utf-8')).toBe(TEMPLATE_NVMRC);
    });

    it('is idempotent and never clobbers an existing file', () => {
      writeFileSync(join(project, NVMRC_REL), '18\n');
      expect(installNodeVersionFile(project)).toBe(false);
      // A project deliberately on another line keeps it — this installer only
      // fills a gap, it is not an upgrade path.
      expect(readFileSync(join(project, NVMRC_REL), 'utf-8')).toBe('18\n');
    });
  });

  describe('installWorkflowFile keeps reporting on the WORKFLOW only', () => {
    // configure.js → CI/CD reports "Build workflow installed" from this return
    // value and then tells the operator to stage both files by hand, so this
    // signal must stay about the workflow specifically.
    it('returns false when the workflow already exists, even though .nvmrc was written', () => {
      writeExistingWorkflow();
      expect(installWorkflowFile(project)).toBe(false);
      expect(existsSync(join(project, NVMRC_REL))).toBe(true);
    });

    it('returns true on a fresh project and writes both files', () => {
      expect(installWorkflowFile(project)).toBe(true);
      expect(existsSync(join(project, WORKFLOW_REL))).toBe(true);
      expect(existsSync(join(project, NVMRC_REL))).toBe(true);
    });
  });

  describe('installCiFiles reports every write', () => {
    it('THE REGRESSION: workflow present, .nvmrc missing -> needsCommit', () => {
      writeExistingWorkflow();
      const result = installCiFiles(project);
      expect(result.workflow).toBe(false);
      expect(result.nodeVersion).toBe(true);
      // The whole point: gating on `workflow` here left the file untracked.
      expect(result.needsCommit).toBe(true);
      expect(readFileSync(join(project, NVMRC_REL), 'utf-8')).toBe(TEMPLATE_NVMRC);
    });

    it('fresh project -> both written, needsCommit', () => {
      expect(installCiFiles(project)).toEqual({
        workflow: true,
        nodeVersion: true,
        needsCommit: true,
      });
    });

    it('everything already present -> nothing written, no commit', () => {
      writeExistingWorkflow();
      writeFileSync(join(project, NVMRC_REL), TEMPLATE_NVMRC);
      expect(installCiFiles(project)).toEqual({
        workflow: false,
        nodeVersion: false,
        needsCommit: false,
      });
    });

    it('is idempotent — a second call reports no work', () => {
      installCiFiles(project);
      expect(installCiFiles(project).needsCommit).toBe(false);
    });
  });

  describe('the commit actually carries .nvmrc', () => {
    // End-to-end over a real git repo: proves the staged set (not just the
    // return value) includes .nvmrc in the pre-.nvmrc-project case.
    //
    // The scrubbed env is load-bearing, not hygiene. `cwd` alone does NOT
    // confine git: git exports GIT_DIR (and GIT_INDEX_FILE) to every hook it
    // runs, and this repo's pre-commit hook runs the unit suite. Inheriting
    // those makes git ignore cwd and operate on the REPO — this test committed
    // its own fixtures onto the branch under `git commit` before the env was
    // scrubbed, while passing cleanly under a bare `pnpm test:unit`. Dropping
    // every GIT_* var confines git to the temp dir; pinning the config sources
    // to /dev/null keeps a developer's global config (commit.gpgsign,
    // core.hooksPath, init.defaultBranch) out of it, so this runs identically
    // in CI and on any machine.
    const HERMETIC_GIT_ENV = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );

    function git(...args: string[]) {
      return execFileSync('git', args, {
        cwd: project,
        encoding: 'utf-8',
        env: {
          ...HERMETIC_GIT_ENV,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    }

    beforeEach(() => {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('commit', '-q', '--allow-empty', '-m', 'initial');
    });

    it('stages .nvmrc alongside the workflow, and sweeps nothing else', () => {
      writeExistingWorkflow();
      git('add', WORKFLOW_REL);
      git('commit', '-q', '-m', 'pre-existing workflow');

      // An unrelated dirty file: the commit path must not sweep it up.
      writeFileSync(join(project, 'NOTES.md'), 'operator scratch\n');

      const { needsCommit } = installCiFiles(project);
      expect(needsCommit).toBe(true);

      // Mirror commitAndPushWorkflow's staging (minus the network push).
      git('add', WORKFLOW_REL, NVMRC_REL);
      git('commit', '-q', '-m', 'chore: add .nvmrc for the vibecarbon build workflow');

      const committed = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n');
      expect(committed).toContain(NVMRC_REL);
      expect(committed).not.toContain('NOTES.md');
      // ...and the operator's file is still sitting there untouched.
      expect(git('status', '--porcelain')).toContain('NOTES.md');
    });
  });
});
