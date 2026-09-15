/**
 * The upsell and warning copy: one reason-driven message, benefits first.
 *
 * Everything priced or named comes from tiers.js: a price or tagline typed
 * in by hand is exactly the drift that left "$149 one-time" in the CLI after
 * the subscription move. The message also has to be honest about what is
 * NOT gated (redeploy/backup/restore/failover/scale), and must never carry
 * an em dash (see the marketing-copy rule).
 *
 * `buildProvisionUpsell` covers the release-date-based predecessor gate
 * (evaluateEntitlement). It is retired by the deploy-time gate and stays
 * here, unchanged, only until index.js is rewired in C5.
 *
 * `buildDeployUpsell` / `buildDeployWarning` (and their print* wrappers)
 * cover the deploy-time gate (evaluateDeployEntitlement): a blocked verdict
 * `{ ok: false, requiredTier, reason, license, verdict }` renders through
 * buildDeployUpsell; an ok verdict carrying `warning` renders through
 * buildDeployWarning.
 */

import { describe, expect, it } from 'vitest';
import { graceEndOf } from '../../../src/lib/licensing/entitlement.js';
import { getTier, TIERS } from '../../../src/lib/licensing/tiers.js';
import {
  buildDeployUpsell,
  buildDeployWarning,
  buildProvisionUpsell,
  printDeployUpsell,
  printDeployWarning,
} from '../../../src/lib/licensing/upsell.js';

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
      'Single-server Compose needs no key. Redeploying, backing up, restoring, failing over, ' +
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

  it('wrong-project reads storedProjectId when the key is on disk but inactive', () => {
    // The shape the real gate produces: getLicense never activates a key for
    // another project, so the id it found rides on storedProjectId.
    const out = render({
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'wrong-project',
        license: { tier: 'graphite', active: false, projectId: null, storedProjectId: 'other-id' },
      },
    });
    expect(out).toContain(
      `The stored key is for project other-id; this project is ${PROJECT.projectId}. ` +
        'Each project has its own subscription.',
    );
  });

  it('lapsed pairs the paid-through date with this release and points at a pinned-install source, never this VERSION', () => {
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
        'vibecarbon v9.9.9 was released 2026-09-13. Renew, or install a release published on ' +
        'or before 2026-03-01. npm view vibecarbon time lists release dates.',
    );
    // The controller ruling this replaced: the CLI cannot know offline which
    // past releases still fall within paidThrough, so it must never pin the
    // CURRENT (unrenewed) version as if it were still covered.
    expect(out).not.toContain('npm i -g vibecarbon@9.9.9');
    expect(out).not.toContain('keep using the release you paid for');
  });

  it('lapsed gains the offline line only when refreshOffline is set', () => {
    const base = {
      ok: false,
      requiredTier: 'fullerene',
      reason: 'lapsed',
      license: { tier: 'fullerene', projectId: PROJECT.projectId, paidThrough: '2026-03-01' },
    };
    const withoutOffline = render({ verdict: base });
    expect(withoutOffline).not.toContain('Could not reach vibecarbon.com');

    const withOffline = render({ verdict: { ...base, refreshOffline: true } });
    expect(withOffline).toContain(
      'Could not reach vibecarbon.com. If you renewed, run vibecarbon activate <key> from your email.',
    );
  });

  it('refreshOffline is ignored on every reason other than lapsed', () => {
    for (const reason of ['no-license', 'wrong-project', 'tier-too-low']) {
      const out = render({
        verdict: {
          ok: false,
          requiredTier: 'fullerene',
          reason,
          refreshOffline: true,
          license: { tier: 'graphene', projectId: PROJECT.projectId, paidThrough: '2026-03-01' },
        },
      });
      expect(out, `reason=${reason}`).not.toContain('Could not reach vibecarbon.com');
    }
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

const DEPLOY_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEPLOY_PROJECT_NAME = 'acme';

describe('buildDeployUpsell - block reasons', () => {
  it('no-license: benefits, deploy mode, the free line, then how to act', () => {
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'graphene',
        reason: 'no-license',
        license: null,
        verdict: null,
      },
      deployTier: 'k8s',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      'License required',
      '',
      'This environment needs Graphene: scale on demand. $19 per project per month.',
      'Deploy mode: Kubernetes',
      'Single-server Compose needs no key. Backing up, restoring, failing over, and scaling never require a license.',
      '',
      `Project: ${DEPLOY_PROJECT_NAME} (id ${DEPLOY_PROJECT_ID})`,
      `Subscribe: https://vibecarbon.com/pricing?project=${DEPLOY_PROJECT_ID}&tier=graphene`,
      'Activate:  vibecarbon activate <key>',
      'Terms: TERMS.md or https://vibecarbon.com/terms',
    ]);
  });

  it('wrong-project: inserts the mismatch line after the free line', () => {
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'graphene',
        reason: 'wrong-project',
        license: { active: false, storedProjectId: 'other-id' },
        verdict: null,
      },
      deployTier: 'k8s',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      'License required',
      '',
      'This environment needs Graphene: scale on demand. $19 per project per month.',
      'Deploy mode: Kubernetes',
      'Single-server Compose needs no key. Backing up, restoring, failing over, and scaling never require a license.',
      'The stored key belongs to project other-id. Each project has its own subscription.',
      '',
      `Project: ${DEPLOY_PROJECT_NAME} (id ${DEPLOY_PROJECT_ID})`,
      `Subscribe: https://vibecarbon.com/pricing?project=${DEPLOY_PROJECT_ID}&tier=graphene`,
      'Activate:  vibecarbon activate <key>',
      'Terms: TERMS.md or https://vibecarbon.com/terms',
    ]);
  });

  it('tier-too-low: names the held tier, points at the license page, no Subscribe line', () => {
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'tier-too-low',
        license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'graphene' },
        verdict: {
          projectId: DEPLOY_PROJECT_ID,
          status: 'active',
          tier: 'graphene',
          periodEnd: '2027-01-01',
          issued: '2026-01-01',
        },
      },
      deployTier: 'k8s-ha',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      'Plan switch required',
      '',
      'This environment needs Fullerene: enterprise resiliency. $39 per project per month.',
      'Deploy mode: Kubernetes HA',
      'This project is on Graphene.',
      '',
      `Project: ${DEPLOY_PROJECT_NAME} (id ${DEPLOY_PROJECT_ID})`,
      'Switch plans: https://vibecarbon.com/license',
      'Terms: TERMS.md or https://vibecarbon.com/terms',
    ]);
    expect(lines.join('\n')).not.toContain('Subscribe:');
  });

  it('past-due, grace over: names the grace end date and points at billing', () => {
    const periodEnd = '2026-07-01';
    const graceEnd = graceEndOf(periodEnd);
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'graphene',
        reason: 'past-due',
        license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'graphene' },
        verdict: {
          projectId: DEPLOY_PROJECT_ID,
          status: 'past_due',
          tier: 'graphene',
          periodEnd,
          issued: '2026-01-01',
        },
      },
      deployTier: 'k8s',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      'Payment required',
      '',
      `Payment for this project's Graphene subscription failed and the 30-day grace period ended on ${graceEnd}.`,
      'Update your card to deploy to Kubernetes again.',
      '',
      `Project: ${DEPLOY_PROJECT_NAME} (id ${DEPLOY_PROJECT_ID})`,
      'Billing: https://vibecarbon.com/license',
      'Terms: TERMS.md or https://vibecarbon.com/terms',
    ]);
  });

  it('canceled, grace over: names the period end date and points at renewal', () => {
    const periodEnd = '2026-08-01';
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'canceled',
        license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'fullerene' },
        verdict: {
          projectId: DEPLOY_PROJECT_ID,
          status: 'canceled',
          tier: 'fullerene',
          periodEnd,
          issued: '2026-01-01',
        },
      },
      deployTier: 'k8s-ha',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      'Subscription ended',
      '',
      `This project's Fullerene subscription ended on ${periodEnd} and the 30-day grace period is over.`,
      'Renew to deploy to Kubernetes HA again.',
      '',
      `Project: ${DEPLOY_PROJECT_NAME} (id ${DEPLOY_PROJECT_ID})`,
      `Renew: https://vibecarbon.com/pricing?project=${DEPLOY_PROJECT_ID}&tier=fullerene`,
      'Terms: TERMS.md or https://vibecarbon.com/terms',
    ]);
  });

  it('reads the tier price and tagline from tiers.js, not a literal', () => {
    const tier = getTier('graphene');
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'graphene',
        reason: 'no-license',
        license: null,
        verdict: null,
      },
      deployTier: 'k8s',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toContain(
      `This environment needs ${tier.name}: ${tier.tagline.toLowerCase().replace(/\.$/, '')}. $${tier.price} per project per month.`,
    );
  });
});

