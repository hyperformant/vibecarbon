import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertOperatorConfig,
  checkDeployPrerequisites,
} from '../../../src/lib/deploy/preflight.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

// A stub PATH-lookup: everything present (host-tool checks aren't under
// test here — see preflight.test.ts for those).
const has = () => true;

const GOOD_HETZNER_TOKEN = 'a'.repeat(64);

describe('checkDeployPrerequisites — operator config gate', () => {
  it('throws with the Configuration problems header when a scoped value is malformed', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner'],
        env: { HETZNER_API_TOKEN: '"abc"' },
      }),
    ).toThrow(/^Configuration problems \(nothing was provisioned\):/);
  });

  it('the thrown message names the malformed variable and points at .env.local', () => {
    let message = '';
    try {
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner'],
        env: { HETZNER_API_TOKEN: '"abc"' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/HETZNER_API_TOKEN/);
    expect(message).toMatch(/Set them in \.env\.local/);
  });

  it('does not throw when every scoped value is well-formed', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner'],
        env: {
          HETZNER_API_TOKEN: GOOD_HETZNER_TOKEN,
          HETZNER_ACCESS_KEY: 'access-key-id',
          HETZNER_SECRET_KEY: 'a-secret-key-long-enough',
        },
      }),
    ).not.toThrow();
  });

  it('does not throw when no operatorScopes/operatorKeys are given (default — deploy.js-external callers opt out)', () => {
    expect(() => checkDeployPrerequisites('compose', { has })).not.toThrow();
  });

  it('lists problems from every scope together, in one throw — full message pinned', () => {
    let message = '';
    try {
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner', 'tls'],
        env: {
          HETZNER_API_TOKEN: '"abc"',
          HETZNER_ACCESS_KEY: 'access-key-id',
          HETZNER_SECRET_KEY: 'a-secret-key-long-enough',
          ACME_CA_SERVER: 'not-a-url',
        },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    // The `— surrounding quotes?` hint is keyed off the RAW paste (`'"abc"'`
    // here), which readOperatorVar threads through separately from the
    // normalized value it validates (M10, review 2026-09-19) — before that the
    // hint was unreachable from every real call site.
    expect(message).toBe(
      [
        'Configuration problems (nothing was provisioned):',
        '  - HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 3 characters — surrounding quotes?',
        '  - ACME_CA_SERVER looks wrong: expected an https:// ACME directory URL, got 9 characters',
        "Set them in .env.local (never committed; see .env.local.example for each variable's format).",
        'Set VIBECARBON_SKIP_CONFIG_SHAPES=1 to downgrade shape problems to warnings if a provider changed its token format.',
      ].join('\n'),
    );
  });

  it('never fails on an optional key that is simply absent', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['tls', 'access', 'state'],
        env: {},
      }),
    ).not.toThrow();
  });

  it('operatorKeys validates an individual key alongside operatorScopes (the cross-cloud DNS case)', () => {
    let message = '';
    try {
      checkDeployPrerequisites('compose', {
        has,
        operatorScopes: ['access'],
        operatorKeys: ['CLOUDFLARE_API_TOKEN'],
        env: { CLOUDFLARE_API_TOKEN: '' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/CLOUDFLARE_API_TOKEN is not set/);
  });

  it('a required key still refuses on plain "not set" (presence defaults to true here)', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        operatorScopes: ['provider:hetzner'],
        env: {},
      }),
    ).toThrow(/HETZNER_API_TOKEN is not set/);
  });
});

