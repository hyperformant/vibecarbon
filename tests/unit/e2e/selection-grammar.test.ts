import { describe, expect, it } from 'vitest';
import { resolveSelection, SelectionError } from '../../e2e/selection.js';

const modes = (sel: ReturnType<typeof resolveSelection>) =>
  sel.map((s) => `${s.provider}/${s.mode}`);

describe('resolveSelection — defaults', () => {
  it('bare invocation throws — there is NO default provider', () => {
    // Every provider is equal, so none is the implicit one. This used to fall
    // back to whichever carried `releaseGating: true`, a flag that gated no
    // release (release.yml fires on the unit/integration Test Suite, never on
    // e2e) and existed only to privilege one provider at this call site.
    expect(() => resolveSelection({})).toThrow(SelectionError);
    expect(() => resolveSelection({})).toThrow(/no provider selected/);
    expect(() => resolveSelection({})).toThrow(/no provider is privileged/);
  });

  it('names every known provider in that error, so the fix is obvious', () => {
    expect(() => resolveSelection({})).toThrow(
      /hetzner\|digitalocean\|linode\|vultr\|scaleway\|all/,
    );
  });

  it('--provider hetzner still gives the four Hetzner modes', () => {
    expect(modes(resolveSelection({ providers: ['hetzner'] }))).toEqual([
      'hetzner/compose',
      'hetzner/compose-ha',
      'hetzner/k8s',
      'hetzner/k8s-ha',
    ]);
  });

  it('--provider digitalocean = DO defaults (3, no k8s-ha)', () => {
    expect(modes(resolveSelection({ providers: ['digitalocean'] }))).toEqual([
      'digitalocean/compose',
      'digitalocean/compose-ha',
      'digitalocean/k8s',
    ]);
  });

  it('--provider all = every provider defaults, hetzner first (13 total)', () => {
    // 4 hetzner + 3 digitalocean + 2 linode + 2 vultr + 2 scaleway
    // (2026-08 expansion PRs 1-3 + tier-parity wave 1).
    const sel = resolveSelection({ providers: ['all'] });
    expect(sel).toHaveLength(13);
    expect(sel[0]).toMatchObject({ provider: 'hetzner', mode: 'compose' });
    expect(sel[6]).toMatchObject({ provider: 'digitalocean', mode: 'k8s' });
    expect(sel[7]).toMatchObject({ provider: 'linode', mode: 'compose' });
    expect(sel[8]).toMatchObject({ provider: 'linode', mode: 'compose-ha' });
    expect(sel[9]).toMatchObject({ provider: 'vultr', mode: 'compose' });
    expect(sel[10]).toMatchObject({ provider: 'vultr', mode: 'compose-ha' });
    expect(sel[11]).toMatchObject({ provider: 'scaleway', mode: 'compose' });
    expect(sel[12]).toMatchObject({ provider: 'scaleway', mode: 'compose-ha' });
  });
});

