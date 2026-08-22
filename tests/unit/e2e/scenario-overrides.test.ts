import { describe, expect, it } from 'vitest';
import { overrideDnsProvider, resolveBaseDomain } from '../../e2e/utils/scenario-overrides.js';

describe('overrideDnsProvider (E2E_DNS_PROVIDER knob)', () => {
  const scenarios = [
    { mode: 'compose', dnsProvider: 'hetzner' },
    { mode: 'compose-ha', dnsProvider: 'cloudflare' },
  ] as const;

  it('returns scenarios unchanged when the override is unset or empty', () => {
    expect(overrideDnsProvider(scenarios, undefined)).toBe(scenarios);
    expect(overrideDnsProvider(scenarios, '')).toBe(scenarios);
    expect(overrideDnsProvider(scenarios, '  ')).toBe(scenarios);
  });

  it('forces every scenario onto the given provider', () => {
    const out = overrideDnsProvider(scenarios, 'hetzner');
    expect(out.map((s) => s.dnsProvider)).toEqual(['hetzner', 'hetzner']);
    expect(out.map((s) => s.mode)).toEqual(['compose', 'compose-ha']);
    // no mutation of the input
    expect(scenarios[1].dnsProvider).toBe('cloudflare');
  });

  it('accepts every native DNS backend in the registry', () => {
    // The allowlist tracks DNS_PROVIDERS (src/lib/dns-provider.js) minus
    // `manual`. `vultr` is accepted here even though it has no e2e base
    // domain yet — the missing-domain failure belongs to resolveBaseDomain
    // (pinned below), not to this knob.
    for (const p of ['hetzner', 'cloudflare', 'digitalocean', 'linode', 'vultr'] as const) {
      expect(overrideDnsProvider(scenarios, p).map((s) => s.dnsProvider)).toEqual([p, p]);
    }
  });

  it('throws on an unknown provider', () => {
    expect(() => overrideDnsProvider(scenarios, 'route53')).toThrow(/E2E_DNS_PROVIDER/);
  });

  it('names every valid provider in the rejection message', () => {
    expect(() => overrideDnsProvider(scenarios, 'route53')).toThrow(
      /hetzner, cloudflare, digitalocean, linode, vultr/,
    );
  });

  it('rejects `manual` — a whole-matrix pin to hand-edited DNS is not a thing', () => {
    expect(() => overrideDnsProvider(scenarios, 'manual')).toThrow(/E2E_DNS_PROVIDER/);
  });
});

describe('resolveBaseDomain (E2E_DOMAIN knob)', () => {
  const domains = {
    hetzner: 'carbonstack.dev',
    cloudflare: 'appcarbon.dev',
    digitalocean: 'do.appcarbon.dev',
    linode: 'linode.appcarbon.dev',
  };

  it('uses the provider-mapped domain when the override is unset or empty', () => {
    expect(resolveBaseDomain(domains, 'hetzner', undefined)).toBe('carbonstack.dev');
    expect(resolveBaseDomain(domains, 'cloudflare', '')).toBe('appcarbon.dev');
  });

  it('maps the native DNS backends to their delegated e2e zones', () => {
    expect(resolveBaseDomain(domains, 'digitalocean', undefined)).toBe('do.appcarbon.dev');
    expect(resolveBaseDomain(domains, 'linode', undefined)).toBe('linode.appcarbon.dev');
  });

  it('uses the override for every provider when set', () => {
    expect(resolveBaseDomain(domains, 'hetzner', 'carbonstack.dev')).toBe('carbonstack.dev');
    expect(resolveBaseDomain(domains, 'cloudflare', 'carbonstack.dev')).toBe('carbonstack.dev');
    expect(resolveBaseDomain(domains, 'hetzner', ' example.dev ')).toBe('example.dev');
  });

  it('throws naming the missing key when the DNS provider has no domain — never "x.undefined"', () => {
    // vultr is a selectable DNS backend with no delegated e2e zone yet. The
    // pre-fix behavior returned undefined and the caller interpolated
    // `v1.undefined` as a real domain, failing ~20 min later at cert
    // issuance with an error naming neither the scenario nor the cause.
    expect(() => resolveBaseDomain(domains, 'vultr', undefined)).toThrow(/'vultr'/);
    expect(() => resolveBaseDomain(domains, 'vultr', undefined)).toThrow(
      /testConfig\.e2e\.domains/,
    );
    // The message must enumerate what IS configured, so the operator can see
    // at a glance whether they mistyped or genuinely need to delegate a zone.
    expect(() => resolveBaseDomain(domains, 'vultr', undefined)).toThrow(
      /hetzner, cloudflare, digitalocean, linode/,
    );
  });

  it('E2E_DOMAIN rescues a DNS provider that has no mapped domain', () => {
    // The override is checked before the map, so pinning a base domain is a
    // valid way to run a not-yet-delegated backend against a zone you own.
    expect(resolveBaseDomain(domains, 'vultr', 'vultrzone.dev')).toBe('vultrzone.dev');
  });
});
