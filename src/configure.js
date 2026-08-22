/**
 * Vibecarbon Configure Command
 * Interactive wizard for configuring external services (billing, OAuth, SMTP, etc.)
 *
 * Guides the user through selecting which features to enable and entering
 * the required credentials. Provider credentials (Providers feature) go to
 * .env.local only — every other feature writes both .env.local and .env.
 *
 * Usage:
 *   vibecarbon configure                    # Interactive configuration wizard
 *   vibecarbon configure <feature> [provider]
 *                                           # Configure one feature directly, skipping the menu
 *                                           #   e.g. vibecarbon configure email resend
 *                                           #        vibecarbon configure payments stripe
 *                                           #        vibecarbon configure oauth google
 *   vibecarbon configure cicd               # Install GitHub Actions build + deploy workflows
 *   vibecarbon configure cicd <env>         # ...and layer Flux GitOps if <env> is a k8s cluster
 *   vibecarbon configure -h                 # Show help
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { formatAmount, listStripePrices } from './lib/billing/stripe-catalog.js';
import { writeBillingCatalog } from './lib/billing/write-catalog.js';
import { exitCancelled } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { c } from './lib/colors.js';
import { loadProjectConfig } from './lib/config.js';
import {
  featureKeys,
  featureSecretKeys,
  isOperatorKey,
  operatorSecretKeys,
} from './lib/config-registry.js';
import { promptProviders } from './lib/configure-providers.js';
import { DNS_PROVIDERS } from './lib/dns-provider.js';
import { envSummaryLines } from './lib/env-summary.js';
import {
  addLocale,
  BASE_LOCALE,
  status as globalizationStatus,
  installedLocales,
  removeLocale,
  SUPPORTED_LOCALES,
} from './lib/globalization.js';
import { buildGitAddArgv, loadEnvVariables, setEnvVar } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { validateAdminEmail } from './lib/validators.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'configure',
  summary: 'Configure external services (billing, OAuth, SMTP, CI/CD)',
  description: [
    'Interactive wizard for configuring external services in your Vibecarbon',
    'project. Walks you through enabling features and entering API keys.',
    'Provider credentials (Providers feature) go to .env.local only; every',
    'other feature writes both .env.local and .env.',
    '',
    'Configured credentials are deployed automatically when you run',
    '`vibecarbon deploy`.',
    '',
    'DIRECT FEATURE SUBCOMMANDS',
    '  Run `vibecarbon configure <feature> [provider]` to configure a single',
    '  feature without the interactive menu. An optional [provider] preselects',
    "  the feature's provider so you skip its provider-choice prompt:",
    '    email | smtp    <resend | postmark | sendgrid | smtp>',
    '    payments        <stripe>',
    '    oauth           <google | microsoft>',
    '    analytics       (no provider: Plausible)',
    '    providers       (cloud/DNS credentials picker)',
    '    globalization   (no provider: which languages the app ships)',
    '',
    'CICD SUBCOMMAND',
    '  cicd         Install the GitHub Actions build + deploy workflows.',
    '               Works in every deploy mode, and is free.',
    '  cicd <env>   The same, then layer Flux GitOps onto <env> when it is a',
    '               k8s/k8s-ha cluster. Compose deploys by push from Actions',
    '               and needs no Flux, so naming a Compose env just does the',
    '               workflows.',
    '',
    'CONFIGURABLE FEATURES',
    '  Providers, cloud/DNS credentials for deploys (written to .env.local; never committed, never shipped to servers)',
    '  Globalization Which languages the app ships (English only by default)',
    '  CI/CD         Auto build & deploy with GitHub Actions',
    '  Payments      Stripe payments (subscriptions + one-time)',
    '  OAuth         Sign in with Google or Microsoft',
    '  SMTP / Email  Transactional emails (Resend, Postmark, SendGrid, or any SMTP)',
    '  Analytics     Privacy-friendly web analytics (Plausible)',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
  ],
  examples: [
    {
      command: 'vibecarbon configure',
      description: 'Configure a new project after creation (interactive menu)',
    },
    {
      command: 'vibecarbon configure email resend',
      description: 'Configure transactional email via Resend, skipping the menu',
    },
    {
      command: 'vibecarbon configure payments',
      description: 'Configure Stripe payments directly',
    },
    {
      command: 'vibecarbon configure oauth google',
      description: 'Configure Google sign-in',
    },
    {
      command: 'vibecarbon configure globalization',
      description: 'Choose which languages the app ships',
    },
    {
      command: 'vibecarbon configure cicd',
      description: 'Install the GitHub Actions build + deploy workflows',
    },
    {
      command: 'vibecarbon configure cicd prod',
      description: 'The same, plus Flux GitOps when prod is a k8s cluster',
    },
  ],
};

// ============================================================================
// FEATURE PROMPT FUNCTIONS
// ============================================================================

/**
 * Helper: prompt for a text value, showing current value as placeholder.
 * Returns the entered value, or the current value if user pressed Enter on a non-empty placeholder.
 */
async function promptText(message, currentValue, options = {}) {
  const fallback = currentValue || options.defaultValue || undefined;
  const placeholder = fallback || options.placeholder || '';
  const result = await p.text({
    message,
    placeholder: placeholder ? `${placeholder}` : undefined,
    defaultValue: fallback,
    // @clack's text prompt runs validate on the raw (possibly empty) value before
    // substituting defaultValue, so a bare validate would reject Enter-on-default.
    // When we have a default, accept empty submit (Tab/Enter) and fall back to it.
    validate: (value) => {
      if (!value?.trim() && fallback !== undefined) return undefined;
      return options.validate?.(value);
    },
  });
  if (p.isCancel(result)) return null;
  return result || fallback || '';
}

function requireNonEmpty(label) {
  return (value) => {
    if (!value?.trim()) return `${label} is required`;
    return undefined;
  };
}

/**
 * Helper: prompt for a secret value (masked input).
 */
async function promptSecret(message, currentValue) {
  const result = await p.password({
    message: currentValue ? `${message} ${c.dim('(press Enter to keep current)')}` : message,
    validate: (v) => {
      if (!v && !currentValue) return 'This field is required';
    },
  });
  if (p.isCancel(result)) return null;
  // If user pressed Enter with no input and there's a current value, keep it
  return result || currentValue || '';
}

/**
 * Best-effort deploy domain for project-aware prompt suggestions.
 * Prefers the prod environment, then any environment that has a domain.
 * Returns null when the project hasn't been deployed / has no domain yet.
 */
function projectDomain(projectConfig) {
  const envs = projectConfig?.environments;
  if (!envs) return null;
  if (envs.prod?.domain) return envs.prod.domain;
  for (const e of Object.values(envs)) {
    if (e?.domain) return e.domain;
  }
  return null;
}

// ---- Billing ----

// Webhook endpoint that all billing providers point at. The unified handler
// (carbon/src/server/routes/webhooks/billing.ts) dispatches based on the
// active provider; Stripe also keeps /api/webhooks/stripe for back-compat.
const BILLING_WEBHOOK_PATH = '/api/webhooks/billing';

// `parked: true` disables a billing provider for this release without removing
// its setup flow below or the server-side adapter — Stripe is the only fully
// tested path for now. Paddle/Polar are hidden from the provider prompt and the
// app won't be configured to use them; flip `parked` off to re-enable once
// they're validated. Mirrors the parked-feature pattern in src/add.js.
const BILLING_PROVIDERS = [
  { value: 'stripe', label: 'Stripe', hint: 'most popular' },
  { value: 'paddle', label: 'Paddle', hint: 'merchant of record', parked: true },
  { value: 'polar', label: 'Polar', hint: 'open-source focused', parked: true },
];