describe('buildDeployWarning - warning kinds', () => {
  it('past-due, 17 days left', () => {
    const lines = buildDeployWarning({
      warning: { kind: 'past-due', daysLeft: 17, tier: 'graphene', periodEnd: '2026-08-01' },
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      "Payment for this project's Graphene subscription failed. Deploys keep working for 17 more days.",
      'Update your card: https://vibecarbon.com/license',
    ]);
  });

  it('past-due, 0 days left reads "through today"', () => {
    const lines = buildDeployWarning({
      warning: { kind: 'past-due', daysLeft: 0, tier: 'graphene', periodEnd: '2026-08-01' },
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      "Payment for this project's Graphene subscription failed. Deploys keep working through today.",
      'Update your card: https://vibecarbon.com/license',
    ]);
  });

  it('canceled, 17 days left', () => {
    const lines = buildDeployWarning({
      warning: { kind: 'canceled', daysLeft: 17, tier: 'fullerene', periodEnd: '2026-09-01' },
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      "This project's Fullerene subscription ended on 2026-09-01. Deploys keep working for 17 more days.",
      `Renew: https://vibecarbon.com/pricing?project=${DEPLOY_PROJECT_ID}&tier=fullerene`,
    ]);
  });

  it('unverified names the failure detail', () => {
    const lines = buildDeployWarning({
      warning: { kind: 'unverified', detail: 'ECONNREFUSED' },
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      "Could not reach vibecarbon.com to verify this project's license (ECONNREFUSED). Deploying anyway; the next online deploy will check again.",
    ]);
  });

  it('stale names the period boundary that could not be confirmed', () => {
    const lines = buildDeployWarning({
      warning: { kind: 'stale', tier: 'graphene', periodEnd: '2026-07-01' },
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      "Could not confirm this project's subscription renewed after 2026-07-01. Deploying anyway; the next online deploy will check again.",
    ]);
  });

  it('ending names the scheduled end date and the grace window', () => {
    const lines = buildDeployWarning({
      warning: { kind: 'ending', tier: 'graphene', periodEnd: '2026-09-30' },
      projectId: DEPLOY_PROJECT_ID,
    });
    expect(lines).toEqual([
      "This project's Graphene subscription is set to end on 2026-09-30. Deploys continue for 30 days after that.",
    ]);
  });

  it('an unrecognized kind renders nothing', () => {
    expect(
      buildDeployWarning({ warning: { kind: 'made-up' }, projectId: DEPLOY_PROJECT_ID }),
    ).toEqual([]);
  });
});

