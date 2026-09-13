/**
 * The provisioning upsell: one reason-driven message, benefits first.
 *
 * Everything priced or named comes from tiers.js — a price or tagline typed
 * into the upsell by hand is exactly the drift that left "$149 one-time" in
 * the CLI after the subscription move. The message also has to be honest
 * about what is NOT gated (redeploy/backup/restore/failover/scale), and must
 * never carry an em dash (see the marketing-copy rule).
 */

import { describe, expect, it } from 'vitest';
import { TIERS } from '../../../src/lib/licensing/tiers.js';
import { buildProvisionUpsell } from '../../../src/lib/licensing/upsell.js';

const PROJECT = {
  projectName: 'acme',
  projectId: '11111111-1111-4111-8111-111111111111',
  version: '9.9.9',
  releaseDate: '2026-09-13',
};

function render(overrides: Record<string, unknown> = {}): string {
  return buildProvisionUpsell({
    ...PROJECT,
    deployTier: 'k8s-ha',
    verdict: { ok: false, requiredTier: 'fullerene', reason: 'no-license', license: null },
    ...overrides,
  }).join('\n');
}

describe('buildProvisionUpsell — frame', () => {
  it('leads with "License required"', () => {
    expect(render().split('\n')[0]).toBe('License required');
  });

  it('states the tier, its tagline lowercased without the period, and the price', () => {
    expect(render()).toContain(
      'This environment needs Fullerene: enterprise resiliency. $39 per project per month.',
    );
  });

  it('takes the tagline and price from tiers.js, not a literal', () => {
    const out = render({
      deployTier: 'k8s',
      verdict: { ok: false, requiredTier: 'graphene', reason: 'no-license', license: null },
    });
    const { name, tagline, price } = TIERS.graphene;
    expect(out).toContain(
      `This environment needs ${name}: ${tagline.toLowerCase().replace(/\.$/, '')}. $${price} per project per month.`,
    );
  });

  it('names the deploy mode being provisioned', () => {
    expect(render()).toContain('Deploy mode: Kubernetes HA');
    expect(render({ deployTier: 'k8s' })).toContain('Deploy mode: Kubernetes');
  });

  it('names Compose HA only when the resolved tier actually is compose-ha', () => {
    expect(render({ deployTier: 'compose-ha' })).toContain('Deploy mode: Compose HA');
    expect(render({ deployTier: 'k8s-ha' })).not.toContain('Compose HA');
  });

  it('says what stays free, including every non-provisioning operation', () => {
    expect(render()).toContain(
      'Single-server Compose is free. Redeploying, backing up, restoring, failing over, ' +
        'and scaling an existing environment never requires a license.',
    );
  });

  it('names the project and carries project + tier on the Subscribe URL', () => {
    const out = render();
    expect(out).toContain(`Project: acme (id ${PROJECT.projectId})`);
    expect(out).toContain(
      `Subscribe: https://vibecarbon.com/pricing?project=${PROJECT.projectId}&tier=fullerene`,
    );
    expect(
      render({
        deployTier: 'k8s',
        verdict: { ok: false, requiredTier: 'graphene', reason: 'no-license', license: null },
      }),
    ).toContain(`tier=graphene`);
  });

  it('offers activation and the terms', () => {
    const out = render();
    expect(out).toContain('Activate:  vibecarbon activate <key>');
    expect(out).toContain('Terms: TERMS.md or https://vibecarbon.com/terms');
  });
});

describe('buildProvisionUpsell — reasons', () => {
  it('no-license adds no reason line', () => {
    const out = render();
    expect(out).not.toContain('subscription for this project');
    expect(out).not.toContain('The stored key is for project');
  });

  it('tier-too-low names what the held tier covers and what this mode needs', () => {
    const out = render({
      deployTier: 'k8s-ha',
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'tier-too-low',
        license: { tier: 'graphene', projectId: PROJECT.projectId, paidThrough: '2027-01-01' },
      },
    });
    expect(out).toContain(
      'Your Graphene subscription for this project covers Kubernetes; ' +
        'Kubernetes HA needs Fullerene.',
    );
  });

  it('wrong-project names both ids and says subscriptions are per project', () => {
    const out = render({
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'wrong-project',
        license: { tier: 'fullerene', projectId: 'other-id', paidThrough: '2027-01-01' },
      },
    });
    expect(out).toContain(
      `The stored key is for project other-id; this project is ${PROJECT.projectId}. ` +
        'Each project has its own subscription.',
    );
  });

  it('lapsed pairs the paid-through date with this release and offers a pinned install', () => {
    const out = render({
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'lapsed',
        license: { tier: 'fullerene', projectId: PROJECT.projectId, paidThrough: '2026-03-01' },
      },
    });
    expect(out).toContain(
      'Your Fullerene subscription for this project is paid through 2026-03-01; ' +
        'vibecarbon v9.9.9 was released 2026-09-13. Renew, or keep using the release you ' +
        'paid for: npm i -g vibecarbon@9.9.9.',
    );
  });
});

describe('buildProvisionUpsell — copy hygiene', () => {
  const REASONS = ['no-license', 'wrong-project', 'tier-too-low', 'lapsed'] as const;

  function everyRendering(): string[] {
    const out: string[] = [];
    for (const reason of REASONS) {
      for (const deployTier of ['k8s', 'k8s-ha', 'compose-ha']) {
        out.push(
          render({
            deployTier,
            verdict: {
              ok: false,
              requiredTier: deployTier === 'k8s' ? 'graphene' : 'fullerene',
              reason,
              license: { tier: 'graphene', projectId: 'other-id', paidThrough: '2026-03-01' },
            },
          }),
        );
      }
    }
    out.push(buildProvisionUpsell({ ...PROJECT, commandName: 'deploy' }).join('\n'));
    return out;
  }

  it('never contains an em dash', () => {
    for (const out of everyRendering()) {
      expect(out).not.toContain('—');
    }
  });

  it('never mentions agencies, client work, or a one-time price', () => {
    for (const out of everyRendering()) {
      expect(out).not.toMatch(/agenc/i);
      expect(out).not.toMatch(/client work/i);
      expect(out).not.toContain('one-time');
      expect(out).not.toContain('$149');
      expect(out).not.toContain('Diamond');
    }
  });

  it('never claims an existing environment needs a license', () => {
    for (const out of everyRendering()) {
      expect(out).not.toMatch(/deploys are free/);
    }
  });
});

describe('buildProvisionUpsell — command-wide gate', () => {
  // The still-unused 'paid' classification in gate.js reuses the same
  // renderer, so there is exactly one place upsell copy can live.
  const out = buildProvisionUpsell({ ...PROJECT, commandName: 'deploy' }).join('\n');

  it('frames the requirement around the command, not an environment', () => {
    expect(out).toContain(
      'The deploy command needs Fullerene: enterprise resiliency. $39 per project per month.',
    );
    expect(out).not.toContain('This environment needs');
  });

  it('omits the deploy-mode proof line when no deploy tier is in play', () => {
    expect(out).not.toContain('Deploy mode:');
  });
});