async function promptBilling(env, _ctx = {}, { provider: preselected } = {}) {
  p.log.info(c.bold('Billing Configuration'));
  p.log.info(c.dim('Choose your payment provider and enter API credentials.'));

  const availableProviders = BILLING_PROVIDERS.filter((bp) => !bp.parked);

  let provider;
  const preselectedEntry = preselected && availableProviders.find((bp) => bp.value === preselected);
  if (preselectedEntry) {
    // Provider passed on the command line (`configure payments <provider>`).
    provider = preselectedEntry.value;
    p.log.info(`Billing provider: ${c.bold(preselectedEntry.label)}`);
  } else if (availableProviders.length === 1) {
    // Only one provider enabled this release — no point prompting; use it.
    provider = availableProviders[0].value;
    p.log.info(`Billing provider: ${c.bold(availableProviders[0].label)}`);
  } else {
    const current = availableProviders.some((bp) => bp.value === env.BILLING_PROVIDER)
      ? env.BILLING_PROVIDER
      : availableProviders[0].value;
    const selected = await p.select({
      message: 'Billing provider',
      options: availableProviders.map((bp) => ({
        value: bp.value,
        label: bp.label,
        hint: bp.hint,
      })),
      initialValue: current,
    });
    if (p.isCancel(selected)) return null;
    provider = selected;
  }

  const vars = { BILLING_PROVIDER: provider };

  if (provider === 'stripe') {
    p.note(
      [
        `${c.bold('1. Create your products in Stripe FIRST')}`,
        `   ${c.info('https://dashboard.stripe.com/products')}`,
        '   Add a product for each plan you want to sell and give it a price, ',
        `   ${c.dim('recurring')} for subscriptions or ${c.dim('one-time')} for single purchases.`,
        `   Name them anything you like; we'll sync them in and let you pick which to activate.`,
        '',
        `${c.bold('2. Secret key')}`,
        `   ${c.info('https://dashboard.stripe.com/apikeys')}`,
        `   Use ${c.dim('sk_test_...')} for testing or ${c.dim('sk_live_...')} in production.`,
        '',
        `${c.bold('3. Webhook')} (Workbench → Webhooks → Create an event destination)`,
        `   ${c.info('https://dashboard.stripe.com/webhooks')}`,
        `   • Endpoint URL: ${c.dim(`https://<your-domain>${BILLING_WEBHOOK_PATH}`)}`,
        '   • Events to send:',
        '       checkout.session.completed',
        '       customer.subscription.created',
        '       customer.subscription.updated',
        '       customer.subscription.deleted',
        '       invoice.payment_failed',
        `   • After creating, click ${c.dim('Reveal')} to copy the ${c.dim('whsec_...')} signing secret.`,
      ].join('\n'),
      'Stripe setup',
    );

    const secretKey = await promptSecret('Stripe secret key (sk_...)', env.STRIPE_SECRET_KEY);
    if (secretKey === null) return null;
    vars.STRIPE_SECRET_KEY = secretKey;

    const webhookSecret = await promptSecret(
      'Stripe webhook secret (whsec_...)',
      env.STRIPE_WEBHOOK_SECRET,
    );
    if (webhookSecret === null) return null;
    vars.STRIPE_WEBHOOK_SECRET = webhookSecret;

    // Pull live prices so the user activates real products by name instead of
    // pasting opaque price IDs. On fetch failure (or zero prices) we warn and
    // skip catalog writing — there is no free-text fallback now that the app
    // renders whatever tiers we snapshot.
    let prices = null;
    const s = spinner();
    try {
      s.start('Fetching your Stripe products and prices');
      prices = await listStripePrices(secretKey);
      s.stop(`Found ${prices.length} active price${prices.length === 1 ? '' : 's'} in Stripe.`);
    } catch (err) {
      s.stop('Could not fetch Stripe prices.');
      p.log.warn(`${err.message}. No products activated, fix the key and re-run to set pricing.`);
      prices = null;
    }

    if (prices && prices.length > 0) {
      // Single multiselect: pick which products to activate. `prices` is already
      // amount-sorted, so options (and the resulting snapshot) read cheapest-first.
      const selected = await p.multiselect({
        message: 'Select the products to activate',
        options: prices.map((pr) => ({
          value: pr.priceId,
          label: `${pr.name} — ${formatAmount(pr.amount, pr.currency)}${pr.type === 'one_time' ? ' (one-time)' : `/${pr.interval}`}`,
        })),
        initialValues: prices.map((pr) => pr.priceId), // pre-check all; user deselects
        required: false,
      });
      if (p.isCancel(selected)) return null;

      // Filter preserves the amount-sorted order; these objects already match
      // the CatalogTier shape the snapshot expects.
      const activeTiers = prices.filter((pr) => selected.includes(pr.priceId));

      // Side effect (like promptCicd writing .vibecarbon.json): snapshot the
      // activated products into src/shared/billing-catalog.ts so the app renders
      // accurate pricing without hitting Stripe at runtime. Only write when at
      // least one product is activated; otherwise leave the shipped default.
      if (activeTiers.length > 0) {
        const written = writeBillingCatalog(process.cwd(), {
          provider: 'stripe',
          generatedAt: new Date().toISOString(),
          tiers: activeTiers,
        });
        if (written) {
          p.log.success(
            `Activated ${activeTiers.length} product${activeTiers.length === 1 ? '' : 's'} — wrote pricing snapshot to src/shared/billing-catalog.ts`,
          );
        }
      } else {
        p.log.warn('No products selected, left the existing pricing snapshot unchanged.');
      }
    } else if (prices) {
      // Fetch succeeded but the account has no active prices.
      p.log.warn('No active prices found in Stripe, create products first, then re-run.');
    }
  } else if (provider === 'paddle') {
    p.note(
      [
        `${c.bold('1. API key')} (Developer Tools → Authentication → API keys → New API key)`,
        `   ${c.info('https://vendors.paddle.com')}`,
        '   Generate a new key with read + write scope.',
        '',
        `${c.bold('2. Webhook')} (Developer Tools → Notifications → New destination)`,
        `   ${c.info('https://vendors.paddle.com')}`,
        `   • Endpoint URL: ${c.dim(`https://<your-domain>${BILLING_WEBHOOK_PATH}`)}`,
        '   • Events to send:',
        '       transaction.completed',
        '       transaction.payment_failed',
        '       subscription.created',
        '       subscription.updated',
        '       subscription.canceled',
        '       subscription.past_due',
        '   • Copy the secret key shown after creating the destination.',
        '',
        `${c.bold('3. Price IDs')} (Catalog → Products → pick product → Prices)`,
        `   ${c.info('https://vendors.paddle.com')}`,
        '   Create a Startup and Pro product, then copy each recurring',
        `   price's ${c.dim('pri_...')} ID.`,
      ].join('\n'),
      'Paddle setup',
    );

    const apiKey = await promptSecret('Paddle API key', env.PADDLE_API_KEY);
    if (apiKey === null) return null;
    vars.PADDLE_API_KEY = apiKey;

    const webhookSecret = await promptSecret('Paddle webhook secret', env.PADDLE_WEBHOOK_SECRET);
    if (webhookSecret === null) return null;
    vars.PADDLE_WEBHOOK_SECRET = webhookSecret;

    const environment = await p.select({
      message: 'Paddle environment',
      options: [
        { value: 'sandbox', label: 'Sandbox', hint: 'for testing' },
        { value: 'production', label: 'Production', hint: 'live payments' },
      ],
      initialValue: env.PADDLE_ENVIRONMENT || 'sandbox',
    });
    if (p.isCancel(environment)) return null;
    vars.PADDLE_ENVIRONMENT = environment;

    const priceStarter = await promptText(
      'Paddle price ID for Startup plan',
      env.PADDLE_PRICE_STARTER,
    );
    if (priceStarter === null) return null;
    vars.PADDLE_PRICE_STARTER = priceStarter;

    const pricePro = await promptText('Paddle price ID for Pro plan', env.PADDLE_PRICE_PRO);
    if (pricePro === null) return null;
    vars.PADDLE_PRICE_PRO = pricePro;
  } else if (provider === 'polar') {
    p.note(
      [
        `${c.bold('1. Access token')} (Settings → Developers → New access token)`,
        `   ${c.info('https://polar.sh/dashboard/<org>/settings')}`,
        '',
        `${c.bold('2. Webhook')} (Settings → Webhooks → Add Endpoint)`,
        `   ${c.info('https://polar.sh/dashboard/<org>/settings/webhooks')}`,
        `   • Endpoint URL: ${c.dim(`https://<your-domain>${BILLING_WEBHOOK_PATH}`)}`,
        '   • Events to send:',
        '       checkout.created',
        '       subscription.created',
        '       subscription.updated',
        '       subscription.canceled',
        '       subscription.revoked',
        '   • Copy the secret shown after creating the endpoint.',
        '',
        `${c.bold('3. Organization ID')}`,
        `   Shown in the dashboard URL after ${c.dim('/dashboard/')}.`,
        '',
        `${c.bold('4. Price IDs')}`,
        `   ${c.info('https://polar.sh/dashboard/<org>/products')}`,
      ].join('\n'),
      'Polar setup',
    );

    const accessToken = await promptSecret('Polar access token', env.POLAR_ACCESS_TOKEN);
    if (accessToken === null) return null;
    vars.POLAR_ACCESS_TOKEN = accessToken;

    const webhookSecret = await promptSecret('Polar webhook secret', env.POLAR_WEBHOOK_SECRET);
    if (webhookSecret === null) return null;
    vars.POLAR_WEBHOOK_SECRET = webhookSecret;

    const orgId = await promptText('Polar organization ID', env.POLAR_ORGANIZATION_ID);
    if (orgId === null) return null;
    vars.POLAR_ORGANIZATION_ID = orgId;

    const priceStarter = await promptText(
      'Polar price ID for Startup plan',
      env.POLAR_PRICE_STARTER,
    );
    if (priceStarter === null) return null;
    vars.POLAR_PRICE_STARTER = priceStarter;

    const pricePro = await promptText('Polar price ID for Pro plan', env.POLAR_PRICE_PRO);
    if (pricePro === null) return null;
    vars.POLAR_PRICE_PRO = pricePro;
  }

  return vars;
}

