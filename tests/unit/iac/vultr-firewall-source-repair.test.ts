/**
 * The Vultr firewall-rule `source` repair.
 *
 * `source` is WRITE-"" / READ-CIDR asymmetric on Vultr: the provider
 * declares it `"" | "cloudflare"` (a rule SOURCE TYPE) while the API's READ
 * derives an address and returns it in the same field. `refresh` copies
 * outputs into inputs, so one refresh leaves the stack's INPUTS holding a
 * value the provider's own schema rejects.
 *
 * Both obvious "fixes" were tried on live infra on 2026-08-20 and both
 * failed, which is why this repair exists and why it must not be traded back
 * for either of them:
 *   - leaving it: `up` sees `[diff: ~source]`, `source` is ForceNew, the
 *     rule REPLACES create-before-delete, and Vultr 400s
 *     "This rule is already defined" on the duplicate.
 *   - `ignoreChanges: ['source']`: substitutes the STATE value for the
 *     program's, so `up` fails validation with
 *     `expected source to be one of ["" "cloudflare"], got 0.0.0.0/0`.
 *
 * These tests exercise the repair against real exported-state shapes rather
 * than asserting on source text, so they fail if the behaviour regresses
 * even when the code still "looks" right.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { repairVultrFirewallRuleInputs } from '../../../src/lib/iac/index.js';

const RULE = 'vultr:index/firewallRule:FirewallRule';

/**
 * Minimal exported-state shape. `source` sets BOTH sides; `outSource` sets
 * the output side independently, which is how the real states look — a
 * cold deploy leaves inputs='' with outputs=<CIDR>, and a refresh copies
 * the CIDR across into inputs too.
 */
const stateWith = (rules: { source?: unknown; outSource?: unknown }[], type = RULE) => ({
  deployment: {
    resources: [
      { type: 'pulumi:pulumi:Stack', inputs: {} },
      ...rules.map((r, i) => ({
        type,
        urn: `urn:pulumi:v2::p::${type}::rule-${i}`,
        inputs: {
          subnet: '0.0.0.0',
          subnetSize: 0,
          port: '443',
          ...(r.source !== undefined ? { source: r.source } : {}),
        },
        outputs: {
          ...('outSource' in r
            ? { source: r.outSource }
            : r.source !== undefined
              ? { source: r.source }
              : {}),
        },
      })),
    ],
  },
});

const fakeStack = (state: unknown) => {
  const imported: unknown[] = [];
  return {
    stack: {
      exportStack: vi.fn(async () => state),
      importStack: vi.fn(async (s: unknown) => {
        imported.push(s);
      }),
    },
    imported,
  };
};

