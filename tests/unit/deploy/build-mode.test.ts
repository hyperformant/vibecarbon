import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciAvailable, resolveBuildMode } from '../../../src/lib/ci-setup.js';

// getGitHubRepo shells out to `gh repo view`, which we don't want to execute
// in unit tests. Mock it so we can simulate "remote configured / not configured"
// without hitting the network or the gh CLI.
vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommand: vi.fn(() => {
      throw new Error('gh repo view not configured for this test fixture');
    }),
  };
});

describe('resolveBuildMode (post-PR-5: collapsed flag soup)', () => {
  let tmpDir: string;
  let cwdWithWorkflow: string;
  let cwdWithoutWorkflow: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vc-build-mode-'));
    cwdWithWorkflow = join(tmpDir, 'with-wf');
    cwdWithoutWorkflow = join(tmpDir, 'without-wf');
    mkdirSync(join(cwdWithWorkflow, '.github', 'workflows'), { recursive: true });
    mkdirSync(cwdWithoutWorkflow, { recursive: true });
    writeFileSync(
      join(cwdWithWorkflow, '.github', 'workflows', 'vibecarbon-build.yml'),
      'name: build\n',
    );
    // ciAvailable() reads .vibecarbon.json{cicdEnabled} as authoritative.
    // NOTE the leading dot: these fixtures wrote `vibecarbon.json` until
    // 2026-08-13 and passed, because the implementation read the same wrong
    // name. The test agreed with the code instead of with the file `create`
    // actually writes, so neither noticed.
    writeFileSync(join(cwdWithWorkflow, '.vibecarbon.json'), JSON.stringify({ cicdEnabled: true }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('k8s mode is always local-first', () => {
    it('returns "local" for kubernetes regardless of args or CI/CD state', () => {
      // The k3s pivot (2026-04-25) made k8s local-first by default.
      // PR 5 removed the --gitops flag that used to opt into the push path —
      // GitOps now layers on top via `vibecarbon configure cicd <env>`.
      expect(resolveBuildMode({}, cwdWithWorkflow, 'kubernetes')).toBe('local');
      expect(resolveBuildMode({}, cwdWithoutWorkflow, 'kubernetes')).toBe('local');
    });

    it('returns "local" for kubernetes-ha regardless of args or CI/CD state', () => {
      expect(resolveBuildMode({}, cwdWithWorkflow, 'kubernetes-ha')).toBe('local');
      expect(resolveBuildMode({}, cwdWithoutWorkflow, 'kubernetes-ha')).toBe('local');
    });

    it('ignores prompt-set direct/push hints for k8s', () => {
      // Even if prompts.js mutated args (it shouldn't for k8s, but
      // belt-and-suspenders), k8s always returns 'local'.
      expect(resolveBuildMode({ direct: true }, cwdWithoutWorkflow, 'kubernetes')).toBe('local');
      expect(resolveBuildMode({ push: true }, cwdWithWorkflow, 'kubernetes')).toBe('local');
    });
  });

  describe('compose auto-detection', () => {
    it('returns "local" when CI/CD is not configured and docker is available', () => {
      // Sketch project with operator-side docker: build locally and sideload.
      // Build runs in parallel with iac.upStack — saves ~30-40s off cold
      // compose deploy by hiding the build behind VPS provisioning.
      // checkDependency('docker') is true on dev machines and e2e
      // workers, so this is the expected path almost everywhere.
      expect(resolveBuildMode({}, cwdWithoutWorkflow)).toBe('local');
    });

    it('returns "push" when CI/CD is configured', () => {
      // Productized project: has cicdEnabled=true → git push, GHA builds
      // and deploys.
      expect(resolveBuildMode({}, cwdWithWorkflow)).toBe('push');
    });
  });

  describe('compose interactive override (set by prompts.js)', () => {
    it('honors args.direct=true (operator picked Direct in the prompt)', () => {
      expect(resolveBuildMode({ direct: true }, cwdWithWorkflow)).toBe('direct');
    });

    it('honors args.push=true (operator picked Push in the prompt)', () => {
      expect(resolveBuildMode({ push: true }, cwdWithoutWorkflow)).toBe('push');
    });

    it('throws when both direct and push are set (programmer error)', () => {
      // The interactive prompt sets exactly one. Both being true means
      // a caller bug — fail loudly.
      expect(() => resolveBuildMode({ direct: true, push: true }, cwdWithWorkflow)).toThrow(
        /Cannot pass both/,
      );
    });
  });
});

describe('ciAvailable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vc-ci-available-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when the workflow file is missing', () => {
    expect(ciAvailable(tmpDir)).toBe(false);
  });

  it('returns false when the workflow exists but no GitHub remote is configured', () => {
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tmpDir, '.github', 'workflows', 'vibecarbon-build.yml'), 'name: build\n');
    // gh repo view is mocked to throw, so getGitHubRepo returns null/null.
    expect(ciAvailable(tmpDir)).toBe(false);
  });

  it('does not blow up when cwd does not exist', () => {
    const ghost = join(tmpDir, 'does-not-exist');
    expect(existsSync(ghost)).toBe(false);
    expect(ciAvailable(ghost)).toBe(false);
  });

  it('returns true when .vibecarbon.json has cicdEnabled=true (no gh roundtrip)', () => {
    // This is the happy path after `vibecarbon configure` → CI/CD: the flag
    // is authoritative, so we don't even touch gh repo view.
    writeFileSync(join(tmpDir, '.vibecarbon.json'), JSON.stringify({ cicdEnabled: true }));
    expect(ciAvailable(tmpDir)).toBe(true);
  });

  it('ignores malformed .vibecarbon.json and falls through to workflow-file check', () => {
    writeFileSync(join(tmpDir, '.vibecarbon.json'), '{ not valid json ');
    // No workflow file → false (mock makes gh-repo-view throw anyway).
    expect(ciAvailable(tmpDir)).toBe(false);
  });

  it('returns false when .vibecarbon.json has cicdEnabled=false and no workflow file', () => {
    writeFileSync(join(tmpDir, '.vibecarbon.json'), JSON.stringify({ cicdEnabled: false }));
    expect(ciAvailable(tmpDir)).toBe(false);
  });
});