// ---- Google OAuth ----

// Supabase Auth handles the OAuth dance; providers redirect to its callback,
// not to your app. Show the user the exact URI to paste so they don't guess.
// Production serves ONE origin (Traefik path-routes /auth/v1 on the apex to
// Kong), so a configured https:// SITE_URL is the callback base; dev falls
// back to SUPABASE_URL (Kong's localhost port — the Vite proxy only covers
// /api, so dev callbacks hit Kong directly).
function supabaseCallbackUrl(env) {
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');
  const base = siteUrl.startsWith('https://')
    ? siteUrl
    : (env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) return c.dim('<SUPABASE_URL>/auth/v1/callback');
  return c.dim(`${base}/auth/v1/callback`);
}

async function promptGoogleOAuth(env) {
  p.log.info(c.bold('Google OAuth'));

  p.note(
    [
      `${c.bold('1. Configure consent screen')} (one-time prerequisite)`,
      `   ${c.info('https://console.cloud.google.com/auth/branding')}`,
      '   Google Auth Platform → Branding. Add app name + support email.',
      '',
      `${c.bold('2. Create OAuth client')} (Clients → Create client)`,
      `   ${c.info('https://console.cloud.google.com/auth/clients')}`,
      `   Application type: ${c.dim('Web application')}.`,
      '',
      `${c.bold('3. Authorized redirect URI')}`,
      `   ${supabaseCallbackUrl(env)}`,
      '   (paste this exact URL, Google must match it character-for-character)',
      '',
      `${c.bold('4. Copy the Client ID and Client secret')}`,
      `   ${c.dim('The secret is only visible at creation, copy it immediately.')}`,
    ].join('\n'),
    'Google OAuth setup',
  );

  const clientId = await promptText('Google Client ID', env.GOOGLE_CLIENT_ID);
  if (clientId === null) return null;

  const clientSecret = await promptSecret('Google Client Secret', env.GOOGLE_CLIENT_SECRET);
  if (clientSecret === null) return null;

  return {
    GOOGLE_ENABLED: 'true',
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
  };
}

// ---- Microsoft OAuth ----

async function promptMicrosoftOAuth(env) {
  p.log.info(c.bold('Microsoft OAuth'));

  p.note(
    [
      `${c.bold('1. Register an app')} (App registrations → New registration)`,
      `   ${c.info('https://entra.microsoft.com')}`,
      '   Microsoft Entra ID → App registrations → New registration.',
      '',
      `${c.bold('2. Redirect URI')} (platform: Web)`,
      `   ${supabaseCallbackUrl(env)}`,
      '',
      `${c.bold('3. Client secret')} (Certificates & secrets → New client secret)`,
      `   ${c.dim('Copy the Value (not the Secret ID), Entra only shows it once.')}`,
      '',
      `${c.bold('4. Tenant ID')}`,
      `   Use ${c.dim('common')} to allow any Microsoft account, or paste your`,
      "   directory's tenant UUID for single-tenant apps.",
    ].join('\n'),
    'Microsoft OAuth setup',
  );

  const clientId = await promptText('Microsoft Client ID', env.MICROSOFT_CLIENT_ID);
  if (clientId === null) return null;

  const clientSecret = await promptSecret('Microsoft Client Secret', env.MICROSOFT_CLIENT_SECRET);
  if (clientSecret === null) return null;

  const tenantId = await promptText('Microsoft Tenant ID', env.MICROSOFT_TENANT_ID, {
    placeholder: 'common',
    defaultValue: 'common',
  });
  if (tenantId === null) return null;

  return {
    MICROSOFT_ENABLED: 'true',
    MICROSOFT_CLIENT_ID: clientId,
    MICROSOFT_CLIENT_SECRET: clientSecret,
    MICROSOFT_TENANT_ID: tenantId,
  };
}

// ---- OAuth (provider picker) ----

// Single "OAuth" feature that asks which provider to set up, then delegates to
// the provider-specific flow. Each provider writes its own env vars, so they
// coexist — configuring one never clears the other.
async function promptOAuth(env, ctx, { provider: preselected } = {}) {
  const googleDone = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const microsoftDone = Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);

  // `configure oauth <provider>` preselects and skips the which-provider prompt.
  let provider = preselected;
  if (!provider) {
    provider = await p.select({
      message: 'Which OAuth provider?',
      options: [
        { value: 'google', label: googleDone ? `Google ${c.success('✓ configured')}` : 'Google' },
        {
          value: 'microsoft',
          label: microsoftDone ? `Microsoft ${c.success('✓ configured')}` : 'Microsoft',
        },
      ],
    });
    if (p.isCancel(provider)) return null;
  }

  return provider === 'google' ? promptGoogleOAuth(env, ctx) : promptMicrosoftOAuth(env, ctx);
}

// ---- SMTP / Email ----