describe('repairVultrFirewallRuleInputs', () => {
  it('blanks an API-derived CIDR that refresh wrote into inputs', async () => {
    // The exact poisoning observed live: primary stack, all 7 rules.
    const state = stateWith([
      { source: '0.0.0.0/0' },
      { source: '::/0' },
      { source: '162.227.97.176/32' },
    ]);
    const { stack, imported } = fakeStack(state);

    const repaired = await repairVultrFirewallRuleInputs(stack as never);

    expect(repaired).toBe(3);
    expect(stack.importStack).toHaveBeenCalledTimes(1);
    for (const r of (imported[0] as typeof state).deployment.resources.slice(1)) {
      expect(r.inputs.source).toBe('');
      expect(r.outputs.source).toBe('');
    }
  });

  it('leaves a clean stack alone and never writes state', async () => {
    // Cold-deploy shape: inputs.source is already ''. Importing state is a
    // real write against the backend, so a no-op repair must not do one.
    const { stack } = fakeStack(stateWith([{ source: '' }, { source: '' }]));

    expect(await repairVultrFirewallRuleInputs(stack as never)).toBe(0);
    expect(stack.importStack).not.toHaveBeenCalled();
  });

  it('repairs the COLD-DEPLOY shape too — outputs are what `up` diffs against', async () => {
    // inputs='' / outputs=<CIDR> is exactly how a freshly-created stack
    // looks (verified on the live v2 standby). Pulumi asks the provider to
    // diff the program against the resource's STORED STATE, so leaving the
    // CIDR in outputs keeps `~source` on the diff and the rule still
    // replaces — an inputs-only repair logged "repaired 7" live and the
    // same `up` still failed every rule.
    const state = stateWith([{ source: '', outSource: '0.0.0.0/0' }]);
    const { stack, imported } = fakeStack(state);

    expect(await repairVultrFirewallRuleInputs(stack as never)).toBe(1);
    const rule = (imported[0] as typeof state).deployment.resources[1];
    expect(rule.outputs.source).toBe('');
    expect(rule.inputs.source).toBe('');
  });

  it('leaves inputs that never had a source alone', async () => {
    const { stack } = fakeStack(stateWith([{}, {}]));

    expect(await repairVultrFirewallRuleInputs(stack as never)).toBe(0);
    expect(stack.importStack).not.toHaveBeenCalled();
  });

  it('does not clobber a legitimate `cloudflare` source', async () => {
    // We never set it today, but it IS a valid value. A repair that blanked
    // every non-empty source would silently rewrite a deliberate choice.
    const { stack } = fakeStack(stateWith([{ source: 'cloudflare' }]));

    expect(await repairVultrFirewallRuleInputs(stack as never)).toBe(0);
    expect(stack.importStack).not.toHaveBeenCalled();
  });

  it('touches no other resource type — this is not a general state rewriter', async () => {
    const { stack } = fakeStack(
      stateWith([{ source: '0.0.0.0/0' }], 'hcloud:index/firewall:Firewall'),
    );

    expect(await repairVultrFirewallRuleInputs(stack as never)).toBe(0);
    expect(stack.importStack).not.toHaveBeenCalled();
  });

  it('swallows an export failure rather than blocking the up it precedes', async () => {
    const stack = {
      exportStack: vi.fn(async () => {
        throw new Error('backend unreachable');
      }),
      importStack: vi.fn(),
    };

    await expect(repairVultrFirewallRuleInputs(stack as never)).resolves.toBe(0);
  });

  it('swallows an import failure the same way', async () => {
    const stack = {
      exportStack: vi.fn(async () => stateWith([{ source: '0.0.0.0/0' }])),
      importStack: vi.fn(async () => {
        throw new Error('state lock held');
      }),
    };

    await expect(repairVultrFirewallRuleInputs(stack as never)).resolves.toBe(0);
  });
});

describe('the repair is actually wired into the pre-up path', () => {
  const iac = readFileSync(
    fileURLToPath(new URL('../../../src/lib/iac/index.js', import.meta.url)),
    'utf8',
  );
  const code = iac.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('runs after the pre-up refresh, not somewhere else', () => {
    // Comment-stripped: the prose above the call quotes the function name
    // while explaining it, so a raw grep would be satisfied by its own docs.
    expect(code).toMatch(/await repairVultrFirewallRuleInputs\(stack\);/);
    const refreshAt = code.indexOf("'pre-up refresh'");
    const repairAt = code.indexOf('await repairVultrFirewallRuleInputs(');
    expect(refreshAt).toBeGreaterThan(-1);
    expect(repairAt).toBeGreaterThan(refreshAt);
  });

  it('the comment stripper really removes prose, so the check above is about CODE', () => {
    // Self-check for the guard above. The file discusses this repair at
    // length in comments; if stripping ever stopped working, the assertion
    // above would quietly become an assertion about documentation.
    const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    expect(count(iac, /refresh/gi)).toBeGreaterThan(count(code, /refresh/gi));
    // Exactly two code occurrences survive: the definition and the call.
    expect(count(code, /repairVultrFirewallRuleInputs/g)).toBe(2);
  });
});

describe('no program tries to fix this itself', () => {
  // Enumerated, not hand-listed: a new provider tier copying the resource
  // inherits the guard instead of the bug. The central repair covers every
  // Vultr firewall rule automatically, so a program only breaks things by
  // reaching for one of the two local "fixes" that were disproven live.
  const dir = fileURLToPath(new URL('../../../src/lib/iac/programs', import.meta.url));
  const programs = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes('new vultr.FirewallRule'));

  it('finds at least one program building vultr.FirewallRule (not vacuous)', () => {
    expect(programs.length).toBeGreaterThanOrEqual(1);
  });

  for (const f of programs) {
    describe(f, () => {
      const raw = () => readFileSync(join(dir, f), 'utf8');
      const stripped = () =>
        raw()
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');

      it('never declares source, and never reaches for ignoreChanges', () => {
        expect(stripped()).not.toMatch(/^\s*source:/m);
        expect(stripped()).not.toMatch(/ignoreChanges/);
      });

      it('points the next reader at the central repair', () => {
        expect(raw()).toMatch(/repairVultrFirewallRuleInputs/);
      });
    });
  }
});
