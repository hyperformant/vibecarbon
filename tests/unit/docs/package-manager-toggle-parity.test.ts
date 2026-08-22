import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The CLI's package-manager prompt and the docs' package-manager switcher are
 * two faces of one product decision. They must move together.
 *
 * The decision (2026-05-06, revised 2026-07-30) was to default generated
 * projects to npm and stop asking: running `vibecarbon` already requires
 * `npx`, so npm is guaranteed present, while pnpm would be one more install
 * before a generated project works at all. `SHOW_PACKAGE_MANAGER_PROMPT` in
 * src/create.js was set to `false`.
 *
 * The docs switcher was not swept with it, and kept offering npm / pnpm / bun
 * on every docs page for the whole life of that decision. In a generated
 * project it is worse than inconsistent: that project has exactly one package
 * manager, fixed in its lockfile and Dockerfile at create time, so two of the
 * three options rewrite the snippets into commands that do not match the repo
 * the reader has open.
 *
 * This test is the sweep. It lives in the root suite rather than carbon/'s
 * because only the root can see both files — carbon/ ships standalone, where
 * src/create.js does not exist.
 */

const ROOT = process.cwd();

/** Reads a `const NAME = true|false` declaration out of a source file. */
function readBooleanConst(relPath: string, name: string): boolean {
  const src = readFileSync(join(ROOT, relPath), 'utf-8');
  const match = src.match(new RegExp(`\\b${name}\\s*=\\s*(true|false)\\b`));
  if (!match) {
    throw new Error(
      `${relPath}: no \`${name} = true|false\` declaration found. ` +
        'If it was renamed or restructured, update this guard with it.',
    );
  }
  return match[1] === 'true';
}

const CLI_FLAG = 'SHOW_PACKAGE_MANAGER_PROMPT';
const DOCS_FLAG = 'SHOW_PACKAGE_MANAGER_SWITCHER';

const CLI_FILE = join('src', 'create.js');
const DOCS_FILE = join('carbon', 'src', 'client', 'hooks', 'usePackageManager.ts');
const DOCS_PAGE = join('carbon', 'content', 'docs', 'cli.mdx');

describe('package-manager choice is offered consistently, or not at all', () => {
  it('the CLI prompt and the docs switcher agree', () => {
    const cli = readBooleanConst(CLI_FILE, CLI_FLAG);
    const docs = readBooleanConst(DOCS_FILE, DOCS_FLAG);
    expect(
      docs,
      `${CLI_FILE} sets ${CLI_FLAG}=${cli} but ${DOCS_FILE} sets ${DOCS_FLAG}=${docs}. ` +
        'Offering the choice in one surface and not the other is how the docs came to ' +
        'advertise pnpm and bun while `create` silently defaulted everyone to npm.',
    ).toBe(cli);
  });

  it('the docs page renders the switcher behind the flag, not unconditionally', () => {
    // The flag only helps if the render site consults it. A component rendered
    // unconditionally would pass the assertion above and still show the toggle.
    const page = readFileSync(join(ROOT, 'carbon', 'src', 'client', 'pages', 'Docs.tsx'), 'utf-8');
    expect(page).toContain(DOCS_FLAG);
    const unguarded = /^\s*<PackageManagerSwitcher\b/m.test(
      page.replace(new RegExp(`\\{${DOCS_FLAG} && \\([\\s\\S]*?\\)\\}`, 'g'), ''),
    );
    expect(
      unguarded,
      `Docs.tsx renders <PackageManagerSwitcher> outside the ${DOCS_FLAG} guard.`,
    ).toBe(false);
  });

  it('the docs do not document a package-manager flag the CLI does not prompt for', () => {
    // `-pm` stays reachable by design even with the prompt off, so its
    // presence in the reference is correct. This pins the pairing so a future
    // removal of the flag also removes the docs line.
    const cli = readBooleanConst(CLI_FILE, CLI_FLAG);
    const documentsPmFlag = readFileSync(join(ROOT, DOCS_PAGE), 'utf-8').includes('-pm');
    const cliAcceptsPmFlag = readFileSync(join(ROOT, CLI_FILE), 'utf-8').includes("name: 'pm'");
    expect(
      documentsPmFlag && !cliAcceptsPmFlag,
      'cli.mdx documents `-pm` but src/create.js no longer accepts it.',
    ).toBe(false);
    // Sanity: with the prompt off, the flag is the ONLY way to choose, so it
    // had better still exist.
    if (!cli) expect(cliAcceptsPmFlag).toBe(true);
  });
});
