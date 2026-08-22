import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for the Hetzner firewall replace-instead-of-update workaround.
 *
 * The workaround exists because terraform-provider-hcloud#931 (open and
 * maintainer-pinned since 2024-05-22, regression from upstream PR #874 /
 * provider v1.46.0) silently drops EVERY rule from a live firewall on an
 * in-place update. We bridge provider v1.68.0 via @pulumi/hcloud 1.41.0, so
 * we are past the release that introduced it with no fix release available.
 *
 * `deleteBeforeReplace` is load-bearing: Hetzner firewall names are unique per
 * project, so create-before-delete fails the create with `uniqueness_error`.
 *
 * A previous revision of these comments cited a non-existent
 * "hcloud-go@1.32.1 nil-pointer panic". That fabricated citation nearly got
 * the workaround deleted during an audit, which would have shipped a silent
 * total-rule-loss bug. These assertions make removal a deliberate act.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../src/lib/iac/${rel}`, import.meta.url)), 'utf8');

/**
 * Source with comments stripped.
 *
 * Load-bearing. The prose above the Firewall resource in hetzner-k8s.js quotes
 * the literal `replaceOnChanges: ['*']` while explaining the workaround, so a
 * guard that greps the raw file is satisfied by its own documentation: deleting
 * the real option from the options object still passed. Assertions about CODE
 * must run against this; assertions about DOCUMENTATION run against src().
 *
 * (Neither program contains `//` inside a string literal, so this is safe here.)
 */
const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const PROGRAMS = ['programs/hetzner-k8s.js', 'programs/hetzner-compose.js'];

describe('Hetzner firewall replace-on-change workaround', () => {
  it('the comment stripper actually removes the prose that quotes the options', () => {
    // Self-check for the guard above: if this ever stops holding, the code
    // assertions below have silently become prose assertions again.
    expect(src('programs/hetzner-k8s.js')).toMatch(/`replaceOnChanges: \['\*'\]/);
    expect(code('programs/hetzner-k8s.js')).not.toMatch(/`replaceOnChanges/);
  });

  for (const rel of PROGRAMS) {
    describe(rel, () => {
      it('still forces replacement rather than an in-place Update', () => {
        // Two independent options rather than one exact string, so a formatter
        // reflowing the object literal doesn't read as a regression — but
        // matched against comment-stripped CODE, never the surrounding prose.
        const text = code(rel);
        expect(text).toMatch(/replaceOnChanges:\s*\[\s*'\*'\s*\]/);
        expect(text).toMatch(/deleteBeforeReplace:\s*true/);
      });

      it('cites the real, still-open upstream issue', () => {
        // Removing the workaround is fine once #931 ships a fix in a version we
        // bridge — but then this guard must be updated deliberately too.
        expect(src(rel)).toMatch(/#931/);
      });
    });
  }

  it('does not reintroduce the fabricated hcloud-go@1.32.1 citation anywhere in iac', () => {
    const all = [...PROGRAMS, 'index.js'].map(src).join('\n');
    expect(all).not.toMatch(/hcloud-go@1\.32\.1/);
    expect(all).not.toMatch(/hcloud@1\.32\.1/);
  });

  it('documents why deleteBeforeReplace cannot simply be dropped', () => {
    // The security window it opens is real; the guard is that the reason it is
    // unavoidable (per-project name uniqueness) stays written down.
    expect(src('programs/hetzner-k8s.js')).toMatch(/uniqueness_error/);
    expect(src('programs/hetzner-compose.js')).toMatch(/uniqueness_error/);
  });
});