async function promptSmtp(env, ctx = {}, { provider: preselected } = {}) {
  p.log.info(c.bold('SMTP / Email'));
  p.log.info(c.dim('Used for password resets, verification, and transactional emails.'));

  const currentIsResend = !env.SMTP_HOST || env.SMTP_HOST === 'smtp.resend.com';
  // `configure email <provider>` preselects and skips the which-provider prompt.
  let provider = preselected;
  if (!provider) {
    provider = await p.select({
      message: 'Email provider',
      options: [
        { value: 'resend', label: 'Resend', hint: 'recommended: simplest setup' },
        { value: 'postmark', label: 'Postmark', hint: 'high deliverability' },
        { value: 'sendgrid', label: 'SendGrid', hint: 'Twilio SendGrid' },
        { value: 'smtp', label: 'Other SMTP server', hint: 'Mailgun, SES, any SMTP' },
      ],
      initialValue: currentIsResend ? 'resend' : 'smtp',
    });
    if (p.isCancel(provider)) return null;
  }

  let host;
  let port;
  let user;
  let pass;

  if (provider === 'resend') {
    p.note(
      [
        `${c.bold('1. Add your sending domain')}  ${c.info('https://resend.com/domains')}`,
        `   Use your ${c.bold('root domain')} ${c.dim('(e.g. yourdomain.com)')} — not a subdomain`,
        `   ${c.dim('like mail.yourdomain.com')}. Add the DNS records it shows you,`,
        `   then wait for the status to read ${c.dim('"Verified"')}.`,
        '',
        `${c.bold('2. Create an API key')}  ${c.info('https://resend.com/api-keys')}`,
        `   ${c.dim('"Sending access"')} permission is all you need ${c.dim('(not "Full access")')}.`,
        '',
        '3. Paste the API key below.',
      ].join('\n'),
      'Resend setup',
    );

    host = 'smtp.resend.com';
    port = '587';
    user = 'resend';

    pass = await promptSecret('Resend API key', env.SMTP_PASS);
    if (pass === null) return null;
  } else if (provider === 'postmark') {
    // Postmark SMTP: the Server API Token is used as BOTH the username and the
    // password (https://postmarkapp.com/developer/user-guide/send-email-with-smtp).
    p.note(
      [
        `${c.bold('1. Verify your sender')}  ${c.info('https://account.postmarkapp.com/signatures')}`,
        `   Add a ${c.dim('Sender Signature')} for your "from" address, or verify your`,
        `   whole domain ${c.dim('(DKIM + Return-Path)')} so production email is accepted.`,
        '',
        `${c.bold('2. Server API Token')}  ${c.info('https://account.postmarkapp.com/servers')}`,
        `   Open your server → ${c.dim('API Tokens')} and copy the ${c.dim('Server API Token')}.`,
        `   ${c.dim('Postmark uses this same token as both the SMTP username and password.')}`,
      ].join('\n'),
      'Postmark setup',
    );

    host = 'smtp.postmarkapp.com';
    port = '587';

    const token = await promptSecret('Postmark Server API token', env.SMTP_PASS);
    if (token === null) return null;
    // Both credentials are the Server API Token (per Postmark's SMTP docs).
    user = token;
    pass = token;
  } else if (provider === 'sendgrid') {
    // SendGrid SMTP: username is the literal string "apikey"; password is the
    // API key (https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api).
    p.note(
      [
        `${c.bold('1. Verify a sender')}  ${c.info('https://app.sendgrid.com/settings/sender_auth')}`,
        `   Complete ${c.dim('Single Sender Verification')} for your "from" address, or set`,
        '   up domain authentication so production email is not rejected.',
        '',
        `${c.bold('2. API key')}  ${c.info('https://app.sendgrid.com/settings/api_keys')}`,
        `   Create a key with at least ${c.dim('"Mail Send"')} permission and copy it`,
        `   ${c.dim('(shown only once)')}. The SMTP username is the literal word ${c.dim('apikey')}.`,
      ].join('\n'),
      'SendGrid setup',
    );

    host = 'smtp.sendgrid.net';
    port = '587';
    // SendGrid requires the literal string "apikey" as the SMTP username.
    user = 'apikey';

    pass = await promptSecret('SendGrid API key', env.SMTP_PASS);
    if (pass === null) return null;
  } else {
    p.note(
      [
        'Works with any SMTP provider (Mailgun, AWS SES, …).',
        "Grab the host, port, username, and password from your provider's",
        'SMTP settings. Verify your sender domain there first, or production',
        'email will land in spam.',
      ].join('\n'),
      'SMTP setup',
    );

    host = await promptText('SMTP host', env.SMTP_HOST, {
      validate: requireNonEmpty('SMTP host'),
    });
    if (host === null) return null;

    port = await promptText('SMTP port', env.SMTP_PORT, {
      defaultValue: '587',
    });
    if (port === null) return null;

    user = await promptText('SMTP username', env.SMTP_USER, {
      validate: requireNonEmpty('SMTP username'),
    });
    if (user === null) return null;

    pass = await promptSecret('SMTP password', env.SMTP_PASS);
    if (pass === null) return null;
  }

  // Suggest a sender address on the project's own domain when we know it, so
  // Enter accepts e.g. support@vibecarbon.com instead of a generic placeholder.
  const domain = ctx.domain || 'yourdomain.com';
  const emailSuggestion = ctx.domain ? `support@${ctx.domain}` : undefined;

  p.note(
    [
      'Use a real inbox you monitor as the "from" address',
      `${c.dim(`(e.g. hi@${domain} or support@${domain})`)} so replies, `,
      'including to password-reset and verification emails, reach you.',
      `${c.bold('Avoid noreply@')}.`,
    ].join('\n'),
    'Sender identity',
  );

  const adminEmail = await promptText('Sender email address (from)', env.SMTP_ADMIN_EMAIL, {
    defaultValue: emailSuggestion,
    placeholder: `support@${domain}`,
    validate: validateAdminEmail,
  });
  if (adminEmail === null) return null;

  const senderDefault = env.PROJECT_NAME || ctx.projectConfig?.projectName || 'My App';
  const senderName = await promptText('Sender display name', env.SMTP_SENDER_NAME, {
    placeholder: senderDefault,
    defaultValue: senderDefault,
  });
  if (senderName === null) return null;

  // Signup confirmation emails. Deploys default to auto-confirm (skipping
  // the email) because without working SMTP every signup 500s on the
  // unsendable message — but the operator just configured SMTP, so real
  // verification turns on automatically (decision 2026-07-24: working SMTP
  // with silently-skipped verification was the audit's residual risk).
  // GoTrue's env semantics are inverted (AUTOCONFIRM=true means SKIP the
  // email) and the env var carries GoTrue's value directly (compose
  // interpolation cannot negate), so "verification on" writes 'false'.
  p.log.info(
    `New signups will now require email confirmation ${c.dim('(GOTRUE_MAILER_AUTOCONFIRM="false" — flip it back to "true" in your env to skip verification)')}`,
  );

  return {
    SMTP_HOST: host,
    SMTP_PORT: port,
    SMTP_USER: user,
    SMTP_PASS: pass,
    SMTP_ADMIN_EMAIL: adminEmail,
    SMTP_SENDER_NAME: senderName,
    GOTRUE_MAILER_AUTOCONFIRM: 'false',
  };
}

// ---- Plausible Analytics ----

