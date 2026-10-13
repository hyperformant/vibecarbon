/**
 * CLI-side remnants of the GoTrue config wiring (audit 2026-07-15).
 *
 * The template no longer runs an auth service: auth is in-process in the app,
 * which reads OAuth and SMTP keys straight from its own environment (see
 * auth-config-wiring.test.ts). The template-file cases that pinned GoTrue's
 * env mapping were removed with the service; what is left here pins CLI code
 * that still carries the GoTrue names and goes away with the CLI cleanup.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('k3s.js renders the Azure tenant URL placeholder', () => {
  it('substitutes {{AZURE_TENANT_URL}} from MICROSOFT_TENANT_ID with a "common" fallback', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/\.replace\(\s*\/\\\{\\\{AZURE_TENANT_URL\\\}\\\}\/g,/);
    expect(k3s).toMatch(/login\.microsoftonline\.com/);
    expect(k3s).toMatch(/MICROSOFT_TENANT_ID[^\n]*(\|\||\?\?)[^\n]*'common'/);
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
  it('installSupabase substitutes the placeholder, treating anything but "false" as "true"', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/\.replace\(\s*\/\\\{\\\{GOTRUE_MAILER_AUTOCONFIRM\\\}\\\}\/g,/);
    expect(k3s).toMatch(/GOTRUE_MAILER_AUTOCONFIRM === 'false' \? 'false' : 'true'/);
  });

  it('the config registry manages it under the smtp feature', () => {
    const registry = read('src/lib/config-registry.js');
    // \s* between fields (not a literal space): the operator config hygiene
    // pass added per-entry shape metadata (kind/shape/sample/where/scope),
    // which pushes every entry over biome's 100-char line width — the
    // formatter then breaks one property per line, same as every other
    // entry in the array.
    expect(registry).toMatch(
      /key: 'GOTRUE_MAILER_AUTOCONFIRM',\s*class: 'runtime-config',\s*feature: 'smtp',/,
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
    // generateEnvLocal writes the line through formatDotenvLine; `true` is
    // in the bare alphabet, so the generated file carries it unquoted.
    expect(create).toMatch(/formatDotenvLine\('GOTRUE_MAILER_AUTOCONFIRM', 'true'\)/);
    // The comment must tell someone hand-filling SMTP_* that they also need
    // to flip this flag — the wizard only does it for its own edits.
    expect(create).toMatch(/fill in SMTP_\* by hand[\s\S]{0,120}GOTRUE_MAILER_AUTOCONFIRM=false/);
  });
});
