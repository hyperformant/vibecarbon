import { describe, expect, it } from 'vitest';
import * as configure from '../../../src/configure.js';
import { promptProviders } from '../../../src/lib/configure-providers.js';

// PR 7 added `vibecarbon configure cicd <env>` as a subcommand. The actual
// body invokes process.exit() on missing pre-conditions and dynamic-imports
// gh-CLI / Pulumi-state machinery, so we don't end-to-end the function here.
// What we DO pin: the export surface and the run-routing decision, since
// both load-bear for the CLI wiring.

describe('configure module export surface (PR 7)', () => {
  it('exports run() as the CLI entry point', () => {
    expect(typeof configure.run).toBe('function');
  });

  it('exports runConfigureCicd() so the cicd subcommand body is reachable', () => {
    // run() routes args[0] === 'cicd' to runConfigureCicd. Exporting the
    // function lets future tests / programmatic callers invoke it directly,
    // and lets us pin the surface so a refactor doesn't silently rename it.
    expect(typeof configure.runConfigureCicd).toBe('function');
  });
});

// A3e: CI/CD on k8s is pull only. The help says the cluster pulls with its
// own read-only deploy key and that nothing at GitHub connects to it, and it
// no longer offers deploy workflows.
describe('configure cicd help (A3e)', () => {
  const description = configure.SPEC.description ?? '';
  const examples = configure.SPEC.examples ?? [];
  const block = description.slice(
    description.indexOf('CICD SUBCOMMAND'),
    description.indexOf('STORAGE SUBCOMMAND'),
  );

  it('the help says flux pulls and nothing at GitHub reaches the cluster', () => {
    expect(block.startsWith('CICD SUBCOMMAND')).toBe(true);
    // Flattened, since the block wraps its lines.
    const said = block.replace(/\s+/g, ' ');
    expect(said).toContain('pulls');
    expect(said).toContain('read-only deploy key');
    expect(said).toContain('nothing at GitHub ever connects to it');
    expect(said).not.toContain('deploy workflows');
    for (const text of [description, ...examples.flatMap((e) => [e.command, e.description])]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('the cicd examples say what each form does', () => {
    const cicd = examples.filter((e) => e.command.startsWith('vibecarbon configure cicd'));
    expect(cicd).toEqual([
      {
        command: 'vibecarbon configure cicd',
        description: 'Install the GitHub Actions build workflow',
      },
      {
        command: 'vibecarbon configure cicd prod',
        description: "The same, then let prod's cluster pull from your repo",
      },
    ]);
  });
});

// B1: Providers is the FIRST configurable feature (OWNER-PINNED label/hint).
// Real, unmocked import (no @clack/prompts mock needed) — this only inspects
// the FEATURES array's static shape, never invokes a prompt.
describe('FEATURES — Providers is first (B1)', () => {
  it('has the OWNER-PINNED value/label/hint, wired to promptProviders', () => {
    const providers = configure.FEATURES[0];
    expect(providers.value).toBe('providers');
    expect(providers.label).toBe('Providers');
    expect(providers.hint).toBe('Cloud + DNS API credentials');
    expect(providers.promptFn).toBe(promptProviders);
  });

  it('isConfigured is always false — per-provider ✓-state lives in the sub-list', () => {
    expect(configure.FEATURES[0].isConfigured()).toBe(false);
    expect(configure.FEATURES[0].isConfigured({ HETZNER_API_TOKEN: 'x' })).toBe(false);
  });

  it('summary masks operator-secret values (never raw)', () => {
    const lines = configure.FEATURES[0].summary({ HETZNER_API_TOKEN: 'abcdefghijklmnop' });
    expect(lines.some((l: string) => l.includes('HETZNER_API_TOKEN'))).toBe(true);
    expect(lines.join('\n')).not.toContain('abcdefghijklmnop');
  });
});
