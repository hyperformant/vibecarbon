import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tests for transactional email templates.
 * Re-implements the template functions from carbon/src/server/emails/templates.ts.
 *
 * Current behavior modeled here:
 *  - Every interpolated text value is passed through escapeHtml() to prevent
 *    HTML injection in emails.
 *  - subscriptionConfirmEmail has no trial param and renders no trial notice
 *    (trials were deferred from the product).
 *
 * The `drift guards` block at the bottom reads the real source to pin these facts.
 */

const PROJECT_NAME = 'TestApp';

/** Escape HTML entities to prevent HTML injection in emails (mirror of templates.ts). */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f4f4f5; color: #18181b; }
    .container { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .card { background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .btn { display: inline-block; padding: 10px 24px; background: #18181b; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #71717a; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    p { font-size: 14px; line-height: 1.6; margin: 0 0 16px; color: #3f3f46; }
    .highlight { background: #f4f4f5; border-radius: 6px; padding: 12px 16px; font-size: 14px; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      ${content}
    </div>
    <div class="footer">
      ${PROJECT_NAME}
    </div>
  </div>
</body>
</html>`;
}

function orgInviteEmail(params: {
  inviterName: string;
  organizationName: string;
  role: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const inviter = escapeHtml(params.inviterName);
  const org = escapeHtml(params.organizationName);
  const role = escapeHtml(params.role);
  return {
    subject: `You've been invited to ${params.organizationName}`,
    html: layout(`
      <h1>You've been invited</h1>
      <p><strong>${inviter}</strong> has invited you to join <strong>${org}</strong> as a <strong>${role}</strong>.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${params.loginUrl}" class="btn">Accept Invitation</a>
      </p>
    `),
  };
}

function subscriptionConfirmEmail(params: {
  userName?: string;
  planName: string;
  amount: string;
  interval: string;
}): { subject: string; html: string } {
  const userName = params.userName ? escapeHtml(params.userName) : null;
  const planName = escapeHtml(params.planName);
  const amount = escapeHtml(params.amount);
  const interval = escapeHtml(params.interval);
  return {
    subject: `Subscription confirmed: ${params.planName} plan`,
    html: layout(`
      <h1>Subscription Confirmed</h1>
      <p>${userName ? `Hi ${userName},` : 'Hi,'}</p>
      <p>You're now on the <strong>${planName}</strong> plan.</p>
      <div class="highlight">
        <strong>${amount}</strong> / ${interval}
      </div>
    `),
  };
}

function paymentFailedEmail(params: { userName?: string; planName: string; billingUrl: string }): {
  subject: string;
  html: string;
} {
  const userName = params.userName ? escapeHtml(params.userName) : null;
  const planName = escapeHtml(params.planName);
  return {
    subject: `Payment failed for your ${PROJECT_NAME} subscription`,
    html: layout(`
      <h1>Payment Failed</h1>
      <p>${userName ? `Hi ${userName},` : 'Hi,'}</p>
      <p>We were unable to process the payment for your <strong>${planName}</strong> plan.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${params.billingUrl}" class="btn">Update Payment Method</a>
      </p>
    `),
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('orgInviteEmail', () => {
  const params = {
    inviterName: 'Bob',
    organizationName: 'Acme Corp',
    role: 'ADMIN',
    loginUrl: 'https://app.example.com/login',
  };

  it('returns correct subject with org name', () => {
    const { subject } = orgInviteEmail(params);
    expect(subject).toContain('Acme Corp');
  });

  it('contains inviter name', () => {
    const { html } = orgInviteEmail(params);
    expect(html).toContain('Bob');
  });

  it('contains organization name', () => {
    const { html } = orgInviteEmail(params);
    expect(html).toContain('Acme Corp');
  });

  it('contains role', () => {
    const { html } = orgInviteEmail(params);
    expect(html).toContain('ADMIN');
  });

  it('contains login URL as link', () => {
    const { html } = orgInviteEmail(params);
    expect(html).toContain('href="https://app.example.com/login"');
  });

  it('escapes HTML in the inviter and organization names', () => {
    const { html } = orgInviteEmail({
      ...params,
      inviterName: '<script>alert(1)</script>',
      organizationName: 'Acme <b>Corp</b> & Co',
    });
    // The raw injection is neutralized...
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>Corp</b>');
    // ...and rendered as escaped entities instead.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Acme &lt;b&gt;Corp&lt;/b&gt; &amp; Co');
  });
});

describe('subscriptionConfirmEmail', () => {
  it('returns correct subject with plan name', () => {
    const { subject } = subscriptionConfirmEmail({
      planName: 'Pro',
      amount: '$79.00',
      interval: 'month',
    });
    expect(subject).toBe('Subscription confirmed: Pro plan');
  });

  it('includes plan name in body', () => {
    const { html } = subscriptionConfirmEmail({
      planName: 'Startup',
      amount: '$19.00',
      interval: 'month',
    });
    expect(html).toContain('Startup');
  });

  it('includes amount and interval', () => {
    const { html } = subscriptionConfirmEmail({
      planName: 'Pro',
      amount: '$79.00',
      interval: 'month',
    });
    expect(html).toContain('$79.00');
    expect(html).toContain('month');
  });

  it('renders no trial notice (trials were deferred from the product)', () => {
    const { html } = subscriptionConfirmEmail({
      planName: 'Pro',
      amount: '$79.00',
      interval: 'month',
    });
    expect(html).not.toContain('free trial');
    expect(html).not.toContain('trial');
  });

  it('uses personalized greeting when userName provided', () => {
    const { html } = subscriptionConfirmEmail({
      userName: 'Dana',
      planName: 'Pro',
      amount: '$79.00',
      interval: 'month',
    });
    expect(html).toContain('Hi Dana,');
  });

  it('escapes HTML in the user name', () => {
    const { html } = subscriptionConfirmEmail({
      userName: '<img src=x onerror=alert(1)>',
      planName: 'Pro',
      amount: '$79.00',
      interval: 'month',
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('paymentFailedEmail', () => {
  const params = {
    planName: 'Pro',
    billingUrl: 'https://app.example.com/settings/billing',
  };

  it('returns correct subject', () => {
    const { subject } = paymentFailedEmail(params);
    expect(subject).toContain('Payment failed');
    expect(subject).toContain('TestApp');
  });

  it('contains plan name', () => {
    const { html } = paymentFailedEmail(params);
    expect(html).toContain('Pro');
  });

  it('contains billing URL as link', () => {
    const { html } = paymentFailedEmail(params);
    expect(html).toContain('href="https://app.example.com/settings/billing"');
  });

  it('uses personalized greeting when userName provided', () => {
    const { html } = paymentFailedEmail({ ...params, userName: 'Eve' });
    expect(html).toContain('Hi Eve,');
  });

  it('uses generic greeting without userName', () => {
    const { html } = paymentFailedEmail(params);
    expect(html).toContain('Hi,');
  });

  it('escapes HTML in the plan name', () => {
    const { html } = paymentFailedEmail({
      ...params,
      planName: 'Pro<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Pro&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// ============================================================================
// DRIFT GUARDS — pin the real carbon/ source these mirrors model.
// ============================================================================

describe('drift guards (carbon/ source)', () => {
  const src = readFileSync(join(process.cwd(), 'carbon/src/server/emails/templates.ts'), 'utf-8');

  it('defines escapeHtml and applies it to interpolated text values', () => {
    expect(src).toMatch(/function escapeHtml\(/);
    expect(src).toMatch(/escapeHtml\(params\.inviterName\)/);
    expect(src).toMatch(/escapeHtml\(params\.organizationName\)/);
    expect(src).toMatch(/escapeHtml\(params\.planName\)/);
    // The escape helper replaces the dangerous characters.
    expect(src).toMatch(/replace\(\/</);
    expect(src).toMatch(/replace\(\/>/);
  });

  it('subscriptionConfirmEmail has no trial param and no trial notice', () => {
    expect(src).not.toMatch(/trial/i);
  });
});
