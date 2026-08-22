import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC } from '../../../src/deploy.js';

/**
 * Census: the `deploy` flag table in the User Docs must describe the flags
 * `deploy` actually parses.
 *
 * `SPEC` (src/deploy.js) is the single source of truth for argv parsing AND
 * for `-h` output — the docs table is a third copy of the same facts, written
 * by hand, and nothing tied it to the other two. Both drift directions are
 * real failures for a reader: a flag shipped without a row is undiscoverable,
 * and a row for a flag the parser rejects sends them to a hard error.
 *
 * Truth source is the imported SPEC object, never the doc. Extraction on the
 * docs side is deliberately scoped to the flag TABLE rather than the whole
 * `## deploy` section: the section's prose and shell examples also contain
 * `-flag` tokens, and scanning those would let a flag count as "documented"
 * because it appeared once inside an example command.
 */

const ROOT = process.cwd();
const CLI_DOC = join(ROOT, 'carbon', 'content', 'docs', 'cli.mdx');

/** Flags the parser accepts, minus the two every command inherits. */
const UNIVERSAL_FLAGS = new Set(['h', 'v']);
const allSpecFlags: string[] = SPEC.flags.map((f: { name: string }) => f.name).sort();
const specFlags = allSpecFlags.filter((name) => !UNIVERSAL_FLAGS.has(name));

/** The `## deploy` section of the docs page, up to the next `## ` heading. */
function deploySection(): string {
  const doc = readFileSync(CLI_DOC, 'utf-8');
  const start = doc.search(/^## `?deploy\b/m);
  if (start < 0) {
    throw new Error(
      `${CLI_DOC}: no "## deploy" heading found. If the page was restructured, ` +
        'update this guard along with it.',
    );
  }
  const rest = doc.slice(start + 1);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Flag names in the left column of the section's flag table — rows shaped
 * `| \`-name <value>\` | description |`. Only table rows count as
 * documentation; prose and code fences do not.
 */
function documentedFlags(section: string): string[] {
  return [...section.matchAll(/^\|\s*`-([a-z][a-z0-9-]*)/gm)].map((m) => m[1]).sort();
}

describe('deploy flag table documents the flags deploy parses', () => {
  it('the SPEC import produced a real flag set (guards against a silently broken import)', () => {
    // Without this floor, both directions below pass vacuously if SPEC ever
    // stops exporting flags or the shape changes under us.
    expect(specFlags.length).toBeGreaterThan(3);
    expect(documentedFlags(deploySection()).length).toBeGreaterThan(3);
  });

  it('every flag deploy accepts has a row in the docs flag table', () => {
    const documented = documentedFlags(deploySection());
    const missing = specFlags.filter((name: string) => !documented.includes(name));
    expect(
      missing,
      `carbon/content/docs/cli.mdx "## deploy" flag table is missing rows for: ` +
        `${missing.map((f: string) => `-${f}`).join(', ')}. ` +
        'These are parsed by SPEC in src/deploy.js — add a row for each.',
    ).toEqual([]);
  });

  it('every flag in the docs flag table is one deploy actually accepts', () => {
    // Compared against the FULL flag set, `-h`/`-v` included. Those two are
    // stripped from the "must be documented" direction because the page does
    // not repeat them per command — but documenting one is legal, and
    // measuring this direction against the stripped set would report a real
    // flag as a phantom.
    const documented = documentedFlags(deploySection());
    const phantom = documented.filter((name) => !allSpecFlags.includes(name));
    expect(
      phantom,
      `carbon/content/docs/cli.mdx "## deploy" documents flags src/deploy.js does not parse: ` +
        `${phantom.map((f) => `-${f}`).join(', ')}. ` +
        'Either add them to SPEC.flags or delete the rows.',
    ).toEqual([]);
  });

  it('the AGENTS.md deploy line names the flags that steer a deploy (-provider, -mode)', () => {
    // AGENTS.md is the agent-facing command inventory: an agent that reads it
    // to script a deploy needs both the provider binding and the mode, and
    // -provider is the one that is REQUIRED with -y on a new environment.
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8');
    const line = agents.split('\n').find((l) => l.startsWith('npx vibecarbon deploy'));
    expect(
      line,
      'AGENTS.md: no "npx vibecarbon deploy" line in the command inventory',
    ).toBeTruthy();
    for (const flag of ['-provider', '-mode']) {
      expect(
        line as string,
        `AGENTS.md deploy line omits ${flag}: "${line}". ` +
          'Both are parsed by SPEC in src/deploy.js and steer where a deploy lands.',
      ).toContain(flag);
    }
  });
});