async function promptPlausible(env, ctx = {}) {
  p.log.info(c.bold('Plausible Analytics'));

  const domainLines = ctx.domain
    ? [
        `   Register ${c.bold(ctx.domain)} ${c.dim('(without https://)')} — we've`,
        `   pre-filled it at the ${c.dim('"Your site domain"')} prompt below.`,
      ]
    : [
        `   Enter your domain ${c.dim('(without https://)')}. Use that same`,
        `   domain at the ${c.dim('"Your site domain"')} prompt below.`,
      ];

  p.note(
    [
      `${c.bold('1. Add your site')}`,
      `   ${c.info('https://plausible.io/sites/new')}`,
      ...domainLines,
      '',
      `   Plausible then shows an ${c.dim('"Install Plausible"')} screen with a`,
      `   snippet ${c.dim('(e.g. pa-xxxx.js)')}. Ignore it — vibecarbon injects`,
      '   the snippet for you. Just come back here.',
      '',
      `${c.bold('2. Script URL')}`,
      `   Keep the default ${c.dim('(https://plausible.io/js/script.js)')} unless you`,
      '   self-host, e.g.',
      `   ${c.dim('https://analytics.yourdomain.com/js/script.js')}.`,
    ].join('\n'),
    'Plausible setup',
  );

  const domain = await promptText(
    'Your site domain (e.g., myapp.com)',
    env.VITE_PLAUSIBLE_DOMAIN || ctx.domain,
  );
  if (domain === null) return null;

  const scriptUrl = await promptText(
    'Plausible script URL',
    env.VITE_PLAUSIBLE_SCRIPT_URL || 'https://plausible.io/js/script.js',
  );
  if (scriptUrl === null) return null;

  p.log.info(
    `Analytics loads on your next ${c.info('vibecarbon deploy')}. Then click ${c.dim('"Verify installation"')} in Plausible.`,
  );

  return {
    VITE_PLAUSIBLE_DOMAIN: domain,
    VITE_PLAUSIBLE_SCRIPT_URL: scriptUrl,
  };
}

// (i18n moved to admin Settings → Localization card — language list lives in
// app_settings.enabled_languages, not .env.local. See migration
// 00005_localization_languages.sql.)

/**
 * CI/CD setup — bootstraps the project's GitHub repo (if missing), installs
 * the canonical GHA workflows, rewrites image references with the real owner,
 * and records the opt-in flag. Absorbs everything the legacy `vibecarbon add
 * cicd` did; that command is gone (CI/CD is an external service, so it lives
 * here in `configure`, not in `add` which is for local containers).
 *
 * Flow:
 *   1. Verify `gh` CLI is installed + authenticated
 *   2. Resolve owner: existing remote → use it; otherwise prompt + create repo
 *      via `gh repo create` (with `git init` + initial commit if needed)
 *   3. Rewrite ghcr.io / github.com image refs in compose + k8s manifests
 *   4. Install `.github/workflows/vibecarbon-build.yml` + `deploy.yml`
 *   5. Set `cicdEnabled: true` in `.vibecarbon.json`
 *
 * After this, `vibecarbon deploy` for compose prompts Direct/Push per-deploy
 * (push becomes the default once CI/CD is configured). K8s and K8s-HA deploys
 * are local-first via deployK3s and ignore CI/CD entirely — this feature is
 * purely additive: it adds the git-push deploy path for compose, and lays
 * down GHA workflow files in the repo for teams that want them.
 *
 * Org-level secret seeding (Hetzner/Cloudflare/S3 tokens) is NOT done here —
 * the first push-mode compose deploy (or first `-mode k8s` deploy) still runs
 * `seedOrgSecrets` via `deployK8sGitOps`. Kept that way so secrets only land
 * in GitHub when the user actually deploys, not when they merely configure.
 */
async function promptCicd() {
  p.log.info(c.bold('CI/CD (GitHub Actions)'));
  p.log.info(
    c.dim(
      'Bootstraps the GitHub repo (if needed) and installs build + deploy workflows so this project can ship via git push. Optional in all modes, k8s/k8s-ha deploys are local-first and never need CI/CD; compose deploys use git-push when configured, otherwise a local build sideloaded to the server.',
    ),
  );

  const {
    detectGitHubUsername,
    getGitHubRepo,
    installDeployWorkflowFile,
    installWorkflowFile,
    updateImageReferences,
  } = await import('./lib/ci-setup.js');
  const { checkDependency, runCommand } = await import('./lib/command.js');

  if (!checkDependency('gh', 'GitHub CLI')) {
    p.log.error(
      '`gh` CLI is required. Install from https://cli.github.com/, then run `gh auth login`.',
    );
    return null;
  }
  try {
    runCommand(['gh', 'auth', 'status'], { silent: true });
  } catch {
    p.log.error(
      '`gh` is not authenticated. Run `gh auth login` and re-run `vibecarbon configure`.',
    );
    return null;
  }

  const cwd = process.cwd();
  const projectConfig = loadProjectConfig(cwd);
  const projectName = projectConfig?.projectName;
  if (!projectName) {
    p.log.error('.vibecarbon.json missing or has no projectName. Run `vibecarbon create` first.');
    return null;
  }

  // Resolve owner: prefer an existing origin remote; otherwise bootstrap one.
  let { owner: githubOwner, name: repoName } = getGitHubRepo(cwd);
  const s = spinner();

  if (githubOwner && repoName) {
    p.log.info(`GitHub repo detected: ${c.bold(`${githubOwner}/${repoName}`)}`);
  } else {
    p.log.info('No GitHub origin remote, creating one now.');
    const detected = detectGitHubUsername();
    const ownerInput = await p.text({
      message: 'GitHub username or organization:',
      placeholder: detected || 'your-username',
      initialValue: detected || '',
      validate: (value) => {
        if (!value) return 'GitHub username is required';
        if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(value))
          return 'Invalid GitHub username format';
      },
    });
    if (p.isCancel(ownerInput)) return null;
    githubOwner = ownerInput;

    const visibility = await p.select({
      message: 'Repository visibility',
      options: [
        { value: 'private', label: 'Private', hint: 'recommended' },
        { value: 'public', label: 'Public' },
      ],
      initialValue: 'private',
    });
    if (p.isCancel(visibility)) return null;

    if (!existsSync(join(cwd, '.git'))) {
      s.start('Initializing git repository');
      runCommand(['git', 'init'], { silent: true, cwd, cleanEnv: true });
      s.stop('Git repository initialized');
    }
    const hasCommits = runCommand(['git', 'rev-parse', 'HEAD'], {
      silent: true,
      ignoreError: true,
      cwd,
      cleanEnv: true,
    });
    if (!hasCommits) {
      s.start('Creating initial commit');
      runCommand(buildGitAddArgv(), { silent: true, ignoreError: true, cwd });
      runCommand(['git', 'commit', '-m', 'Initial commit - Vibecarbon project'], {
        silent: true,
        cwd,
        cleanEnv: true,
      });
      s.stop('Initial commit created');
    }

    s.start(`Creating GitHub repository: ${githubOwner}/${projectName}`);
    try {
      // projectName is basename-validated at create time; visibility is a literal.
      runCommand(
        ['gh', 'repo', 'create', projectName, `--${visibility}`, '--source=.', '--remote=origin'],
        { silent: true, timeout: 60000, cwd },
      );
      s.stop('GitHub repository created');
    } catch (err) {
      s.stop(`Failed to create GitHub repository: ${err.message}`);
      return null;
    }
    repoName = projectName;
  }

  // Rewrite ghcr.io / github.com refs in compose + k8s manifests so they
  // point at the real owner. Idempotent — re-running with the same owner
  // is a no-op.
  s.start('Updating Docker / Flux image references');
  updateImageReferences(projectName, githubOwner, cwd);
  s.stop('Image references updated');

  try {
    s.start('Installing .github/workflows/vibecarbon-build.yml');
    const installedBuild = installWorkflowFile(cwd);
    s.stop(installedBuild ? 'Build workflow installed' : 'Build workflow already present');

    s.start('Installing .github/workflows/deploy.yml');
    const installedDeploy = installDeployWorkflowFile(cwd);
    s.stop(installedDeploy ? 'Deploy workflow installed' : 'Deploy workflow already present');
  } catch (err) {
    s.stop(`Failed to install workflow files: ${err.message}`);
    return null;
  }

  // Record opt-in on the project so `ciAvailable()` detects CI/CD without
  // shelling out to `gh` on every deploy.
  const { saveProjectConfig: savePc } = await import('./lib/config.js');
  if (projectConfig) {
    savePc({ ...projectConfig, cicdEnabled: true }, cwd);
    p.log.success('Marked CI/CD as enabled in .vibecarbon.json');
  } else {
    p.log.warn(
      '.vibecarbon.json not found; workflows installed but the CI/CD flag could not be persisted. Re-run `vibecarbon configure cicd` after fixing the project config.',
    );
  }

  p.log.info(
    c.dim(
      'Next: `git add .github/workflows .nvmrc && git commit && git push` to register the workflows with GitHub.',
    ),
  );

  // No env vars to merge — side-effects only.
  return {};
}

