/**
 * A parked add-on (`status: 'parked'` in src/add.js's LOCAL_FEATURES) ships its
 * bundle under services/ but is not offered: `add` refuses it and nothing a
 * user reads may name it. This census walks every surface a user reads and
 * fails on any mention of a parked name:
 *
 * - the repo's own docs: every root *.md but CHANGELOG.md (the release
 *   record), and docs/**\/*.md but docs/history.md (the project
 *   history, which says when each one was parked);
 * - every doc file under carbon/, what `create` writes, and every command's
 *   help (tests/_shared/user-surfaces.ts).
 *
 * The names come from src/add.js, so un-parking an add-on (one status flip)
 * lifts it from this census, and a new doc anywhere above is covered without
 * touching this file. Code paths that only run for an existing install
 * (status rows, upgrade, remove) are not user docs and are not scanned.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARKED_FEATURES } from '../../../src/add.js';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';
import {
  createdFiles,
  docFiles,
  helpTexts,
  mentions,
  templateDocs,
} from '../../_shared/user-surfaces.js';

/** Every user-facing doc file, relative to the repo root. */
function userDocs(): string[] {
  const rootDocs = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md');
  const repoDocs = docFiles(join(REPO_ROOT, 'docs'), (rel) => rel.endsWith('.md')).filter(
    (rel) => rel !== 'docs/history.md',
  );
  return [...rootDocs, ...repoDocs, ...templateDocs()];
}

describe('parked add-on surface census', () => {
  const docs = userDocs();

  it('walks the surfaces it claims to (a walk that misses them passes vacuously)', () => {
    for (const expected of [
      'README.md',
      'docs/security.md',
      'docs/integrations/observability.md',
      'carbon/AGENTS.md',
      'carbon/PRODUCTION.md',
      'carbon/DEVELOPMENT.md',
      'carbon/.claude/agents/security-reviewer.md',
      'carbon/content/docs/cli.mdx',
      'carbon/k8s/flux/README.md',
      'carbon/.env.example',
      'carbon/src/client/locales/en.json',
    ]) {
      expect(docs, expected).toContain(expected);
    }
    expect(docs).not.toContain('docs/history.md');
  });

  it('no repo or template doc names a parked add-on', () => {
    const found = docs.flatMap((rel) => mentions(rel, readRepoFile(rel), PARKED_FEATURES));
    expect(found, `parked add-ons named in user docs:\n${found.join('\n')}`).toEqual([]);
  });

  it('the README and .env that create writes name no parked add-on', () => {
    const found = createdFiles().flatMap(([source, text]) =>
      mentions(source, text, PARKED_FEATURES),
    );
    expect(found).toEqual([]);
  });

  it('no command help body, and not the top-level command list, names a parked add-on', async () => {
    const help = await helpTexts();
    expect(help.length).toBeGreaterThan(10);
    const found = help.flatMap(([source, text]) => mentions(source, text, PARKED_FEATURES));
    expect(found).toEqual([]);
  });

  it('the matcher finds a parked name in any case and ignores look-alikes', () => {
    const text = [
      'Run docker-compose.demo.yml',
      'the Demo add-on',
      'VITE_DEMO_ENABLED="false"',
      'demos and demolish',
      'ademo and demo2',
    ].join('\n');
    expect(mentions('fixture', text, ['demo'])).toEqual([
      'fixture:1: demo',
      'fixture:2: demo',
      'fixture:3: demo',
    ]);
  });
});
