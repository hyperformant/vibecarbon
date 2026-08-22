import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Linode firewall-label squeeze (2026-08-08, second live l1 run RCA).
 *
 * Linode caps firewall labels at 32 chars (3-32; live failure: our
 * `${project}-${env}-firewall` template produced 48 and the Pulumi
 * provider rejected it pre-create).
 *
 * CORRECTION (2026-08-20, live CI l2 leg): this file used to assert that
 * "Instance labels (≤64) ... do NOT need this". That was WRONG, and being
 * written down is plausibly why the instance label shipped unsqueezed for
 * months. Linode caps INSTANCE labels at 3-50, and the create was rejected:
 *   expected length of label to be in the range (3 - 50), got
 *   citest-compose-ha-1787258789210-0typg2-cil2-primary   (51)
 * Only compose-HA reaches it — the `-primary`/`-standby` suffix is the part
 * that crosses 50 — and only under CI's longer names, which is why every
 * local run stayed green. Profile SSH-key labels are still fine at 43.
 * The squeeze
 * is deterministic — identity for labels that fit, truncated stem + 8-hex
 * FNV-1a hash of the FULL label for those that don't — so every consumer
 * (the Pulumi program, findFirewallByName and everything routed through
 * it: deleteFirewallByName, applyOperatorCidrs, the destroy path per the
 * match-Pulumi-names doctrine) derives the same wire label from the same
 * logical name.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import {
  LinodeProvider,
  squeezeLinodeInstanceLabel,
  squeezeLinodeLabel,
} from '../../../src/lib/providers/linode.js';

const LONG_NAME = 'testapp-compose-1786199806402-g444o5-l1-firewall'; // 48 chars, the live failure

describe('squeezeLinodeLabel', () => {
  it('is identity for labels within the cap', () => {
    expect(squeezeLinodeLabel('myapp-prod-firewall')).toBe('myapp-prod-firewall');
    expect(squeezeLinodeLabel('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('squeezes over-cap labels to exactly 32 chars: stem + 8-hex hash of the full label', () => {
    const out = squeezeLinodeLabel(LONG_NAME);
    expect(out).toHaveLength(32);
    expect(out).toMatch(/^[A-Za-z0-9:_-]{23}-[0-9a-f]{8}$/);
    expect(LONG_NAME.startsWith(out.slice(0, 23))).toBe(true);
  });

  it('is deterministic and collision-distinct for near-identical long names', () => {
    const a = squeezeLinodeLabel(LONG_NAME);
    expect(squeezeLinodeLabel(LONG_NAME)).toBe(a);
    const sibling = LONG_NAME.replace('g444o5', 'g444o6');
    expect(squeezeLinodeLabel(sibling)).not.toBe(a);
  });
});

describe('LinodeProvider firewall lookups derive the squeezed wire label', () => {
  it('findFirewallByName matches a firewall stored under the squeezed label when given the long logical name', async () => {
    const wireLabel = squeezeLinodeLabel(LONG_NAME);
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 7, label: wireLabel, rules: { inbound: [] } }],
        page: 1,
        pages: 1,
      }),
    });

    const provider = new LinodeProvider('tok');
    const fw = await provider.findFirewallByName(LONG_NAME);
    expect(fw?.id).toBe(7);
  });

  it('findFirewallByName still matches short labels verbatim', async () => {
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 8, label: 'myapp-prod-firewall' }],
        page: 1,
        pages: 1,
      }),
    });

    const provider = new LinodeProvider('tok');
    const fw = await provider.findFirewallByName('myapp-prod-firewall');
    expect(fw?.id).toBe(8);
  });
});

const LONG_INSTANCE = 'citest-compose-ha-1787258789210-0typg2-cil2-primary'; // 51, the live failure

describe('squeezeLinodeInstanceLabel (3-50 cap, distinct from the firewall 32)', () => {
  it('is identity for labels within the instance cap', () => {
    // 50 is the boundary a laptop's shorter names land on, which is exactly
    // why this went unnoticed locally.
    expect(squeezeLinodeInstanceLabel('a'.repeat(50))).toBe('a'.repeat(50));
    expect(squeezeLinodeInstanceLabel('testapp-prod-primary')).toBe('testapp-prod-primary');
  });

  it('squeezes the live 51-char failure to exactly 50', () => {
    const out = squeezeLinodeInstanceLabel(LONG_INSTANCE);
    expect(out).toHaveLength(50);
    expect(out).toMatch(/^[A-Za-z0-9:_-]{41}-[0-9a-f]{8}$/);
  });

  it('does NOT use the firewall cap — that would truncate 18 chars too far', () => {
    // The bug this guards: reaching for the default-arg helper.
    expect(squeezeLinodeInstanceLabel(LONG_INSTANCE)).not.toBe(squeezeLinodeLabel(LONG_INSTANCE));
    expect(squeezeLinodeLabel(LONG_INSTANCE)).toHaveLength(32);
  });

  it('keeps primary and standby distinct after squeezing', () => {
    // They differ only in the SUFFIX, which truncation eats — the hash of the
    // FULL name is what keeps an HA pair from collapsing onto one label.
    const primary = squeezeLinodeInstanceLabel(LONG_INSTANCE);
    const standby = squeezeLinodeInstanceLabel(LONG_INSTANCE.replace('-primary', '-standby'));
    expect(primary).not.toBe(standby);
  });
});

describe('LinodeProvider server lookups derive the squeezed wire label', () => {
  it('findServersByName finds a server stored under the squeezed label', async () => {
    // THE load-bearing invariant: squeezing only the create side would swap a
    // loud deploy failure for silently orphaned, billing instances.
    const wireLabel = squeezeLinodeInstanceLabel(LONG_INSTANCE);
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 42, label: wireLabel }], page: 1, pages: 1 }),
    });

    const provider = new LinodeProvider('tok');
    const found = await provider.findServersByName(LONG_INSTANCE);
    expect(found.map((s: { id: number }) => s.id)).toEqual([42]);
  });

  it('findServersByName still matches short labels verbatim', async () => {
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 9, label: 'myapp-prod-primary' }], page: 1, pages: 1 }),
    });

    const provider = new LinodeProvider('tok');
    const found = await provider.findServersByName('myapp-prod-primary');
    expect(found.map((s: { id: number }) => s.id)).toEqual([9]);
  });
});

describe('every linode.Instance site squeezes its label', () => {
  // Enumerated, not hand-listed: the k8s tier adds more Instance resources on
  // its own branch, and a copy that ships `label: name` fails the create the
  // moment a realistic project name is used.
  it('no program passes an unsqueezed label to linode.Instance', () => {
    const dir = fileURLToPath(new URL('../../../src/lib/iac/programs', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.startsWith('linode-') && f.endsWith('.js'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (!code.includes('new linode.Instance(')) continue;
      const labels = code.match(/new linode\.Instance\([\s\S]{0,200}?label:\s*([^,\n]+)/g) ?? [];
      expect(labels.length, `${f}: found no linode.Instance label`).toBeGreaterThanOrEqual(1);
      for (const site of labels) {
        expect(site, `${f}: linode.Instance label is not squeezed`).toMatch(
          /squeezeLinodeInstanceLabel\(/,
        );
      }
    }
  });
});
