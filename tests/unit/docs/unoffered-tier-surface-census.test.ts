/**
 * A tier that works but is not offered to a new environment (in TIERS, not in
 * OFFERED_TIERS: compose-ha since 2026-11-25) is named on no surface a new
 * user reads. This census walks them and fails on any mention, by id
 * (`compose-ha`) or by label (`Compose HA`):
 *
 * - the repo's own user docs: every root *.md but CHANGELOG.md (the release
 *   record) and AGENTS.md / CLAUDE.md (contributor guidance), and the
 *   provider guides docs/deploy-*.md;
 * - every doc file under carbon/, what `create` writes, and every command's
 *   help (tests/_shared/user-surfaces.ts).
 *
 * Not scanned: the rest of docs/ (technical.md, rto-rpo.md, security.md,
 * tests.md, history.md, plans). Those are the engineering reference and
 * runbooks, and an existing compose-ha environment still needs them. Code
 * paths that only run for an existing environment are not scanned either.
 *
 * The names come from src/lib/deploy/tier-registry.js, so offering a tier
 * again (adding it to OFFERED_TIERS) lifts it from this census.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFERED_TIERS, TIERS } from '../../../src/lib/deploy/tier-registry.js';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';
import {
  createdFiles,
  docFiles,
  helpTexts,
  mentions,
  templateDocs,
} from '../../_shared/user-surfaces.js';

/** Each unoffered tier by id and by label: `compose-ha` and `compose ha`. */
const NAMES = TIERS.filter((tier) => !OFFERED_TIERS.includes(tier)).flatMap((tier) => [
  tier,
  tier.replace('-', ' '),
]);

const NOT_USER_DOCS = new Set(['CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md']);

/** Every user-facing doc file, relative to the repo root. */
function userDocs(): string[] {
  const rootDocs = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.md') && !NOT_USER_DOCS.has(f));
  const guides = docFiles(join(REPO_ROOT, 'docs'), (rel) => /^docs\/deploy-[^/]+\.md$/.test(rel));
  return [...rootDocs, ...guides, ...templateDocs()];
}

describe('unoffered tier surface census', () => {
  const docs = userDocs();

  it('walks the surfaces it claims to (a walk that misses them passes vacuously)', () => {
    for (const expected of [
      'README.md',
      'FEATURES.md',
      'SECURITY.md',
      'docs/deploy-hetzner.md',
      'docs/deploy-digitalocean.md',
      'carbon/README.md',
      'carbon/AGENTS.md',
      'carbon/content/docs/deployment.mdx',
      'carbon/content/docs/cli.mdx',
      'carbon/content/docs/getting-started.mdx',
    ]) {
      expect(docs, expected).toContain(expected);
    }
    for (const reference of ['AGENTS.md', 'docs/technical.md', 'docs/rto-rpo.md']) {
      expect(docs).not.toContain(reference);
    }
  });

  it('no user doc names an unoffered tier', () => {
    const found = docs.flatMap((rel) => mentions(rel, readRepoFile(rel), NAMES));
    expect(found, `unoffered tiers named in user docs:\n${found.join('\n')}`).toEqual([]);
  });

  it('the README and .env that create writes name no unoffered tier', () => {
    expect(createdFiles().flatMap(([source, text]) => mentions(source, text, NAMES))).toEqual([]);
  });

  it('no command help body, and not the top-level command list, names an unoffered tier', async () => {
    const help = await helpTexts();
    expect(help.length).toBeGreaterThan(10);
    expect(help.flatMap(([source, text]) => mentions(source, text, NAMES))).toEqual([]);
  });

  it('the matcher finds the id and the label, in any case', () => {
    const text = ['Deploy mode: compose-ha', 'Docker Compose HA (Failover)', 'compose, k8s'].join(
      '\n',
    );
    expect(mentions('fixture', text, ['compose-ha', 'compose ha'])).toEqual([
      'fixture:1: compose-ha',
      'fixture:2: compose ha',
    ]);
  });
});
