import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';
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

  it('--provider hetzner gives its three default modes', () => {
    expect(modes(resolveSelection({ providers: ['hetzner'] }))).toEqual([
      'hetzner/compose',
      'hetzner/k8s',
      'hetzner/k8s-ha',
    ]);
  });

  it('--provider digitalocean = DO defaults (the same three)', () => {
    expect(modes(resolveSelection({ providers: ['digitalocean'] }))).toEqual([
      'digitalocean/compose',
      'digitalocean/k8s',
      'digitalocean/k8s-ha',
    ]);
  });

  it('--provider vultr = Vultr defaults (the same three)', () => {
    expect(modes(resolveSelection({ providers: ['vultr'] }))).toEqual([
      'vultr/compose',
      'vultr/k8s',
      'vultr/k8s-ha',
    ]);
  });

  it('--provider all = every provider defaults, hetzner first (15 total, no compose-ha)', () => {
    expect(modes(resolveSelection({ providers: ['all'] }))).toEqual([
      'hetzner/compose',
      'hetzner/k8s',
      'hetzner/k8s-ha',
      'digitalocean/compose',
      'digitalocean/k8s',
      'digitalocean/k8s-ha',
      'linode/compose',
      'linode/k8s',
      'linode/k8s-ha',
      'vultr/compose',
      'vultr/k8s',
      'vultr/k8s-ha',
      'scaleway/compose',
      'scaleway/k8s',
      'scaleway/k8s-ha',
    ]);
    expect(resolveSelection({ providers: ['all'] })).toHaveLength(15);
  });

  it('--provider scaleway = Scaleway defaults (the same three)', () => {
    expect(modes(resolveSelection({ providers: ['scaleway'] }))).toEqual([
      'scaleway/compose',
      'scaleway/k8s',
      'scaleway/k8s-ha',
    ]);
  });

  it('compose-ha runs on every provider when it is named', () => {
    // The five tokens docs/tests.md gives for a compose-ha run on GitHub,
    // where each leg adds its own `--provider`.
    const all = ['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway'];
    expect(modes(resolveSelection({ include: all.map((p) => `${p}/compose-ha`) }))).toEqual(
      all.map((p) => `${p}/compose-ha`),
    );
    for (const p of all) {
      expect(modes(resolveSelection({ providers: [p], include: [`${p}/compose-ha`] }))).toEqual([
        `${p}/compose-ha`,
      ]);
    }
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

  it('scaleway/compose runs on native Scaleway DNS (own apex, yachtbunker.com)', () => {
    // Scaleway's Domains API requires the account to own the domain as an
    // EXTERNAL DOMAIN before it will serve any zone for it, so this needed
    // a separate registrable domain rather than a 3-label delegation like
    // do./linode.
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
    ).toEqual(['hetzner/compose', 'hetzner/k8s']);
  });

  it('exclude with no provider throws rather than guessing one', () => {
    expect(() => resolveSelection({ exclude: ['hetzner/k8s-ha'] })).toThrow(/no provider selected/);
  });

  it('provider all + exclude', () => {
    const sel = resolveSelection({ providers: ['all'], exclude: ['digitalocean/k8s'] });
    expect(sel).toHaveLength(14);
    expect(modes(sel)).not.toContain('digitalocean/k8s');
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
    // Every provider registers all four modes now, so a compose-only
    // registry row stands in for one that does not.
    const providers = testConfig.e2e.providers as unknown as Record<
      string,
      { scenarios: { mode: string }[] }
    >;
    const original = providers.scaleway;
    providers.scaleway = { ...original, scenarios: original.scenarios.slice(0, 2) };
    try {
      expect(() => resolveSelection({ include: ['scaleway/k8s'] })).toThrow(
        /does not support k8s.*compose, compose-ha/,
      );
    } finally {
      providers.scaleway = original;
    }
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
