/**
 * The surfaces a vibecarbon user reads, for the censuses that keep something
 * out of all of them: a parked add-on
 * (tests/unit/docs/parked-addon-surface-census.test.ts) and a tier that is
 * not offered (tests/unit/docs/unoffered-tier-surface-census.test.ts).
 *
 * - every doc file under carbon/ (.md, .mdx, .mdc, the .env examples, the
 *   locale strings). `create` copies the template's docs from carbon/ into
 *   each new project, so walking all of carbon/ covers every doc it copies,
 *   and carbon/README.md, the one it does not copy, ships in the npm package;
 * - what `create` writes itself: the project README and .env;
 * - every command's help body and the top-level command list.
 *
 * Which repo docs count differs per census, so each walks those itself.
 */
import { join } from 'node:path';
import { generateEnvLocal, generateReadme } from '../../src/create.js';
import { loadAllSpecs } from '../../src/lib/cli/command-registry.js';
import { renderCommandList, renderHelp } from '../../src/lib/cli/help.js';
import { REPO_ROOT, sourceFiles } from './source-files.js';

// Never user docs: dependencies, build output, and the per-developer agent
// memory `create` makes empty in each project.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'agent-memory']);

/** Doc files under `dir` (absolute) that pass `keep`, relative to the repo root. */
export function docFiles(dir: string, keep: (rel: string) => boolean): string[] {
  return sourceFiles(dir, { skip: SKIP_DIRS, relativeTo: REPO_ROOT }).filter(keep);
}

const isTemplateDoc = (rel: string) =>
  /\.(md|mdx|mdc)$/.test(rel) ||
  /\.example$/.test(rel) ||
  rel.endsWith('.windsurfrules') ||
  /^carbon\/src\/client\/locales\/[^/]+\.json$/.test(rel);

/** Every doc file under carbon/, relative to the repo root. */
export function templateDocs(): string[] {
  return docFiles(join(REPO_ROOT, 'carbon'), isTemplateDoc);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `<source>:<line>: <name>` for each line of `text` that names one of `names`.
 * Only a letter or digit extends a word, so `docker-compose.<name>.yml` and an
 * env key such as `VITE_<NAME>_ENABLED` count as mentions (`\b` would treat
 * the underscore as part of the word and miss the key).
 */
export function mentions(source: string, text: string, names: readonly string[]): string[] {
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

/** `[source, text]` for the README and .env that `create` writes. */
export function createdFiles(): [string, string][] {
  const variables = {
    PROJECT_NAME: 'census-app',
    PROJECT_DISPLAY_NAME: 'Census App',
    SITE_URL: 'http://localhost:5173',
    ADMIN_EMAIL: 'admin@example.com',
  };
  return [
    ['README.md (generated)', generateReadme('census-app')],
    ['.env (generated)', generateEnvLocal('census-app', variables)],
  ];
}

/** `[source, text]` for every command's help body, then the top-level command list. */
export async function helpTexts(): Promise<[string, string][]> {
  const specs = await loadAllSpecs();
  const list = renderCommandList(
    specs.map(({ entry, spec }) => ({ ...entry, summary: spec.summary })),
  );
  return [
    ...specs.map(({ entry, spec }): [string, string] => [
      `vibecarbon ${entry.name} -h`,
      stripAnsi(renderHelp(spec)),
    ]),
    ['vibecarbon -h', stripAnsi(list)],
  ];
}
