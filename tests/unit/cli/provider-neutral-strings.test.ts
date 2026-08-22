/**
 * R9 pass (task A6) — user-visible provider strings derive from Provider
 * statics instead of hardcoded "Hetzner" literals, plus the two new
 * provider gates (console hetzner-only, diagnose hcloud section).
 *
 * Hetzner behavior stays byte-identical everywhere EXCEPT five sanctioned
 * deviations, each pinned below:
 *   1. scale.js pricing line: "Current Hetzner pricing" -> "Current Hetzner
 *      Cloud pricing" (Provider.NAME is 'Hetzner Cloud', not 'Hetzner').
 *   2. destroy.js SPEC teardown bullets: "Hetzner servers/volumes/
 *      firewalls/SSH keys" -> "Hetzner Cloud ..." (same NAME expansion).
 *   3. shell.js welcome-banner "Try:" hint: conditionally drops the
 *      "hcloud server list" segment for a non-Hetzner provider.
 *   4. console.js: new loud failure for a non-Hetzner provider (previously
 *      unconditional Hetzner-only behavior with no gate at all).
 *   5. destroy.js console-hint sites (deleteStateBucket, deleteAppBucketEffect,
 *      the firewall-leak hint, the k8s manual-cleanup hint) and the
 *      orphan-token error: "...the Hetzner console" -> "...the Hetzner Cloud
 *      console" / "No Hetzner API token found..." -> "No Hetzner Cloud API
 *      token found..." (same NAME expansion, plus TOKEN_ENV interpolation).
 *   6. scale.js register-ssh-key spinner: "Registering SSH key with
 *      Hetzner..." -> "Registering SSH key with ${Provider.NAME}..." (this
 *      one was a genuine straggler, missed by the original R9 pass and
 *      caught fixing the DO createSSHKey fingerprint-recovery regression —
 *      see digitalocean-methods.test.ts's createSSHKey describe block).
 *
 * 'digitalocean' is used as the non-Hetzner probe id throughout, even though
 * it IS registered in PROVIDERS (see tests/unit/providers/registry.test.ts).
 * Every assertion here only exercises provider-ID-level logic (providerIdFor,
 * or the small pure helpers each gated command exports) — never
 * providerFor()/getProviderClass() — because the gates under test are
 * deliberately id-only (see the docblocks in console.js/diagnose.js): they
 * only need the id to build their message, so reading it directly is
 * simpler and more robust than resolving a provider class they never use.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hetznerOnlyGateError } from '../../../src/console.js';
import { SPEC as DESTROY_SPEC } from '../../../src/destroy.js';
import { hcloudGateSkipNote } from '../../../src/diagnose.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { buildShellTryHint } from '../../../src/shell.js';

describe('scale.js pricing line — Provider.NAME + Provider.PRICING_URL (sanctioned deviation)', () => {
  const SCALE_SRC = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');

  it('both call sites interpolate Provider.NAME and Provider.PRICING_URL', () => {
    const pattern =
      /p\.note\(`Current \$\{Provider\.NAME\} pricing: \$\{Provider\.PRICING_URL\}`, 'Cost'\)/g;
    expect(SCALE_SRC.match(pattern) || []).toHaveLength(2);
  });

  it('renders "Current Hetzner Cloud pricing: <url>" for Hetzner — not the old "Current Hetzner pricing"', () => {
    const rendered = `Current ${HetznerProvider.NAME} pricing: ${HetznerProvider.PRICING_URL}`;
    expect(rendered).toBe('Current Hetzner Cloud pricing: https://www.hetzner.com/cloud/');
  });
});

describe('scale.js SSH-key registration message — Provider.NAME interpolation (sanctioned deviation 6)', () => {
  const SCALE_SRC = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');

  it('interpolates Provider.NAME instead of a hardcoded "Hetzner" literal', () => {
    const pattern = /prep\.start\(`Registering SSH key with \$\{Provider\.NAME\}\.\.\.`\);/;
    expect(SCALE_SRC).toMatch(pattern);
  });

  it('renders "Registering SSH key with Hetzner Cloud..." for Hetzner — not the old "...with Hetzner..."', () => {
    expect(`Registering SSH key with ${HetznerProvider.NAME}...`).toBe(
      'Registering SSH key with Hetzner Cloud...',
    );
  });

  it('renders "Registering SSH key with DigitalOcean..." for DigitalOcean', () => {
    expect(`Registering SSH key with ${DigitalOceanProvider.NAME}...`).toBe(
      'Registering SSH key with DigitalOcean...',
    );
  });
});

describe('destroy.js SPEC — teardown bullets derive from Provider.NAME (sanctioned deviation)', () => {
  it('interpolates the provider name into all four resource bullets', () => {
    expect(DESTROY_SPEC.description).toContain('  • Hetzner Cloud servers and all data on them');
    expect(DESTROY_SPEC.description).toContain(
      '  • Hetzner Cloud volumes (orphaned PVCs from Kubernetes)',
    );
    expect(DESTROY_SPEC.description).toContain('  • Hetzner Cloud firewalls');
    expect(DESTROY_SPEC.description).toContain('  • Hetzner Cloud SSH keys (deployment keys only)');
  });

  it('leaves the non-provider bullets (Cloudflare, GitHub) untouched', () => {
    expect(DESTROY_SPEC.description).toContain('  • Cloudflare DNS records and health checks');
    expect(DESTROY_SPEC.description).toContain('  • GitHub environment secrets');
  });
});

describe('destroy.js console-hint + orphan-token strings — Provider.NAME/.TOKEN_ENV interpolation (sanctioned deviation)', () => {
  const DESTROY_SRC = readFileSync(join(process.cwd(), 'src/destroy.js'), 'utf-8');

  // Shared by deleteStateBucket's no-credentials issue and
  // deleteAppBucketEffect's no-credentials issue — identical template text.
  const orDeleteViaConsoleHint =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal source-code ${Provider.NAME} placeholder, not a JS template
    'hint: `Run \\`vibecarbon destroy\\` again with credentials configured, or delete via the ${Provider.NAME} console.`,';

  it('interpolates Provider.NAME at its one remaining call site (app bucket)', () => {
    // Was 2 — the state-bucket deletion path carried the same hint. Destroy now
    // KEEPS the state bucket (retainStateBucket), so that path and its hint are
    // gone and only the app bucket can leave something the operator must remove
    // by hand.
    const occurrences = DESTROY_SRC.split(orDeleteViaConsoleHint).length - 1;
    expect(occurrences).toBe(1);
  });

  it('renders "...or delete via the Hetzner Cloud console." for Hetzner — not the old "...Hetzner console."', () => {
    const rendered = `Run \`vibecarbon destroy\` again with credentials configured, or delete via the ${HetznerProvider.NAME} console.`;
    expect(rendered).toBe(
      'Run `vibecarbon destroy` again with credentials configured, or delete via the Hetzner Cloud console.',
    );
  });

  // Was shared by the state-bucket and app-bucket error paths; the state bucket
  // is no longer deleted, so only deleteAppBucketEffect's error path remains.
  const emptyManuallyHint =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal source-code ${Provider.NAME} placeholder, not a JS template
    'hint: `Empty manually via the ${Provider.NAME} Object Storage console, then DeleteBucket. Bucket continues to incur storage charges until deleted.`,';

  it('interpolates Provider.NAME at its one remaining call site (app bucket)', () => {
    const occurrences = DESTROY_SRC.split(emptyManuallyHint).length - 1;
    expect(occurrences).toBe(1);
  });

  it('renders "Empty manually via the Hetzner Cloud Object Storage console..." for Hetzner — not the old "...Hetzner Object Storage console..."', () => {
    const rendered = `Empty manually via the ${HetznerProvider.NAME} Object Storage console, then DeleteBucket. Bucket continues to incur storage charges until deleted.`;
    expect(rendered).toBe(
      'Empty manually via the Hetzner Cloud Object Storage console, then DeleteBucket. Bucket continues to incur storage charges until deleted.',
    );
  });

  it('the firewall-leak hint interpolates Provider.NAME', () => {
    expect(DESTROY_SRC).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal source-code ${Provider.NAME} placeholder, not a JS template
      'hint: `Delete it via the ${Provider.NAME} console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".`,',
    );
  });

  it('renders "Delete it via the Hetzner Cloud console — ..." for Hetzner — not the old "...Hetzner console..."', () => {
    const rendered = `Delete it via the ${HetznerProvider.NAME} console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".`;
    expect(rendered).toBe(
      'Delete it via the Hetzner Cloud console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".',
    );
  });

  it('the k8s manual-cleanup hint interpolates Provider.NAME', () => {
    expect(DESTROY_SRC).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal source-code ${dirLabel}/${Provider.NAME} placeholders, not a JS template
      '`You may need to manually clean up resources${dirLabel} in the ${Provider.NAME} console.`,',
    );
  });

  it('renders "You may need to manually clean up resources in the Hetzner Cloud console." for Hetzner (non-HA, empty dirLabel)', () => {
    const dirLabel = '';
    const rendered = `You may need to manually clean up resources${dirLabel} in the ${HetznerProvider.NAME} console.`;
    expect(rendered).toBe(
      'You may need to manually clean up resources in the Hetzner Cloud console.',
    );
  });

  it('the orphan-token error interpolates Provider.NAME and Provider.TOKEN_ENV', () => {
    expect(DESTROY_SRC).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal source-code ${orphanProvider.NAME}/${orphanProvider.TOKEN_ENV} placeholders, not a JS template
      "`No ${orphanProvider.NAME} API token found. Set ${orphanProvider.TOKEN_ENV} in your shell or the project's .env.local — cannot destroy orphan stacks.`,",
    );
  });

  it('renders "No Hetzner Cloud API token found. Set HETZNER_API_TOKEN..." for Hetzner — not the old "No Hetzner API token found..."', () => {
    const rendered = `No ${HetznerProvider.NAME} API token found. Set ${HetznerProvider.TOKEN_ENV} in your shell or the project's .env.local — cannot destroy orphan stacks.`;
    expect(rendered).toBe(
      "No Hetzner Cloud API token found. Set HETZNER_API_TOKEN in your shell or the project's .env.local — cannot destroy orphan stacks.",
    );
  });
});

describe('shell.js welcome-banner "Try:" hint — hcloud-gated (sanctioned deviation)', () => {
  it('includes "hcloud server list" for the Hetzner provider — byte-identical to the pre-R9 static line', () => {
    expect(buildShellTryHint('hetzner')).toBe(
      'Try: kubectl get nodes -o wide   |   ssh root@<ip> journalctl -u k3s   |   hcloud server list',
    );
  });

  it('drops the hcloud-specific segment for a non-Hetzner provider', () => {
    expect(buildShellTryHint('digitalocean')).toBe(
      'Try: kubectl get nodes -o wide   |   ssh root@<ip> journalctl -u k3s',
    );
  });
});

describe('console.js — Hetzner-only gate (new: previously no gate existed)', () => {
  it('passes for an explicit hetzner envConfig (no error)', () => {
    expect(hetznerOnlyGateError({ provider: 'hetzner' })).toBeNull();
  });

  it('passes when envConfig has no provider field (default hetzner)', () => {
    expect(hetznerOnlyGateError(undefined)).toBeNull();
    expect(hetznerOnlyGateError({})).toBeNull();
  });

  it('fails loudly for a non-Hetzner provider, naming it in the message', () => {
    expect(hetznerOnlyGateError({ provider: 'digitalocean' })).toBe(
      'console is Hetzner-only today (VNC via Hetzner Cloud Console). Not supported for digitalocean.',
    );
  });
});

describe('diagnose.js — hcloud section skip note (new gate, provider-id-only — never throws on an unregistered provider)', () => {
  it('names the given provider id in the skip note', () => {
    expect(hcloudGateSkipNote('digitalocean')).toBe(
      'Skipping hcloud section, provider is digitalocean, not Hetzner.',
    );
  });
});
