/**
 * A parked add-on is refused by `add` and hidden from what it prints. The
 * refusal itself ("not available in this release") is the one place `add`
 * may echo a parked name back, because the user typed it. A typo suggestion
 * or the off-TTY hint naming one would offer what the release turned off.
 */
import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_FEATURES,
  buildSpec,
  featureRequirementHint,
  findClosestFeature,
  PARKED_FEATURES,
} from '../../../src/add.js';

describe('add: parked features', () => {
  it('offers no parked feature', () => {
    const offered = AVAILABLE_FEATURES.map((f) => f.name);
    expect(offered).toContain('observability');
    for (const name of PARKED_FEATURES) expect(offered).not.toContain(name);
  });

  it('suggests an offered feature for a typo', () => {
    expect(findClosestFeature('redsi')).toBe('redis');
    expect(findClosestFeature('observabilty')).toBe('observability');
  });

  it('never suggests a parked feature, even for a near-miss of one', () => {
    for (const name of PARKED_FEATURES) {
      for (const typo of [name.slice(0, -1), `${name}x`, name.toUpperCase(), `x${name.slice(1)}`]) {
        const suggestion = findClosestFeature(typo);
        expect(PARKED_FEATURES, `${typo} -> ${suggestion}`).not.toContain(suggestion);
      }
    }
  });

  it('the off-TTY hint names only offered features', () => {
    const hint = featureRequirementHint();
    for (const f of AVAILABLE_FEATURES) expect(hint).toContain(f.name);
    for (const name of PARKED_FEATURES) expect(hint).not.toContain(name);
  });

  it('the help body lists only offered features', () => {
    const spec = buildSpec();
    const text = `${spec.summary}\n${spec.description}`;
    for (const name of PARKED_FEATURES) expect(text).not.toContain(name);
  });
});