describe('resolveSelection — explicit tokens', () => {
  it('single provider/mode token', () => {
    expect(modes(resolveSelection({ include: ['hetzner/k8s-ha'] }))).toEqual(['hetzner/k8s-ha']);
  });

  it('cross-provider mix in one list, output in registry order', () => {
    expect(modes(resolveSelection({ include: ['digitalocean/compose', 'hetzner/k8s'] }))).toEqual([
      'hetzner/k8s',
      'digitalocean/compose',
    ]);
  });

  it('mode-dnsProvider refinement OVERRIDES the row default', () => {
    // e4 defaults to hetzner now, so this asks for a non-default backend.
    const sel = resolveSelection({ include: ['hetzner/k8s-ha-cloudflare'] });
    expect(sel).toHaveLength(1);
    expect(sel[0].dnsProvider).toBe('cloudflare');
  });

  it('the refinement alternation is derived from the domains map — native DNS ids parse', () => {
    // The alternation comes from testConfig.e2e.domains (the backends we hold
    // a base domain for), not from the dnsProvider values the rows happen to
    // use. Sourcing it from the rows made the set collapse as each provider
    // moved onto its own native DNS.
    expect(resolveSelection({ include: ['digitalocean/compose-digitalocean'] })).toHaveLength(1);
    expect(resolveSelection({ include: ['linode/compose-linode'] })[0].dnsProvider).toBe('linode');
  });

  it('any backend with a base domain is selectable on ANY scenario', () => {
    // The point of the override: cloudflare is nobody's default any more, but
    // it stays available everywhere. Previously this threw.
    expect(resolveSelection({ include: ['digitalocean/compose-cloudflare'] })[0].dnsProvider).toBe(
      'cloudflare',
    );
    expect(resolveSelection({ include: ['linode/compose-cloudflare'] })[0].dnsProvider).toBe(
      'cloudflare',
    );
  });

  it('an override never silently empties the selection', () => {
    // The failure mode the old filter semantics had: a refinement that matched
    // no row returned [] — indistinguishable from a clean run of nothing.
    const sel = resolveSelection({ include: ['hetzner/compose-cloudflare'] });
    expect(sel).toHaveLength(1);
    expect(sel[0].envPrefix).toBe('e1');
  });

  it('vultr/compose runs on native Vultr DNS (own apex, threvidence.com)', () => {
    // Vultr's API rejects subdomain zones, so this needed a separate
    // registrable domain rather than a 3-label delegation like do./linode.
    expect(resolveSelection({ include: ['vultr/compose'] })[0].dnsProvider).toBe('vultr');
    expect(resolveSelection({ include: ['vultr/compose-vultr'] })[0].dnsProvider).toBe('vultr');
  });

  it('scaleway/compose runs on native Scaleway DNS (own apex, threadtrace.app)', () => {
    // Scaleway's Domains API requires the account to own the domain as an
    // EXTERNAL DOMAIN before it will serve any zone for it, so this needed
    // a separate registrable domain rather than a 3-label delegation like
    // do./linode. threadtrace.app was onboarded + validated and delegated
    // to ns0/ns1.dom.scw.cloud on 2026-08-13.
    expect(resolveSelection({ include: ['scaleway/compose'] })[0].dnsProvider).toBe('scaleway');
    expect(resolveSelection({ include: ['scaleway/compose-scaleway'] })[0].dnsProvider).toBe(
      'scaleway',
    );
  });

  it('a DNS refinement on an exclude token is refused, not silently ignored', () => {
    expect(() =>
      resolveSelection({ providers: ['all'], exclude: ['hetzner/k8s-ha-cloudflare'] }),
    ).toThrow(/DNS refinement is an override and cannot be excluded/);
  });

  it('provider + include composes: include filters within the provider pool', () => {
    expect(
      modes(resolveSelection({ providers: ['hetzner'], include: ['hetzner/compose'] })),
    ).toEqual(['hetzner/compose']);
  });

  it('exclude removes from a provider default selection', () => {
    // --provider is now required: exclude alone no longer implies a provider,
    // because there is no default one to subtract from.
    expect(
      modes(resolveSelection({ providers: ['hetzner'], exclude: ['hetzner/k8s-ha'] })),
    ).toEqual(['hetzner/compose', 'hetzner/compose-ha', 'hetzner/k8s']);
  });

  it('exclude with no provider throws rather than guessing one', () => {
    expect(() => resolveSelection({ exclude: ['hetzner/k8s-ha'] })).toThrow(/no provider selected/);
  });

  it('provider all + exclude', () => {
    const sel = resolveSelection({ providers: ['all'], exclude: ['digitalocean/compose-ha'] });
    expect(sel).toHaveLength(12);
  });
});

describe('resolveSelection — loud failures (no legacy forms)', () => {
  it('bare mode token throws with the valid forms named', () => {
    expect(() => resolveSelection({ include: ['compose'] })).toThrow(SelectionError);
    expect(() => resolveSelection({ include: ['compose'] })).toThrow(/provider\/mode/);
  });

  it('legacy d1 token throws with invalid token message', () => {
    expect(() => resolveSelection({ include: ['d1'] })).toThrow(/provider\/mode/);
  });

  it('unknown provider throws naming known providers', () => {
    expect(() => resolveSelection({ providers: ['aws'] })).toThrow(/known: hetzner, digitalocean/);
  });

  it('mode unsupported by provider throws naming supported modes', () => {
    expect(() => resolveSelection({ include: ['digitalocean/k8s-ha'] })).toThrow(
      /does not support k8s-ha.*compose, compose-ha, k8s/,
    );
  });

  it('include token outside the --provider pool throws with pool message', () => {
    expect(() =>
      resolveSelection({ providers: ['hetzner'], include: ['digitalocean/compose'] }),
    ).toThrow(/outside.*--provider/);
  });

  it('a refinement naming the row default is accepted as a no-op', () => {
    // e4 defaults to hetzner; spelling it explicitly is redundant, not wrong.
    const sel = resolveSelection({ include: ['hetzner/k8s-ha-hetzner'] });
    expect(sel).toHaveLength(1);
    expect(sel[0].dnsProvider).toBe('hetzner');
  });

  it('an unrecognised DNS id throws as an unsupported MODE, not a DNS error', () => {
    // The alternation IS the enforcement: an id absent from the domains map is
    // never captured as a refinement group, so the mode group swallows it.
    // Oblique but accurate — and pinned so the message is a known quantity.
    expect(() => resolveSelection({ include: ['hetzner/k8s-ha-route53'] })).toThrow(
      /hetzner does not support k8s-ha-route53/,
    );
  });

  it('empty mode (trailing slash) throws with invalid token message', () => {
    expect(() => resolveSelection({ include: ['hetzner/'] })).toThrow(/provider\/mode/);
  });

  it('case-insensitive token parsing', () => {
    expect(modes(resolveSelection({ include: ['HETZNER/K8S'] }))).toEqual(['hetzner/k8s']);
  });
});
