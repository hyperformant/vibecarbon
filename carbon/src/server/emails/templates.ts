/**
 * Transactional email templates.
 *
 * Uses simple HTML strings rather than React Email to avoid adding
 * a build-time dependency. Swap for @react-email/components if you
 * need richer templating.
 */

const PROJECT_DISPLAY_NAME = '{{PROJECT_DISPLAY_NAME}}';

/** Escape HTML entities to prevent HTML injection in emails */
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
      ${PROJECT_DISPLAY_NAME}
    </div>
  </div>
</body>
</html>`;
}

export function orgInviteEmail(params: {
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
      <p style="font-size: 12px; color: #71717a;">If you don't have an account yet, you'll be able to create one after clicking the link above.</p>
    `),
  };
}

export function subscriptionConfirmEmail(params: {
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
      <p>You can manage your subscription at any time from your billing settings.</p>
    `),
  };
}

export function paymentFailedEmail(params: {
  userName?: string;
  planName: string;
  billingUrl: string;
}): { subject: string; html: string } {
  const userName2 = params.userName ? escapeHtml(params.userName) : null;
  const planName2 = escapeHtml(params.planName);
  return {
    subject: `Payment failed for your ${PROJECT_DISPLAY_NAME} subscription`,
    html: layout(`
      <h1>Payment Failed</h1>
      <p>${userName2 ? `Hi ${userName2},` : 'Hi,'}</p>
      <p>We were unable to process the payment for your <strong>${planName2}</strong> plan. Please update your payment method to avoid any interruption to your service.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${params.billingUrl}" class="btn">Update Payment Method</a>
      </p>
      <p style="font-size: 12px; color: #71717a;">If you believe this is an error, please contact support.</p>
    `),
  };
}
