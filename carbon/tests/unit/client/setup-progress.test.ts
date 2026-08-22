import { describe, expect, it } from 'vitest';
import { buildSetupProgress, commandForStep, type SetupFlags } from '@/lib/setup-progress';

const base: SetupFlags = {
  email: false,
  oauth: false,
  analytics: false,
  payments: false,
  deployed: false,
  billingOptOut: false,
};

describe('buildSetupProgress', () => {
  it('is a 7-step journey ending in deploy', () => {
    const r = buildSetupProgress(base);
    expect(r.steps.map((s) => s.id)).toEqual([
      'create',
      'customize',
      'email',
      'oauth',
      'analytics',
      'payments',
      'deploy',
    ]);
    expect(r.total).toBe(7);
  });

  it('always counts create + customize as done (non-zero start at 29%)', () => {
    const r = buildSetupProgress(base);
    expect(r.steps.find((s) => s.id === 'create')?.done).toBe(true);
    expect(r.steps.find((s) => s.id === 'customize')?.done).toBe(true);
    expect(r.doneCount).toBe(2);
    expect(r.percent).toBe(29); // round(2/7 * 100)
    expect(r.remaining).toBe(5);
  });

  it('marks the first incomplete step as current', () => {
    expect(buildSetupProgress(base).current?.id).toBe('email');
    expect(buildSetupProgress({ ...base, email: true }).current?.id).toBe('oauth');
  });

  it('reflects detection flags and reaches 100%', () => {
    const r = buildSetupProgress({
      ...base,
      email: true,
      oauth: true,
      analytics: true,
      payments: true,
      deployed: true,
    });
    expect(r.complete).toBe(true);
    expect(r.percent).toBe(100);
    expect(r.current).toBeNull();
  });

  it('treats a billing opt-out as completing the payments step', () => {
    const r = buildSetupProgress({ ...base, billingOptOut: true });
    const pay = r.steps.find((s) => s.id === 'payments');
    expect(pay?.done).toBe(true);
    expect(pay?.optedOut).toBe(true);
    expect(r.current?.id).not.toBe('payments');
  });

  it('exposes integrations only for email and analytics', () => {
    const r = buildSetupProgress(base);
    expect(r.steps.find((s) => s.id === 'email')?.integrations?.map((i) => i.id)).toEqual([
      'resend',
      'postmark',
      'sendgrid',
      'smtp',
    ]);
    expect(r.steps.find((s) => s.id === 'analytics')?.integrations?.map((i) => i.id)).toEqual([
      'plausible',
    ]);
    expect(r.steps.find((s) => s.id === 'oauth')?.integrations).toBeUndefined();
    expect(r.steps.find((s) => s.id === 'payments')?.integrations).toBeUndefined();
    expect(r.steps.find((s) => s.id === 'deploy')?.integrations).toBeUndefined();
  });

  it('marks the partner integration per step (email → resend, analytics → plausible)', () => {
    const r = buildSetupProgress(base);
    expect(r.steps.find((s) => s.id === 'email')?.integrations?.find((i) => i.isPartner)?.id).toBe(
      'resend'
    );
    expect(
      r.steps.find((s) => s.id === 'analytics')?.integrations?.find((i) => i.isPartner)?.id
    ).toBe('plausible');
  });
});

describe('commandForStep', () => {
  it('appends the selected provider to a feature command', () => {
    const email = buildSetupProgress(base).steps.find((s) => s.id === 'email')!;
    expect(commandForStep(email)).toBe('vibecarbon configure email');
    expect(commandForStep(email, 'resend')).toBe('vibecarbon configure email resend');
    expect(commandForStep(email, 'smtp')).toBe('vibecarbon configure email smtp');
  });

  it('leaves non-configure commands untouched', () => {
    const deploy = buildSetupProgress(base).steps.find((s) => s.id === 'deploy')!;
    expect(commandForStep(deploy)).toBe('vibecarbon deploy');
    expect(commandForStep(deploy, 'whatever')).toBe('vibecarbon deploy');
  });
});