describe('assertOperatorConfig', () => {
  it('is a no-op when nothing is wrong', () => {
    expect(() => assertOperatorConfig(['tls', 'access', 'state'], { env: {} })).not.toThrow();
  });

  it('throws the canonical message for a malformed value', () => {
    expect(() => assertOperatorConfig(['tls'], { env: { ACME_CA_SERVER: 'not-a-url' } })).toThrow(
      /^Configuration problems \(nothing was provisioned\):\n {2}- ACME_CA_SERVER looks wrong/,
    );
  });

  it('presence: false tolerates a MISSING value but still refuses a MALFORMED one', () => {
    // Missing entirely — tolerated (a prompt is coming for this one).
    expect(() =>
      assertOperatorConfig(['provider:hetzner'], { presence: false, env: {} }),
    ).not.toThrow();
    // Present but garbled — still refused, presence never covers this.
    expect(() =>
      assertOperatorConfig(['provider:hetzner'], {
        presence: false,
        env: { HETZNER_API_TOKEN: '"abc"' },
      }),
    ).toThrow(/HETZNER_API_TOKEN looks wrong/);
  });

  it('keys checks an individually-named registered key not covered by scopes', () => {
    expect(() =>
      assertOperatorConfig([], {
        presence: false,
        keys: ['HETZNER_API_TOKEN'],
        env: { HETZNER_API_TOKEN: '"abc"' },
      }),
    ).toThrow(/HETZNER_API_TOKEN looks wrong/);
  });

  it('a key already covered by scopes is not checked twice (no duplicate problem line)', () => {
    let message = '';
    try {
      assertOperatorConfig(['provider:hetzner'], {
        keys: ['HETZNER_API_TOKEN'],
        env: { HETZNER_API_TOKEN: '"abc"' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.match(/HETZNER_API_TOKEN/g)).toHaveLength(1);
  });
});

// A7 (review 2026-09-19): the escape hatch for a vendor format change. A
// tight registry regex is a bet on the vendor's documented format staying
// the only accepted one; if that bet loses between releases, an operator
// must be able to deploy TODAY, not wait for a CLI patch. The hatch only
// downgrades SHAPE problems ("looks wrong") — a MISSING required value has
// nothing to do with a format change and still refuses.
describe('assertOperatorConfig — VIBECARBON_SKIP_CONFIG_SHAPES=1 escape hatch', () => {
  const ambient = process.env.VIBECARBON_SKIP_CONFIG_SHAPES;

  afterEach(() => {
    if (ambient === undefined) delete process.env.VIBECARBON_SKIP_CONFIG_SHAPES;
    else process.env.VIBECARBON_SKIP_CONFIG_SHAPES = ambient;
    vi.restoreAllMocks();
  });

  it('downgrades a shape problem to a warning and does not throw', () => {
    process.env.VIBECARBON_SKIP_CONFIG_SHAPES = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      assertOperatorConfig(['provider:hetzner'], {
        env: {
          HETZNER_API_TOKEN: 'abc',
          HETZNER_ACCESS_KEY: 'access-key-id',
          HETZNER_SECRET_KEY: 'a-secret-key-long-enough',
        },
      }),
    ).not.toThrow();

    const printed = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toMatch(/HETZNER_API_TOKEN looks wrong/);
    expect(printed).toMatch(/VIBECARBON_SKIP_CONFIG_SHAPES/);
    // Never the value.
    expect(printed).not.toContain('abc');
  });

  it('still refuses a MISSING required value — presence is not a shape problem', () => {
    process.env.VIBECARBON_SKIP_CONFIG_SHAPES = '1';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => assertOperatorConfig(['provider:hetzner'], { env: {} })).toThrow(
      /HETZNER_API_TOKEN is not set/,
    );
  });

  it('with both kinds present, warns about the shape problems and throws only the presence ones', () => {
    process.env.VIBECARBON_SKIP_CONFIG_SHAPES = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let message = '';
    try {
      assertOperatorConfig(['provider:hetzner'], {
        env: { HETZNER_API_TOKEN: 'abc', HETZNER_ACCESS_KEY: 'access-key-id' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/HETZNER_SECRET_KEY is not set/);
    expect(message).not.toMatch(/HETZNER_API_TOKEN/);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(
      /HETZNER_API_TOKEN looks wrong/,
    );
  });

  it('is inert unless set to exactly "1" (unset, empty, "0", "true" all keep refusing)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of [undefined, '', '0', 'true']) {
      if (value === undefined) delete process.env.VIBECARBON_SKIP_CONFIG_SHAPES;
      else process.env.VIBECARBON_SKIP_CONFIG_SHAPES = value;
      expect(() => assertOperatorConfig(['tls'], { env: { ACME_CA_SERVER: 'not-a-url' } })).toThrow(
        /ACME_CA_SERVER looks wrong/,
      );
    }
  });

  it('the refusal footer documents the hatch', () => {
    delete process.env.VIBECARBON_SKIP_CONFIG_SHAPES;
    expect(() => assertOperatorConfig(['tls'], { env: { ACME_CA_SERVER: 'not-a-url' } })).toThrow(
      /Set VIBECARBON_SKIP_CONFIG_SHAPES=1 to downgrade shape problems to warnings if a provider changed its token format\.$/,
    );
  });
});
