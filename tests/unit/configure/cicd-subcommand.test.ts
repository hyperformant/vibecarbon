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