function fakeColor() {
  return {
    warning: (s: string) => `[warn]${s}[/warn]`,
    dim: (s: string) => `[dim]${s}[/dim]`,
    info: (s: string) => `[info]${s}[/info]`,
  };
}

describe('printDeployUpsell', () => {
  it('indents every line, colors the headline, and colors labelled action lines', () => {
    const logged: string[] = [];
    printDeployUpsell(
      {
        verdict: {
          ok: false,
          requiredTier: 'graphene',
          reason: 'no-license',
          license: null,
          verdict: null,
        },
        deployTier: 'k8s',
        projectName: DEPLOY_PROJECT_NAME,
        projectId: DEPLOY_PROJECT_ID,
      },
      { c: fakeColor(), log: (line: string) => logged.push(line) },
    );
    expect(logged[0]).toBe('');
    expect(logged[logged.length - 1]).toBe('');
    expect(logged).toContain('  [warn]License required[/warn]');
    expect(logged.some((l) => l.includes('[dim]Subscribe:[/dim]') && l.includes('[info]'))).toBe(
      true,
    );
    expect(logged.some((l) => l.includes('[dim]Activate:[/dim]') && l.includes('[info]'))).toBe(
      true,
    );
  });

  it('colors the license-page and billing labels on the other reasons', () => {
    const logged: string[] = [];
    printDeployUpsell(
      {
        verdict: {
          ok: false,
          requiredTier: 'fullerene',
          reason: 'tier-too-low',
          license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'graphene' },
          verdict: {
            projectId: DEPLOY_PROJECT_ID,
            status: 'active',
            tier: 'graphene',
            periodEnd: '2027-01-01',
            issued: '2026-01-01',
          },
        },
        deployTier: 'k8s-ha',
        projectName: DEPLOY_PROJECT_NAME,
        projectId: DEPLOY_PROJECT_ID,
      },
      { c: fakeColor(), log: (line: string) => logged.push(line) },
    );
    expect(logged).toContain('  [warn]Plan switch required[/warn]');
    expect(logged.some((l) => l.includes('[dim]Switch plans:[/dim]') && l.includes('[info]'))).toBe(
      true,
    );
  });
});

