/**
 * The upsell and warning copy: one reason-driven message, benefits first.
 *
 * Everything priced or named comes from tiers.js: a price or tagline typed
 * in by hand is exactly the drift that left "$149 one-time" in the CLI after
 * the subscription move. The message also has to be honest about what is
 * NOT gated (redeploy/backup/restore/failover/scale), and must never carry
 * an em dash (see the marketing-copy rule).
 *
 * `buildDeployUpsell` / `buildDeployWarning` (and their print* wrappers)
 * cover the deploy-time gate (evaluateDeployEntitlement): a blocked verdict
 * `{ ok: false, requiredTier, reason, license, verdict }` renders through
 * buildDeployUpsell; an ok verdict carrying `warning` renders through
 * buildDeployWarning.
 */

import { describe, expect, it } from 'vitest';
import { graceEndOf } from '../../../src/lib/licensing/entitlement.js';
import { getTier } from '../../../src/lib/licensing/tiers.js';
import {
  buildDeployUpsell,
  buildDeployWarning,
  printDeployUpsell,
  printDeployWarning,
} from '../../../src/lib/licensing/upsell.js';

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
      'Subscribe: https://vibecarbon.com/pricing?tier=graphene',
      'Activate:  vibecarbon activate <key>',
      'Terms: TERMS.md or https://vibecarbon.com/terms',
    ]);
  });

  it('unbound: not bound to a project yet, points at activate', () => {
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'graphene',
        reason: 'unbound',
        license: { active: true, key: 'vc-key', licenseId: '0123456789abcdef' },
        verdict: {
          projectId: DEPLOY_PROJECT_ID,
          status: 'unbound',
          tier: 'none',
          periodEnd: '2026-09-15',
          issued: '2026-09-15',
        },
      },
      deployTier: 'k8s',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    const text = lines.join('\n');
    expect(text).toContain('not bound to a project yet');
    expect(text).toContain('vibecarbon activate <key>');
  });

  it('wrong-project: bound to a different project, points at deactivate and the license page', () => {
    const lines = buildDeployUpsell({
      verdict: {
        ok: false,
        requiredTier: 'fullerene',
        reason: 'wrong-project',
        license: { active: true, key: 'vc-key', licenseId: '0123456789abcdef' },
        verdict: {
          projectId: DEPLOY_PROJECT_ID,
          status: 'wrong_project',
          tier: 'none',
          periodEnd: '2026-09-15',
          issued: '2026-09-15',
        },
      },
      deployTier: 'k8s-ha',
      projectName: DEPLOY_PROJECT_NAME,
      projectId: DEPLOY_PROJECT_ID,
    });
    const text = lines.join('\n');
    expect(text).toContain('bound to a different project');
    expect(text).toContain('vibecarbon deactivate');
    expect(text).toContain('https://vibecarbon.com/license');
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
      `Renew: https://vibecarbon.com/pricing?tier=fullerene`,
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
      requiredTier: 'fullerene',
    });
    expect(lines).toEqual([
      "This project's Fullerene subscription ended on 2026-09-01. Deploys keep working for 17 more days.",
      `Renew: https://vibecarbon.com/pricing?tier=fullerene`,
    ]);
  });

  it('canceled: the renew link points at the tier the deploy actually needs, not the tier the project held', () => {
    // The canceled check runs before the tier-sufficiency check
    // (entitlement.js's M-canceled fix aside, a canceled warning is only
    // reachable when the held tier DOES satisfy the deploy, but it need not
    // equal it): held Fullerene, deploying into a Graphene-required mode.
    const lines = buildDeployWarning({
      warning: { kind: 'canceled', daysLeft: 17, tier: 'fullerene', periodEnd: '2026-09-01' },
      projectId: DEPLOY_PROJECT_ID,
      requiredTier: 'graphene',
    });
    expect(lines).toEqual([
      "This project's Fullerene subscription ended on 2026-09-01. Deploys keep working for 17 more days.",
      `Renew: https://vibecarbon.com/pricing?tier=graphene`,
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
          reason: 'unbound',
          license: { active: true, key: 'vc-key', licenseId: '0123456789abcdef' },
          verdict: {
            projectId: DEPLOY_PROJECT_ID,
            status: 'unbound',
            tier: 'none',
            periodEnd: '2026-09-15',
            issued: '2026-09-15',
          },
        },
      },
      {
        deployTier: 'k8s',
        verdict: {
          ok: false,
          requiredTier: 'graphene',
          reason: 'wrong-project',
          license: { active: true, key: 'vc-key', licenseId: '0123456789abcdef' },
          verdict: {
            projectId: DEPLOY_PROJECT_ID,
            status: 'wrong_project',
            tier: 'none',
            periodEnd: '2026-09-15',
            issued: '2026-09-15',
          },
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

    const warnings: Array<{ requiredTier?: string; [key: string]: unknown }> = [
      { kind: 'past-due', daysLeft: 17, tier: 'graphene', periodEnd: '2026-08-01' },
      { kind: 'past-due', daysLeft: 0, tier: 'graphene', periodEnd: '2026-08-01' },
      {
        kind: 'canceled',
        daysLeft: 17,
        tier: 'fullerene',
        periodEnd: '2026-09-01',
        requiredTier: 'fullerene',
      },
      { kind: 'unverified', detail: 'ECONNREFUSED' },
      { kind: 'stale', tier: 'graphene', periodEnd: '2026-07-01' },
      { kind: 'ending', tier: 'graphene', periodEnd: '2026-09-30' },
    ];
    for (const { requiredTier, ...warning } of warnings) {
      out.push(...buildDeployWarning({ warning, projectId: DEPLOY_PROJECT_ID, requiredTier }));
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

  it('no line anywhere contains ?project= (subscribeUrl carries no project param)', () => {
    for (const line of everyDeployLine()) {
      expect(line).not.toContain('?project=');
    }
  });
});