// ---- Globalization ----

/** One line per installed translation: how much of it is still English. */
function reportTranslationStatus(cwd) {
  const rows = globalizationStatus(cwd);
  if (!rows.length) {
    p.log.info(c.dim('English only. No translations to report.'));
    return;
  }
  for (const { code, total, untranslated } of rows) {
    const label = SUPPORTED_LOCALES[code] || code;
    const done = total - untranslated;
    p.log.info(
      untranslated === 0
        ? `${c.bold(label)} ${c.success('fully translated')} ${c.dim(`(${total} keys)`)}`
        : `${c.bold(label)} ${done}/${total} translated, ${c.warning(`${untranslated} still English`)}`,
    );
  }
  p.log.info(
    c.dim(
      'Counted by comparing each value to English, so strings that are the same in both (Email, OK) read as untranslated.',
    ),
  );
}

async function promptGlobalization() {
  p.log.info(c.bold('Globalization'));
  p.log.info(
    c.dim(
      'The locale files in src/client/locales define the languages this app ships. The language switcher offers exactly those, and hides itself when there is only one.',
    ),
  );

  const cwd = process.cwd();
  const before = installedLocales(cwd);

  const selected = await p.multiselect({
    message: 'Languages this app ships',
    options: Object.entries(SUPPORTED_LOCALES).map(([code, label]) => ({
      value: code,
      label: code === BASE_LOCALE ? `${label} ${c.dim('(required)')}` : label,
    })),
    initialValues: before.filter((code) => code in SUPPORTED_LOCALES),
    required: false,
  });
  if (p.isCancel(selected)) return null;

  // English is the fallback language; a project without it renders key paths.
  const next = selected.includes(BASE_LOCALE) ? selected : [BASE_LOCALE, ...selected];
  if (!selected.includes(BASE_LOCALE)) {
    p.log.warn(`${SUPPORTED_LOCALES[BASE_LOCALE]} is the fallback language and is always kept.`);
  }

  const toAdd = next.filter((code) => !before.includes(code));
  const toRemove = before.filter((code) => !next.includes(code) && code !== BASE_LOCALE);

  if (!toAdd.length && !toRemove.length) {
    p.log.info('No change.');
    reportTranslationStatus(cwd);
    return {};
  }

  // Deleting a locale file discards translation work. Git makes it
  // recoverable, so say where it went rather than refusing outright.
  if (toRemove.length) {
    const labels = toRemove.map((code) => SUPPORTED_LOCALES[code] || code).join(', ');
    const ok = await p.confirm({
      message: `Remove ${labels}? Their translations are deleted (recoverable with git checkout).`,
      initialValue: false,
    });
    if (p.isCancel(ok)) return null;
    if (!ok) return null;
  }

  for (const code of toRemove) {
    removeLocale(cwd, code);
    p.log.success(`Removed ${SUPPORTED_LOCALES[code] || code}`);
  }

  for (const code of toAdd) {
    const { seeded } = addLocale(cwd, code);
    p.log.success(
      `Added ${SUPPORTED_LOCALES[code] || code}: ${seeded} keys seeded from English, awaiting translation`,
    );
  }

  reportTranslationStatus(cwd);
  p.log.info(
    c.dim('Translate by editing the locale files; the app picks them up on the next build.'),
  );

  // No env vars — the files on disk are the configuration.
  return {};
}

// ============================================================================
// FEATURE DEFINITIONS
// ============================================================================

// Env vars that hold secrets — partially masked when echoing existing config.
// Derived from the config-registry so a new feature secret (or provider
// credential) is masked automatically (no second list to keep in sync).
const SECRET_ENV_KEYS = new Set([...featureSecretKeys(), ...operatorSecretKeys()]);

// Predicate for the shared env-summary module.
const isSecretKey = (key) => SECRET_ENV_KEYS.has(key);