describe('printDeployWarning', () => {
  it('colors the first line as a warning and any remaining line as info', () => {
    const logged: string[] = [];
    printDeployWarning(
      {
        warning: { kind: 'past-due', daysLeft: 17, tier: 'graphene', periodEnd: '2026-08-01' },
        projectId: DEPLOY_PROJECT_ID,
      },
      { c: fakeColor(), log: (line: string) => logged.push(line) },
    );
    expect(logged[0]).toBe('');
    expect(logged[logged.length - 1]).toBe('');
    expect(logged[1]).toContain('[warn]');
    expect(logged[2]).toContain('[info]');
  });

  it('prints nothing for an unrecognized warning kind', () => {
    const logged: string[] = [];
    printDeployWarning(
      { warning: { kind: 'made-up' }, projectId: DEPLOY_PROJECT_ID },
      { c: fakeColor(), log: (line: string) => logged.push(line) },
    );
    expect(logged).toEqual([]);
  });
});

describe('deploy gate copy hygiene', () => {
  function everyDeployLine(): string[] {
    const out: string[] = [];
    const blocked: Array<{ verdict: unknown; deployTier: string }> = [
      {
        deployTier: 'k8s',
        verdict: {
          ok: false,
          requiredTier: 'graphene',
          reason: 'no-license',
          license: null,
          verdict: null,
        },
      },
      {
        deployTier: 'k8s',
        verdict: {
          ok: false,
          requiredTier: 'graphene',
          reason: 'wrong-project',
          license: { active: false, storedProjectId: 'other-id' },
          verdict: null,
        },
      },
      {
        deployTier: 'k8s-ha',
        verdict: {
          ok: false,
          requiredTier: 'fullerene',
          reason: 'tier-too-low',
          license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'graphene' },
          verdict: {
            projectId: DEPLOY_PROJECT_ID,
            status: 'active',
            tier: 'graphene',
            periodEnd: '2027-01-01',
            issued: '2026-01-01',
          },
        },
      },
      {
        deployTier: 'k8s',
        verdict: {
          ok: false,
          requiredTier: 'graphene',
          reason: 'past-due',
          license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'graphene' },
          verdict: {
            projectId: DEPLOY_PROJECT_ID,
            status: 'past_due',
            tier: 'graphene',
            periodEnd: '2026-07-01',
            issued: '2026-01-01',
          },
        },
      },
      {
        deployTier: 'k8s-ha',
        verdict: {
          ok: false,
          requiredTier: 'fullerene',
          reason: 'canceled',
          license: { active: true, projectId: DEPLOY_PROJECT_ID, tier: 'fullerene' },
          verdict: {
            projectId: DEPLOY_PROJECT_ID,
            status: 'canceled',
            tier: 'fullerene',
            periodEnd: '2026-08-01',
            issued: '2026-01-01',
          },
        },
      },
    ];

    for (const b of blocked) {
      out.push(
        ...buildDeployUpsell({
          verdict: b.verdict,
          deployTier: b.deployTier,
          projectName: DEPLOY_PROJECT_NAME,
          projectId: DEPLOY_PROJECT_ID,
        }),
      );
    }

    const warnings = [
      { kind: 'past-due', daysLeft: 17, tier: 'graphene', periodEnd: '2026-08-01' },
      { kind: 'past-due', daysLeft: 0, tier: 'graphene', periodEnd: '2026-08-01' },
      { kind: 'canceled', daysLeft: 17, tier: 'fullerene', periodEnd: '2026-09-01' },
      { kind: 'unverified', detail: 'ECONNREFUSED' },
      { kind: 'stale', tier: 'graphene', periodEnd: '2026-07-01' },
      { kind: 'ending', tier: 'graphene', periodEnd: '2026-09-30' },
    ];
    for (const warning of warnings) {
      out.push(...buildDeployWarning({ warning, projectId: DEPLOY_PROJECT_ID }));
    }

    return out.filter((line) => line !== '');
  }

  it('never contains an em dash', () => {
    for (const line of everyDeployLine()) {
      expect(line).not.toContain('\u2014');
    }
  });

  it('never mentions agencies, client work, a one-time price, or the retired Diamond tier', () => {
    for (const line of everyDeployLine()) {
      expect(line).not.toMatch(/agenc/i);
      expect(line).not.toMatch(/client work/i);
      expect(line).not.toContain('one-time');
      expect(line).not.toContain('$149');
      expect(line).not.toContain('Diamond');
    }
  });

  it('never puts "free" next to "server" or "deploy"', () => {
    for (const line of everyDeployLine()) {
      expect(line).not.toMatch(/free\b[^.]*\b(server|deploy)|\b(server|deploy)[^.]*\bfree/i);
    }
  });
});
