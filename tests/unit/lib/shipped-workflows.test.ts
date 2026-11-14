/**
 * The CI workflows `configure cicd` ever installed (src/lib/shipped-workflows.js).
 * configure copied them as they were and, until it recorded their checksums,
 * left no record of them, so upgrade tells the CLI's own copy from the
 * user's only by its bytes: a copy in this list is the CLI's to replace,
 * anything else is offered for review. The list only grows: each template change adds the
 * new version's hash, and every version git history holds stays listed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashContent } from '../../../src/lib/checksum.js';
import { CICD_WORKFLOW_FILES } from '../../../src/lib/ci-setup.js';
import { gitSafeEnv } from '../../../src/lib/command.js';
import { isShippedWorkflow, SHIPPED_WORKFLOWS } from '../../../src/lib/shipped-workflows.js';

const ROOT = process.cwd();
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, env: gitSafeEnv(), encoding: 'utf-8' });

const shallow = (() => {
  try {
    return git('rev-parse', '--is-shallow-repository').trim() !== 'false';
  } catch {
    return true;
  }
})();

describe('SHIPPED_WORKFLOWS', () => {
  it('has exactly the workflows configure installs', () => {
    expect(Object.keys(SHIPPED_WORKFLOWS).sort()).toEqual([...CICD_WORKFLOW_FILES].sort());
  });

  for (const rel of CICD_WORKFLOW_FILES) {
    it(`${rel}: lists the copy this CLI ships`, () => {
      const hash = hashContent(readFileSync(join(ROOT, 'carbon', rel), 'utf-8'));
      expect(
        SHIPPED_WORKFLOWS[rel],
        `carbon/${rel} changed: add '${hash}' to SHIPPED_WORKFLOWS['${rel}'] in src/lib/shipped-workflows.js`,
      ).toContain(hash);
    });

    // A shallow clone (CI's checkout) has one version; a full one has them all.
    it.skipIf(shallow)(`${rel}: lists every version git history holds`, () => {
      // `commit <sha>` then the path it had there (--follow crosses renames).
      const log = git(
        'log',
        '--follow',
        '--format=commit %H',
        '--name-only',
        '--',
        `carbon/${rel}`,
      );
      const versions: Array<[string, string]> = [];
      let sha = '';
      for (const line of log.split('\n')) {
        if (line.startsWith('commit ')) sha = line.slice('commit '.length);
        else if (line.trim()) versions.push([sha, line.trim()]);
      }
      expect(versions.length).toBeGreaterThan(1);
      for (const [sha, path] of versions) {
        let text: string;
        try {
          text = git('show', `${sha}:${path}`);
        } catch {
          continue; // the commit that deleted it
        }
        expect(SHIPPED_WORKFLOWS[rel], `${rel} at ${sha.slice(0, 8)}`).toContain(hashContent(text));
      }
    });
  }

  it('isShippedWorkflow: byte for byte only, and only for its own path', () => {
    const rel = '.github/workflows/deploy.yml';
    const text = readFileSync(join(ROOT, 'carbon', rel), 'utf-8');
    expect(isShippedWorkflow(rel, text)).toBe(true);
    expect(isShippedWorkflow(rel, `${text}\n`)).toBe(false);
    expect(isShippedWorkflow('.github/workflows/vibecarbon-build.yml', text)).toBe(false);
    expect(isShippedWorkflow('k8s/base/kustomization.yaml', text)).toBe(false);
  });
});
