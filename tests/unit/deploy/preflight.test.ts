import { describe, expect, it } from 'vitest';
import { checkDeployPrerequisites } from '../../../src/lib/deploy/preflight.js';

// A stub PATH-lookup: present unless listed in `absent`.
const has = (absent: string[]) => (bin: string) => !absent.includes(bin);
// k8s tiers read the Pulumi version; never shell out from a unit test.
const pulumiVersion = () => '3.273.0';

describe('checkDeployPrerequisites', () => {
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha']) {
    it(`throws a pulumi-install hint when pulumi is missing (${tier})`, () => {
      expect(() => checkDeployPrerequisites(tier, { has: has(['pulumi']), pulumiVersion })).toThrow(
        /pulumi/,
      );
      expect(() => checkDeployPrerequisites(tier, { has: has(['pulumi']), pulumiVersion })).toThrow(
        /get\.pulumi\.com/,
      );
    });

    it(`does not throw when pulumi + ssh are present (${tier})`, () => {
      expect(() => checkDeployPrerequisites(tier, { has: has([]), pulumiVersion })).not.toThrow();
    });
  }

  it('names ssh when ssh is missing', () => {
    expect(() => checkDeployPrerequisites('compose', { has: has(['ssh']) })).toThrow(/ssh/);
  });

  it('lists every missing tool at once', () => {
    let message = '';
    try {
      checkDeployPrerequisites('k8s', { has: has(['pulumi', 'ssh']), pulumiVersion });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/pulumi/);
    expect(message).toMatch(/ssh/);
  });

  it('does not raise an ENOENT-style error (message is human-readable)', () => {
    expect(() => checkDeployPrerequisites('compose', { has: has(['pulumi']) })).toThrow(
      /Missing host-side tools/,
    );
  });
});
