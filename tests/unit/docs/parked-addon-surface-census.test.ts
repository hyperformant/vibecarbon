/**
 * A parked add-on (`status: 'parked'` in src/add.js's LOCAL_FEATURES) ships its
 * bundle under services/ but is not offered: `add` refuses it and nothing a
 * user reads may name it. This census walks every surface a user reads and
 * fails on any mention of a parked name:
 *
 * - the repo's own docs: every root *.md but CHANGELOG.md (the release
 *   record), and docs/**\/*.md but docs/history.md (the project
 *   history, which says when each one was parked);
 * - every doc file under carbon/ (.md, .mdx, .mdc, the .env examples, the
 *   locale strings). `create` copies the template's docs from carbon/ into
 *   each new project, so walking all of carbon/ covers every doc it copies,
 *   and carbon/README.md, the one it does not copy, ships in the npm package;
 * - what `create` writes itself: the project README and .env;
 * - every command's help body and the top-level command list.
 *
 * The names come from src/add.js, so un-parking an add-on (one status flip)
 * lifts it from this census, and a new doc anywhere above is covered without
 * touching this file. Code paths that only run for an existing install
 * (status rows, upgrade, remove) are not user docs and are not scanned.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARKED_FEATURES } from '../../../src/add.js';
import { generateEnvLocal, generateReadme } from '../../../src/create.js';
import { loadAllSpecs } from '../../../src/lib/cli/command-registry.js';
import { renderCommandList, renderHelp } from '../../../src/lib/cli/help.js';
import { sourceFiles } from '../../_shared/source-files.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// Never user docs: dependencies, build output, and the per-developer agent
// memory `create` makes empty in each project.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'agent-memory']);

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  return sourceFiles(dir, { skip: SKIP_DIRS, relativeTo: ROOT }).filter(keep);
}

const isTemplateDoc = (rel: string) =>
  /\.(md|mdx|mdc)$/.test(rel) ||
  /\.example$/.test(rel) ||
  rel.endsWith('.windsurfrules') ||
  /^carbon\/src\/client\/locales\/[^/]+\.json$/.test(rel);

/** Every user-facing doc file, relative to the repo root. */
function userDocs(): string[] {
  const rootDocs = readdirSync(ROOT).filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md');
  const repoDocs = walk(join(ROOT, 'docs'), (rel) => rel.endsWith('.md')).filter(
    (rel) => rel !== 'docs/history.md',
  );
  const templateDocs = walk(join(ROOT, 'carbon'), isTemplateDoc);
  return [...rootDocs, ...repoDocs, ...templateDocs];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `<source>:<line>: <name>` for each line of `text` that names one of `names`.
 * Only a letter or digit extends a word, so `docker-compose.<name>.yml` and an
 * env key such as `VITE_<NAME>_ENABLED` count as mentions (`\b` would treat
 * the underscore as part of the word and miss the key).
 */
function mentions(source: string, text: string, names: readonly string[]): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (const name of names) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`, 'i');
    lines.forEach((line, i) => {
      if (re.test(line)) out.push(`${source}:${i + 1}: ${name}`);
    });
  }
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

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
    const found = docs.flatMap((rel) =>
      mentions(rel, readFileSync(join(ROOT, rel), 'utf-8'), PARKED_FEATURES),
    );
    expect(found, `parked add-ons named in user docs:\n${found.join('\n')}`).toEqual([]);
  });

  it('the README and .env that create writes name no parked add-on', () => {
    const variables = {
      PROJECT_NAME: 'census-app',
      PROJECT_DISPLAY_NAME: 'Census App',
      SITE_URL: 'http://localhost:5173',
      ADMIN_EMAIL: 'admin@example.com',
    };
    const found = [
      ...mentions('README.md (generated)', generateReadme('census-app'), PARKED_FEATURES),
      ...mentions('.env (generated)', generateEnvLocal('census-app', variables), PARKED_FEATURES),
    ];
    expect(found).toEqual([]);
  });

  it('no command help body, and not the top-level command list, names a parked add-on', async () => {
    const specs = await loadAllSpecs();
    expect(specs.length).toBeGreaterThan(10);
    const found = specs.flatMap(({ entry, spec }) =>
      mentions(`vibecarbon ${entry.name} -h`, stripAnsi(renderHelp(spec)), PARKED_FEATURES),
    );
    const list = stripAnsi(
      renderCommandList(specs.map(({ entry, spec }) => ({ ...entry, summary: spec.summary }))),
    );
    found.push(...mentions('vibecarbon -h', list, PARKED_FEATURES));
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
