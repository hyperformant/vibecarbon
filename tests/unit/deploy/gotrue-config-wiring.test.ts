/**
 * GoTrue config wiring — OAuth + SMTP must reach the auth server on EVERY
 * deploy mode (audit 2026-07-15, memory project_configure_gaps_audit).
 *
 * Self-hosted GoTrue reads provider/SMTP config exclusively from environment
 * variables at boot (Studio's Auth→Providers screen is a supabase.com hosted
 * feature). compose maps configure-managed keys (GOOGLE_*, MICROSOFT_*,
 * SMTP_*) to GOTRUE_* names in docker-compose.yml; k8s does it via
 * environment.auth entries in supabase.values.yaml using valueFrom OPTIONAL
 * secretKeyRefs into vibecarbon-secrets — absent key → env unset → GoTrue
 * default (disabled), mirroring compose's `:-false` fallbacks. Before this
 * wiring, OAuth sign-in and auth emails silently did not work on k8s tiers:
 * applyVibecarbonSecrets shipped the keys into the Secret but nothing mapped
 * them onto the auth pod.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

/** Regex for a values-file env entry sourced from vibecarbon-secrets. */
function secretRefEntry(gotrueName: string, secretKey: string): RegExp {
  return new RegExp(
    `- name: ${gotrueName}\\s+valueFrom:\\s+secretKeyRef:\\s+name: vibecarbon-secrets\\s+key: ${secretKey}\\s+optional: true`,
  );
}

describe('k8s GoTrue env wiring (supabase.values.yaml environment.auth)', () => {
  const values = read('carbon/k8s/values/supabase.values.yaml');

  it('maps Google OAuth keys via optional secretKeyRefs', () => {
    expect(values).toMatch(secretRefEntry('GOTRUE_EXTERNAL_GOOGLE_ENABLED', 'GOOGLE_ENABLED'));
    expect(values).toMatch(secretRefEntry('GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID'));
    expect(values).toMatch(secretRefEntry('GOTRUE_EXTERNAL_GOOGLE_SECRET', 'GOOGLE_CLIENT_SECRET'));
  });

  it('sets the Google redirect URI from the deploy-time domain', () => {
    expect(values).toMatch(
      /- name: GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI\s+value: https:\/\/\{\{DOMAIN\}\}\/auth\/v1\/callback/,
    );
  });

  it('maps Microsoft (Azure) OAuth keys via optional secretKeyRefs + tenant URL placeholder', () => {
    expect(values).toMatch(secretRefEntry('GOTRUE_EXTERNAL_AZURE_ENABLED', 'MICROSOFT_ENABLED'));
    expect(values).toMatch(
      secretRefEntry('GOTRUE_EXTERNAL_AZURE_CLIENT_ID', 'MICROSOFT_CLIENT_ID'),
    );
    expect(values).toMatch(
      secretRefEntry('GOTRUE_EXTERNAL_AZURE_SECRET', 'MICROSOFT_CLIENT_SECRET'),
    );
    expect(values).toMatch(/- name: GOTRUE_EXTERNAL_AZURE_URL\s+value: "\{\{AZURE_TENANT_URL\}\}"/);
  });

  it('maps SMTP keys via optional secretKeyRefs (no junk chart-default literals)', () => {
    for (const [gotrue, key] of [
      ['GOTRUE_SMTP_HOST', 'SMTP_HOST'],
      ['GOTRUE_SMTP_PORT', 'SMTP_PORT'],
      ['GOTRUE_SMTP_USER', 'SMTP_USER'],
      ['GOTRUE_SMTP_PASS', 'SMTP_PASS'],
      ['GOTRUE_SMTP_ADMIN_EMAIL', 'SMTP_ADMIN_EMAIL'],
      ['GOTRUE_SMTP_SENDER_NAME', 'SMTP_SENDER_NAME'],
    ] as const) {
      expect(values).toMatch(secretRefEntry(gotrue, key));
    }
    // The chart's placeholder junk (GOTRUE_SMTP_HOST: SMTP_HOST etc.) must be gone.
    expect(values).not.toMatch(/value: SMTP_ADMIN_MAIL/);
    expect(values).not.toMatch(/value: SMTP_HOST/);
  });
});

describe('k3s.js renders the Azure tenant URL placeholder', () => {
  it('substitutes {{AZURE_TENANT_URL}} from MICROSOFT_TENANT_ID with a "common" fallback', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/\.replace\(\s*\/\\\{\\\{AZURE_TENANT_URL\\\}\\\}\/g,/);
    expect(k3s).toMatch(/login\.microsoftonline\.com/);
    expect(k3s).toMatch(/MICROSOFT_TENANT_ID[^\n]*(\|\||\?\?)[^\n]*'common'/);
  });
});

