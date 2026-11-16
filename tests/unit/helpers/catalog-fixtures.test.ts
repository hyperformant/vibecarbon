/**
 * `flux-hetzner-cx23-hel1` has no file: `readCatalogFixture` derives it from
 * the 2026-10-22 Hetzner capture. About 35 tests seed a provider with it, so
 * this pins what the derivation changes and that it changes nothing else.
 */
import { describe, expect, it } from 'vitest';
import { readCatalogFixture } from './catalog-fixtures.js';

// biome-ignore lint/suspicious/noExplicitAny: fixtures are untyped API JSON
type Json = any;

const available = (fixture: Json, type: string) =>
  fixture.server_types
    .find((t: Json) => t.name === type)
    .locations.filter((l: Json) => l.available)
    .map((l: Json) => l.name);

describe('the derived flux-hetzner-cx23-hel1 catalog fixture', () => {
  it('has cx23 orderable in hel1 only, where the capture has it orderable nowhere', () => {
    expect(available(readCatalogFixture('2026-10-22/hetzner'), 'cx23')).toEqual([]);
    expect(available(readCatalogFixture('flux-hetzner-cx23-hel1'), 'cx23')).toEqual(['hel1']);
  });

  it('differs from the capture in that flag, `captured` and `source` only', () => {
    const capture = readCatalogFixture('2026-10-22/hetzner');
    const derived = readCatalogFixture('flux-hetzner-cx23-hel1');
    expect(derived.captured).toBe('2026-10-22 (edited)');
    expect(derived.source).toMatch(/^Synthetic: /);

    // Undo the three differences; what is left must be the capture.
    derived.captured = capture.captured;
    derived.source = capture.source;
    derived.server_types
      .find((t: Json) => t.name === 'cx23')
      .locations.find((l: Json) => l.name === 'hel1').available = false;
    expect(derived).toStrictEqual(capture);
  });

  it('gives each caller its own object', () => {
    expect(readCatalogFixture('flux-hetzner-cx23-hel1')).not.toBe(
      readCatalogFixture('flux-hetzner-cx23-hel1'),
    );
  });
});
