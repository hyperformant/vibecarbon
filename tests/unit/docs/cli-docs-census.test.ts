import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Census: the User Docs CLI reference must describe the CLI that exists.
 *
 * `carbon/content/docs/cli.mdx` is the page users read to learn what the tool
 * does. Nothing checked it against the code, so it could drift in either
 * direction: a command shipped without a section, or a section left behind
 * for a command that was removed.
 */

const ROOT = process.cwd();
const CLI_DOC = join(ROOT, 'carbon', 'content', 'docs', 'cli.mdx');
const doc = readFileSync(CLI_DOC, 'utf-8');

/**
 * Commands the CLI actually dispatches, read from its switch. Matches any
 * leading indentation — the switch lives inside a try block (for crash
 * reporting; see src/lib/telemetry/), so its cases are nested one level
 * deeper than a bare top-level switch would be.
 */
const dispatched = [
  ...readFileSync(join(ROOT, 'src', 'cli.js'), 'utf-8').matchAll(/^\s+case '([a-z-]+)':/gm),
]
  .map((m) => m[1])
  .sort();

/** Commands the docs give a section to. */
const documented = [...doc.matchAll(/^## `?([a-z-]+)/gm)].map((m) => m[1]).sort();

describe('CLI reference documents the CLI that exists', () => {
  it('the extraction found a real command set (guards against a regex that stopped matching)', () => {
    // Without this, both assertions below pass vacuously on two empty lists.
    expect(dispatched.length).toBeGreaterThan(15);
    expect(documented.length).toBeGreaterThan(15);
  });

  it('every dispatched command has a docs section', () => {
    const missing = dispatched.filter((c) => !documented.includes(c));
    expect(missing, `shipped but undocumented: ${missing.join(', ')}`).toEqual([]);
  });

  it('every documented command is actually dispatched', () => {
    const phantom = documented.filter((c) => !dispatched.includes(c));
    expect(phantom, `documented but not a real command: ${phantom.join(', ')}`).toEqual([]);
  });
});