// Billing is provider-tagged; infer the active provider from BILLING_PROVIDER
// or, for hand-edited envs, from whichever provider secret is present.
const BILLING_KEYS = {
  stripe: ['BILLING_PROVIDER', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  paddle: [
    'BILLING_PROVIDER',
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_ENVIRONMENT',
    'PADDLE_PRICE_STARTER',
    'PADDLE_PRICE_PRO',
  ],
  polar: [
    'BILLING_PROVIDER',
    'POLAR_ACCESS_TOKEN',
    'POLAR_WEBHOOK_SECRET',
    'POLAR_ORGANIZATION_ID',
    'POLAR_PRICE_STARTER',
    'POLAR_PRICE_PRO',
  ],
};

function billingProvider(env) {
  if (env.BILLING_PROVIDER) return env.BILLING_PROVIDER;
  if (env.STRIPE_SECRET_KEY) return 'stripe';
  if (env.PADDLE_API_KEY) return 'paddle';
  if (env.POLAR_ACCESS_TOKEN) return 'polar';
  return null;
}

export const FEATURES = [
  {
    value: 'providers',
    label: 'Providers',
    hint: 'Cloud + DNS API credentials',
    promptFn: promptProviders,
    // ✓-state lives per-provider in the promptProviders sub-list — keeping
    // this gate single-purpose (`false` = never double-confirm before the
    // sub-flow's own per-provider overwrite confirm) beats an any-configured
    // aggregate that would just re-ask the same question twice.
    isConfigured: () => false,
    summary: (env) => envSummaryLines(env, operatorSecretKeys(), isSecretKey),
  },
  {
    value: 'cicd',
    label: 'CI/CD',
    hint: 'Auto build & deploy with GitHub Actions',
    promptFn: promptCicd,
    isConfigured: (_env, ctx) => ctx?.projectConfig?.cicdEnabled === true,
    summary: () => [
      `${c.dim('cicdEnabled')} = true ${c.dim('(GitHub Actions workflows installed)')}`,
    ],
  },
  {
    value: 'billing',
    label: 'Payments',
    hint: 'Stripe',
    promptFn: promptBilling,
    isConfigured: (env) => Boolean(billingProvider(env)),
    summary: (env) =>
      envSummaryLines(env, BILLING_KEYS[billingProvider(env)] || ['BILLING_PROVIDER'], isSecretKey),
  },
  {
    value: 'oauth',
    label: 'OAuth',
    hint: 'Google or Microsoft',
    promptFn: promptOAuth,
    isConfigured: (env) =>
      Boolean(
        (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ||
          (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
      ),
    summary: (env) => envSummaryLines(env, featureKeys('oauth'), isSecretKey),
  },
  {
    value: 'smtp',
    label: 'SMTP / Email',
    hint: 'Password resets, account verifications, notifications, etc',
    promptFn: promptSmtp,
    isConfigured: (env) => Boolean(env.SMTP_HOST && env.SMTP_PASS),
    summary: (env) => envSummaryLines(env, featureKeys('smtp'), isSecretKey),
  },
  {
    value: 'globalization',
    label: 'Globalization',
    hint: 'Which languages the app ships',
    promptFn: promptGlobalization,
    isConfigured: () => installedLocales(process.cwd()).length > 1,
    summary: () => {
      const codes = installedLocales(process.cwd());
      return [
        `${c.dim('languages')} = ${codes.map((code) => SUPPORTED_LOCALES[code] || code).join(', ') || 'none'}`,
      ];
    },
  },
  {
    value: 'plausible',
    label: 'Analytics',
    hint: 'Plausible',
    promptFn: promptPlausible,
    isConfigured: (env) => Boolean(env.VITE_PLAUSIBLE_DOMAIN),
    summary: (env) => envSummaryLines(env, featureKeys('analytics'), isSecretKey),
  },
];

// ============================================================================
// MAIN
// ============================================================================

// ----------------------------------------------------------------------------
// Direct-feature subcommand routing (`vibecarbon configure <feature> [provider]`)
// ----------------------------------------------------------------------------

// Maps the subcommand token a user types to a FEATURES `value`. Accepts both
// friendly aliases (what the admin UI shows) and the raw feature values. `cicd`
// is intentionally absent — it routes to runConfigureCicd (needs an <env> arg
// and a different flow), handled first in run().
const FEATURE_ALIASES = {
  email: 'smtp',
  smtp: 'smtp',
  oauth: 'oauth',
  analytics: 'plausible',
  plausible: 'plausible',
  payments: 'billing',
  billing: 'billing',
  providers: 'providers',
  globalization: 'globalization',
  languages: 'globalization',
};

// Valid `[provider]` positional per feature. An empty list means the feature
// has no provider choice, so any provider arg is silently ignored (not an
// error) — mirrors the admin UI which shows those commands without a provider.
const FEATURE_PROVIDERS = {
  smtp: ['resend', 'postmark', 'sendgrid', 'smtp'],
  billing: ['stripe'],
  oauth: ['google', 'microsoft'],
  plausible: [],
  providers: [],
};

/**
 * Validate an optional `[provider]` positional against a feature's allowed set.
 * Returns the provider to preselect (or undefined when none given / ignored).
 * Exits 1 with a clear message when a provider is given but not recognized.
 */
function resolveProvider(featureValue, providerArg) {
  if (!providerArg) return undefined;
  const valid = FEATURE_PROVIDERS[featureValue] ?? [];
  // Feature has no provider choice (e.g. Analytics) — silently ignore the arg.
  if (valid.length === 0) return undefined;
  if (!valid.includes(providerArg)) {
    p.log.error(
      `Unknown provider "${providerArg}" for "${featureValue}". Valid providers: ${valid.join(', ')}.`,
    );
    process.exit(1);
  }
  return providerArg;
}

/**
 * Load current env values + project ctx (name, deploy domain) for a feature
 * run. Shared by the interactive menu and the direct-subcommand path so both
 * see identical prompt context. Best-effort: a missing/broken project config
 * just falls back to generic placeholders.
 */
function loadFeatureContext(cwd) {
  const env = loadEnvVariables(cwd);
  let projectConfig = null;
  try {
    projectConfig = loadProjectConfig(cwd);
  } catch {
    // Best-effort — prompts fall back to generic placeholders without it.
  }
  return { env, ctx: { projectConfig, domain: projectDomain(projectConfig) } };
}

/**
 * Run a single feature: overwrite-confirm gate → prompt → write env vars →
 * outro. Shared by the interactive menu (main) and the direct-feature
 * subcommand path (runFeatureCommand) so behavior is identical regardless of
 * entry point. `provider` (when set) is forwarded to the feature's promptFn to
 * preselect its provider and skip that prompt.
 */
async function runFeature(feature, env, ctx, { provider } = {}) {
  const cwd = process.cwd();

  // Already configured? Show what's set (secrets masked) and require an explicit
  // overwrite confirmation before re-running the feature's prompts.
  if (feature.isConfigured(env, ctx)) {
    const lines = feature.summary(env, ctx);
    p.note(
      lines.length ? lines.join('\n') : c.dim('(configured)'),
      `${feature.label}: current settings`,
    );

    const overwrite = await p.confirm({
      message: `${feature.label} is already configured. Re-configure and overwrite these settings?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite)) {
      exitCancelled();
    }
    if (!overwrite) {
      p.outro(`Left ${c.bold(feature.label)} unchanged.`);
      return;
    }
  }

  const result = await feature.promptFn(env, ctx, { provider });

  if (result === null) {
    p.outro(`Skipped ${feature.label} (cancelled).`);
    return;
  }

  // Write values
  const s = spinner();
  s.start('Writing configuration');

  const writtenKeys = Object.keys(result);
  for (const key of writtenKeys) {
    setEnvVar(key, result[key], cwd, { localOnly: isOperatorKey(key) });
  }

  if (writtenKeys.length === 0) {
    s.stop('No changes written, configuration unchanged.');
    p.outro(
      `Run ${c.info('vibecarbon configure')} again for another feature, or ${c.info('vibecarbon deploy')} to push to production.`,
    );
  } else {
    // Operator/provider credentials (Providers feature) go to .env.local only
    // — .env is the server-bundle baseline, so claiming it was written there
    // too would be both wrong and a false assurance about where the token
    // lives. Every other feature still writes both files, unchanged.
    const localOnlyWrite = writtenKeys.every(isOperatorKey);
    s.stop(
      localOnlyWrite
        ? 'Configuration saved to .env.local (kept out of .env, never shipped to servers)'
        : 'Configuration saved to .env.local and .env',
    );

    p.outro(
      `Configured ${c.bold(feature.label)}. Run ${c.info('vibecarbon configure')} again for another feature, or ${c.info('vibecarbon deploy')} to push to production.`,
    );
  }
}

/**
 * Direct-feature entry: `vibecarbon configure <feature> [provider]`. The alias
 * has already been resolved to a FEATURES value by run(); here we validate the
 * optional provider, then run that single feature — skipping the interactive
 * menu but reusing the exact overwrite-confirm + write path via runFeature.
 */
async function runFeatureCommand(featureValue, providerArg) {
  // Validate the provider up front (before any project I/O or banner) so a
  // typo'd provider fails fast with a clear message.
  const provider = resolveProvider(featureValue, providerArg);

  const cwd = process.cwd();
  assertInProjectDir(cwd);

  introCommand('configure');

  const { env, ctx } = loadFeatureContext(cwd);
  const feature = FEATURES.find((f) => f.value === featureValue);
  await runFeature(feature, env, ctx, { provider });
}

async function main(cliArgs) {
  const { handled } = parseFlagsOrExit(cliArgs, SPEC);
  if (handled) return;

  // Detect vibecarbon project
  const cwd = process.cwd();
  assertInProjectDir(cwd);

  introCommand('configure');

  const { env, ctx } = loadFeatureContext(cwd);

  // Configure one feature per run. Multi-select made failures ambiguous — if a
  // later feature errored, it was unclear which earlier ones had been written.
  // Re-running the command is simple and keeps each session's outcome clear.
  const featureValue = await p.select({
    message: 'Which feature would you like to configure?',
    options: FEATURES.map((f) => ({
      value: f.value,
      label: f.isConfigured(env, ctx) ? `${f.label} ${c.success('✓ configured')}` : f.label,
      hint: f.hint,
    })),
  });

  if (p.isCancel(featureValue)) {
    exitCancelled();
  }

  const feature = FEATURES.find((f) => f.value === featureValue);
  await runFeature(feature, env, ctx);
}

// ============================================================================
// `vibecarbon configure cicd <env>` subcommand
// ============================================================================

/**
 * Set up CI/CD, in one or two stages depending on what the project runs.
 *
 * There is ONE CI/CD feature here, not two. Stage 1 installs the GitHub
 * Actions build + deploy workflows and is identical to the interactive
 * wizard's CI/CD entry (it calls the same function). Stage 2 layers Flux onto
 * a live Kubernetes cluster so future commits reconcile from inside it.
 *
 * The two stages differ in WHERE the deploy happens, which is why Stage 2 is
 * Kubernetes-only. Compose CD is push-based: Actions builds the image and
 * deploys to the server. Flux is pull-based: Actions only builds and pushes,
 * and a controller running in the cluster reconciles. Flux is a Kubernetes
 * controller with no Compose equivalent, so there is nothing to install for a
 * Compose project — not a restriction, just an absent concept.
 *
 * Usage:
 *   vibecarbon configure cicd          Stage 1 only. Every mode.
 *   vibecarbon configure cicd <env>    Stage 1, then Stage 2 if <env> is k8s.
 *
 * NOT license-gated. Stage 1 is free in every mode, and Stage 2 is reachable
 * only on k8s / k8s-ha environments, which already required Fullerene at
 * `deploy` time. A check here would gate a command rather than a scenario,
 * and would fire before the mode is known — which is exactly how this used to
 * show Compose users a paywall for a free feature they were already entitled
 * to.
 *
 * Pre-conditions:
 *   - Project is initialized (`.vibecarbon.json` exists).
 *   - `gh` CLI is authenticated and the project has a GitHub origin.
 *   - For Stage 2 only: the env was deployed via `vibecarbon deploy -mode k8s`
 *     (the kubeconfig at `.vibecarbon/kubeconfig-<env>` must exist).
 */
export async function runConfigureCicd(envName) {
  // Project guard runs before banner so an accidental `vibecarbon
  // configure cicd` from a parent directory emits the canonical message.
  const cwd = process.cwd();
  const projectConfig = assertInProjectDir(cwd);

  introCommand('configure cicd');

  // No env named: Stage 1 only. This is the whole feature for a Compose
  // project, and a valid starting point for a k8s one.
  if (!envName) {
    const projectSide = await promptCicd();
    if (projectSide === null) {
      p.log.error(
        'Workflow installation aborted. Fix the gh-CLI / origin issues above and re-run.',
      );
      process.exit(1);
    }
    p.outro(
      c.success(
        'CI/CD workflows installed. Name an environment to also layer GitOps onto a k8s cluster.',
      ),
    );
    return;
  }

  const envConfig = projectConfig.environments?.[envName];
  if (!envConfig) {
    p.log.error(
      `Environment "${envName}" not found in .vibecarbon.json. Deploy it first with \`vibecarbon deploy ${envName}\`.`,
    );
    process.exit(1);
  }

  // Stage 1 runs before the mode is consulted, because it is worth doing in
  // every mode. Deciding on Flux first is what used to turn a Compose user's
  // reasonable command into a hard failure for a feature they already had.
  p.log.step('Stage 1: install GitHub Actions workflows + mark cicdEnabled');
  const projectSide = await promptCicd();
  if (projectSide === null) {
    p.log.error('Workflow installation aborted. Fix the gh-CLI / origin issues above and re-run.');
    process.exit(1);
  }

  // Stage 2 is Flux, a Kubernetes controller. A Compose project has nothing to
  // install: its CD is push-based through the Actions workflow Stage 1 just
  // wrote. That is a finished setup, so this exits 0.
  const isK8s =
    envConfig.deployMode === 'kubernetes' ||
    envConfig.deployMode === 'kubernetes-ha' ||
    envConfig.deployMode === 'k8s' ||
    envConfig.deployMode === 'k8s-ha';
  if (!isK8s) {
    p.log.info(
      `Environment "${envName}" is ${envConfig.deployMode || 'unknown'} mode, which deploys by push from GitHub Actions. There is no Flux step to add.`,
    );
    p.outro(c.success(`CI/CD is set up for ${envName}. Push to main to build and deploy.`));
    return;
  }

  const kubeconfigPath = join(cwd, '.vibecarbon', `kubeconfig-${envName}`);
  if (!existsSync(kubeconfigPath)) {
    p.log.error(
      `Kubeconfig not found at ${kubeconfigPath}. Deploy the cluster first: vibecarbon deploy ${envName} -mode k8s`,
    );
    process.exit(1);
  }

  // Stage 2: layer Flux + GH Environment + workflow trigger onto the live
  // cluster. This is the body that orchestrator.js used to run inline when
  // --gitops was passed (deleted in PR 5).
  p.log.step('Stage 2: install Flux + seed GitHub Environment + trigger first reconcile');
  const { deployK8sGitOps, resolveGitopsBackupBucket } = await import(
    './lib/deploy/k8s/gitops-deploy.js'
  );
  const { getImageTag } = await import('./lib/ci-setup.js');
  const providerCreds = {
    hetznerApiToken: process.env.HETZNER_API_TOKEN || '',
    // DNS token candidates keyed by env var, registry-derived — seedOrgSecrets
    // seeds the non-empty ones (native DNS rows share the compute token env).
    dnsTokens: Object.fromEntries(
      Object.values(DNS_PROVIDERS).map((row) => [row.tokenEnv, process.env[row.tokenEnv] || '']),
    ),
    s3AccessKey: process.env.HETZNER_ACCESS_KEY || '',
    s3SecretKey: process.env.HETZNER_SECRET_KEY || '',
  };
  const imageTag = getImageTag(cwd);

  // HA clusters split into <env>-primary and <env>-standby kubeconfigs;
  // each needs its own GitOps handover. The orchestrator used to iterate
  // over `[{suffix:'primary'}, {suffix:'standby'}]` in HA, single in non-HA.
  const isHA = envConfig.deployMode === 'kubernetes-ha' || envConfig.deployMode === 'k8s-ha';
  const targets = isHA
    ? [
        { suffix: 'primary', envName: `${envName}-primary` },
        { suffix: 'standby', envName: `${envName}-standby` },
      ]
    : [{ suffix: null, envName }];

  for (const target of targets) {
    const targetKubeconfig = join(cwd, '.vibecarbon', `kubeconfig-${target.envName}`);
    if (!existsSync(targetKubeconfig)) {
      p.log.warn(
        `Kubeconfig for ${target.envName} not found at ${targetKubeconfig}, skipping. Re-deploy that cluster with vibecarbon deploy first.`,
      );
      continue;
    }
    const subEnvConfig = projectConfig.environments?.[target.envName] ?? envConfig;
    p.log.info(`Configuring GitOps for ${c.bold(target.envName)}`);
    await deployK8sGitOps({
      projectDir: cwd,
      environment: target.envName,
      domain: subEnvConfig.domain || envConfig.domain,
      projectName: projectConfig.projectName,
      kubeconfigPath: targetKubeconfig,
      networkId: subEnvConfig.networkId || envConfig.networkId,
      dnsProvider: subEnvConfig.dnsProvider || envConfig.dnsProvider,
      providerCreds,
      imageTag,
      s3BackupBucket: resolveGitopsBackupBucket(subEnvConfig, envConfig, projectConfig),
    });
  }

  p.outro(c.success(`GitOps layered onto ${envName}. Future commits to main reconcile via Flux.`));
}

// ============================================================================
// RUN FUNCTION (called by CLI entry point)
// ============================================================================

export async function run(args) {
  // Subcommand routing: `vibecarbon configure cicd <env>` skips the
  // interactive feature menu and runs the GitOps add-on flow directly.
  if (args[0] === 'cicd') {
    return runConfigureCicd(args[1]);
  }

  // Direct-feature subcommands: `vibecarbon configure <feature> [provider]`
  // (e.g. `configure email resend`) resolve the alias to a FEATURES value and
  // run that single feature, skipping the interactive menu. These are the
  // commands the admin UI advertises.
  const featureValue = FEATURE_ALIASES[args[0]];
  if (featureValue) {
    return runFeatureCommand(featureValue, args[1]);
  }

  // No recognized subcommand (or just flags like -h / -v) → interactive wizard.
  await main(args);
}