describe('compose GoTrue wiring parity (regression guard for the already-working path)', () => {
  it('docker-compose.yml maps OAuth + SMTP keys to GOTRUE_* names', () => {
    const compose = read('carbon/docker-compose.yml');
    expect(compose).toMatch(/GOTRUE_EXTERNAL_GOOGLE_ENABLED:\s*\$\{GOOGLE_ENABLED:-false\}/);
    expect(compose).toMatch(/GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID:\s*\$\{GOOGLE_CLIENT_ID:-\}/);
    expect(compose).toMatch(/GOTRUE_EXTERNAL_AZURE_ENABLED:\s*\$\{MICROSOFT_ENABLED:-false\}/);
    expect(compose).toMatch(/GOTRUE_SMTP_HOST:\s*\$\{SMTP_HOST:-\}/);
  });
});

describe('e2e canary covers the GoTrue path', () => {
  it('config-canary exports an OAuth canary and asserts it inside the auth container', () => {
    const canary = read('tests/e2e/checks/config-canary.ts');
    expect(canary).toMatch(/export const OAUTH_CANARY_CLIENT_ID/);
    expect(canary).toMatch(/GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID/);
    expect(canary).toMatch(/supabase-supabase-auth/); // k8s exec target
    expect(canary).toMatch(/-auth printenv/); // compose exec target
  });

  it('the harness seeds GOOGLE_CLIENT_ID but never GOOGLE_ENABLED (a half-configured enabled provider could fail GoTrue boot)', () => {
    const lifecycle = read('tests/e2e/scenarios/_run-lifecycle.ts');
    expect(lifecycle).toMatch(/setEnvVar\('GOOGLE_CLIENT_ID', OAUTH_CANARY_CLIENT_ID/);
    expect(lifecycle).not.toMatch(/setEnvVar\('GOOGLE_ENABLED'/);
  });
});

describe('GOTRUE_MAILER_AUTOCONFIRM is operator-configurable with a safe default (task #11)', () => {
  it('compose interpolates it with a default of true (no-SMTP deploys must auto-confirm or signups 500)', () => {
    const compose = read('carbon/docker-compose.yml');
    expect(compose).toMatch(/GOTRUE_MAILER_AUTOCONFIRM:\s*\$\{GOTRUE_MAILER_AUTOCONFIRM:-true\}/);
  });

  it('k8s values render it via a deploy-time placeholder (not a hardcoded "true")', () => {
    const values = read('carbon/k8s/values/supabase.values.yaml');
    expect(values).toMatch(
      /- name: GOTRUE_MAILER_AUTOCONFIRM\s+value: "\{\{GOTRUE_MAILER_AUTOCONFIRM\}\}"/,
    );
  });

  it('installSupabase substitutes the placeholder, treating anything but "false" as "true"', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/\.replace\(\s*\/\\\{\\\{GOTRUE_MAILER_AUTOCONFIRM\\\}\\\}\/g,/);
    expect(k3s).toMatch(/GOTRUE_MAILER_AUTOCONFIRM === 'false' \? 'false' : 'true'/);
  });

  it('the config registry manages it under the smtp feature', () => {
    const registry = read('src/lib/config-registry.js');
    expect(registry).toMatch(
      /key: 'GOTRUE_MAILER_AUTOCONFIRM', class: 'runtime-config', feature: 'smtp'/,
    );
  });

  // Decision 2026-07-24: configuring SMTP flips verification ON automatically —
  // no opt-in prompt. Working SMTP with silently-skipped verification was the
  // audit's residual risk; an operator who truly wants autoconfirm with SMTP
  // can hand-edit the env (the .env template documents the knob).
  it('the configure SMTP wizard enables email confirmation automatically (no opt-in prompt)', () => {
    const configure = read('src/configure.js');
    expect(configure).not.toMatch(/Require email confirmation for new signups\?/);
    // GoTrue's semantics are inverted (AUTOCONFIRM=true means SKIP the email;
    // the env var carries GoTrue's value directly because compose
    // interpolation cannot negate) — so "SMTP configured" writes 'false'.
    expect(configure).toMatch(/GOTRUE_MAILER_AUTOCONFIRM:\s*'false'/);
  });

  it('.env.example documents the knob next to the SMTP block, addressing manual SMTP edits', () => {
    const create = read('src/create.js');
    expect(create).toMatch(/GOTRUE_MAILER_AUTOCONFIRM="true"/);
    // The comment must tell someone hand-filling SMTP_* that they also need
    // to flip this flag — the wizard only does it for its own edits.
    expect(create).toMatch(/fill in SMTP_\* by hand[\s\S]{0,120}GOTRUE_MAILER_AUTOCONFIRM="false"/);
  });
});
