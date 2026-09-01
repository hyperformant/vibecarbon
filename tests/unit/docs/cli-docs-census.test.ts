import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_GATES, PAID_TIERS } from '../../../src/lib/licensing/gate.js';

/**
 * Census: the User Docs CLI reference must describe the CLI that exists.
 *
 * `carbon/content/docs/cli.mdx` is the page users read to learn what the tool
 * does and what it costs. Nothing checked it against the code, so it could
 * drift in either direction: a command shipped without a section, a section
 * left behind for a command that was removed, or — the one that actually
 * happened — a licensing table describing a gating model the code had moved
 * away from.
 *
 * The licensing half is the load-bearing part. Gating is by DEPLOY SCENARIO,
 * never by command: `COMMAND_GATES` classifies no command as 'paid' or
 * 'internal', and `PAID_TIERS` is the whole paid surface. A docs table that
 * lists a command as requiring a license is not a wording problem, it is a
 * false statement about what a customer must buy.
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

  it('the CLI and the licensing taxonomy cover the same commands', () => {
    expect(Object.keys(COMMAND_GATES).sort()).toEqual(dispatched);
  });
});

describe('CLI reference states licensing by scenario, not by command', () => {
  it('no command is classified as self-gating', () => {
    // The product rule this page describes. If a command ever becomes paid,
    // this fails first and the docs assertion below becomes wrong on purpose.
    const selfGating = Object.entries(COMMAND_GATES)
      .filter(([, gate]) => gate === 'paid' || gate === 'internal')
      .map(([cmd]) => cmd);
    expect(selfGating).toEqual([]);
  });

  it('names every paid tier, so the page cannot understate what a license buys', () => {
    // Prose spellings, not the internal slugs.
    const spellings: Record<string, string> = {
      'compose-ha': 'Compose HA',
      k8s: 'Kubernetes',
      'k8s-ha': 'Kubernetes HA',
    };
    const missing = [...PAID_TIERS].filter((tier) => !doc.includes(spellings[tier]));
    expect(missing, `paid tiers absent from cli.mdx: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not claim a command requires a license', () => {
    // The exact shape of the old table: a command in backticks in the left
    // column of the license table, paired with a tier name.
    const offenders = [...doc.matchAll(/^\|\s*`([a-z]+(?: [a-z]+)?)`\s*\|\s*Fullerene/gm)].map(
      (m) => m[1],
    );
    expect(
      offenders,
      `These rows gate a COMMAND rather than a deploy scenario: ${offenders.join(', ')}. ` +
        'Licensing follows the deploy tier; rewrite the row in terms of the scenario.',
    ).toEqual([]);
  });
});
