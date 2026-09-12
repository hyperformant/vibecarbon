import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { templatePathFor } from '../../../src/lib/template-paths.js';

/**
 * The published tarball must carry EVERY template file `create` and
 * `upgrade` read — not just "no dev artifacts" (tarball-excludes.test.ts).
 *
 * Why this exists: npm's packer drops a fixed set of basenames from every
 * tarball no matter what package.json `files` or .npmignore say —
 * `.gitignore`, `.npmignore`, `.npmrc`, `.DS_Store`, `*.orig`, and a few
 * more. carbon/.gitignore was one of them, so from the first public release
 * through 0.43.0 the npm package could not run `vibecarbon create` at all:
 * copyTemplate silently returned false on the missing source and the
 * .gitignore security validator aborted the command. Every test tier ran
 * src/cli.js from the checkout, where the file exists in git, so nothing
 * noticed until a real install did.
 *
 * Both checks below run the real `npm pack --dry-run` and compare against
 * git, so a future file npm strips by name fails here — on every push —
 * instead of in a customer's terminal.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Files under carbon/ that npm consumes at pack time and must NOT ship. */
const PACK_TIME_ONLY = new Set(['carbon/.npmignore']);

/**
 * create's OPTIONAL template reads: copyTemplate's return value is checked
 * and absence is handled. Everything else create names must ship.
 */
const OPTIONAL_TEMPLATE_READS = new Set<string>([]);

function packedFiles(): Set<string> {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as unknown;
  // npm <=11 returns `[{ files }]`; npm 12+ returns `{ <name>: { files } }`.
  const entry = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as Record<string, unknown>)[0]
  ) as { files?: Array<{ path: string }> } | undefined;
  const files = (entry?.files ?? []).map((f) => f.path);
  if (files.length === 0) {
    throw new Error(
      'npm pack --dry-run --json returned no files — parser/format mismatch, not an empty package',
    );
  }
  return new Set(files);
}

function trackedTemplateFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'carbon'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const files = out.split('\0').filter(Boolean);
  if (files.length === 0) {
    throw new Error('git ls-files carbon returned nothing — the template tree is not tracked?');
  }
  return files;
}

describe('npm tarball ships the whole template', () => {
  it('packs every tracked file under carbon/ (npm strips some basenames unconditionally)', () => {
    const packed = packedFiles();
    const missing = trackedTemplateFiles().filter((p) => !packed.has(p) && !PACK_TIME_ONLY.has(p));

    expect(
      missing,
      'tracked template files that npm pack leaves OUT of the tarball:\n' +
        `${missing.join('\n')}\n\n` +
        'npm drops .gitignore, .npmignore, .npmrc, .DS_Store, *.orig (and a few more) from every ' +
        'tarball regardless of package.json `files` or .npmignore. Ship such a file under a name ' +
        'npm keeps and map it back at copy time — see TEMPLATE_RENAMES in src/lib/template-paths.js ' +
        '(carbon/_gitignore -> .gitignore is the existing example). If the file is genuinely ' +
        'pack-time-only, add it to PACK_TIME_ONLY above.',
    ).toEqual([]);
  });

  it('packs every template file src/create.js copies by name', () => {
    const packed = packedFiles();
    const source = readFileSync(join(repoRoot, 'src', 'create.js'), 'utf8');
    // copyTemplate('<template path>', ...) — string-literal first argument only.
    const named = [...source.matchAll(/copyTemplate\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(
      named.length,
      'no copyTemplate literals found in src/create.js — regex drift?',
    ).toBeGreaterThan(20);

    const unshipped = [...new Set(named)]
      .filter((p) => !OPTIONAL_TEMPLATE_READS.has(p))
      .map((projectPath) => ({
        projectPath,
        tarballPath: `carbon/${templatePathFor(projectPath)}`,
      }))
      .filter(({ tarballPath }) => !packed.has(tarballPath));

    expect(
      unshipped,
      'create.js names template files the tarball does not contain (copyTemplate returns false ' +
        'silently on a missing source, so the generated project just lacks the file):\n' +
        unshipped.map((u) => `  copyTemplate('${u.projectPath}') -> ${u.tarballPath}`).join('\n'),
    ).toEqual([]);
  });
});
