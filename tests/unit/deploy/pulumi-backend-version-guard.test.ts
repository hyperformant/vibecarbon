/**
 * The Pulumi-too-old guard.
 *
 * A provider that pins `request_checksum_calculation` (today only Scaleway,
 * whose object storage rejects the sentinel Pulumi otherwise sends) hands
 * Pulumi a backend URL that pre-3.256.0 CLIs cannot parse. Every state
 * operation then dies at the FIRST one:
 *
 *   unknown query parameter "request_checksum_calculation"
 *
 * That surfaces from `pulumi stack select`, before any provider code runs,
 * and names neither Pulumi nor a version — it reads like an object-storage
 * credential fault. Live 2026-08-20: a Scaleway compose-HA deploy failed
 * exactly that way on v3.231.0, and the cause was only findable by reading
 * an RCA comment in providers/base.js.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPulumiSupportsBackendOptions,
  checkDeployPrerequisites,
  PULUMI_MIN_VERSION_FOR_BACKEND_CHECKSUM,
  readPulumiVersion,
} from '../../../src/lib/deploy/preflight.js';

const pinning = { STATE_BACKEND_CHECKSUM_CALCULATION: 'when_supported' };
const silent = { STATE_BACKEND_CHECKSUM_CALCULATION: '' };

describe('assertPulumiSupportsBackendOptions', () => {
  it('throws on a CLI older than the minimum, naming the version and the fix', () => {
    expect(() => assertPulumiSupportsBackendOptions(pinning, '3.231.0')).toThrow(/3\.231\.0/);
    expect(() => assertPulumiSupportsBackendOptions(pinning, '3.231.0')).toThrow(
      /get\.pulumi\.com/,
    );
    // The opaque error the operator would otherwise chase must be quoted, so
    // searching for it lands here instead of on their storage credentials.
    expect(() => assertPulumiSupportsBackendOptions(pinning, '3.231.0')).toThrow(
      /unknown query parameter/,
    );
  });

  it('accepts the minimum itself and anything newer', () => {
    expect(() =>
      assertPulumiSupportsBackendOptions(pinning, PULUMI_MIN_VERSION_FOR_BACKEND_CHECKSUM),
    ).not.toThrow();
    expect(() => assertPulumiSupportsBackendOptions(pinning, '3.259.0')).not.toThrow();
    expect(() => assertPulumiSupportsBackendOptions(pinning, '4.0.0')).not.toThrow();
  });

  it('compares numerically, not lexically', () => {
    // '3.9.0' > '3.256.0' as strings. A string compare would wave through a
    // genuinely old CLI and block a new one.
    expect(() => assertPulumiSupportsBackendOptions(pinning, '3.9.0')).toThrow();
    expect(() => assertPulumiSupportsBackendOptions(pinning, '3.1000.0')).not.toThrow();
  });

  it('stays silent for providers that pin no mode — this is not a global gate', () => {
    // Hetzner/DO/Linode/Vultr tolerate Pulumi's default and are unaffected by
    // the CLI's age. Turning this into a blanket minimum would break them for
    // a problem they do not have.
    expect(() => assertPulumiSupportsBackendOptions(silent, '3.100.0')).not.toThrow();
    expect(() => assertPulumiSupportsBackendOptions({}, '3.100.0')).not.toThrow();
    expect(() => assertPulumiSupportsBackendOptions(null, '3.100.0')).not.toThrow();
  });

  it('declines to assert when the version could not be read', () => {
    // Better to proceed and let Pulumi speak than to block a deploy on a
    // version probe that failed for unrelated reasons.
    expect(() => assertPulumiSupportsBackendOptions(pinning, null)).not.toThrow();
  });
});

describe('readPulumiVersion', () => {
  it('parses the v-prefixed CLI output', () => {
    expect(readPulumiVersion({ run: () => 'v3.259.0\n' })).toBe('3.259.0');
  });

  it('parses a bare version too', () => {
    expect(readPulumiVersion({ run: () => '3.256.0' })).toBe('3.256.0');
  });

  it('returns null rather than throwing when the CLI errors', () => {
    expect(
      readPulumiVersion({
        run: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
  });

  it('returns null on unrecognisable output', () => {
    expect(readPulumiVersion({ run: () => 'something else entirely' })).toBeNull();
  });
});

describe('checkDeployPrerequisites wiring', () => {
  const has = () => true;

  it('runs the version assertion for a pinning provider', () => {
    expect(() =>
      checkDeployPrerequisites('compose-ha', {
        has,
        ProviderClass: pinning,
        pulumiVersion: () => '3.231.0',
      }),
    ).toThrow(/too old/i);
  });

  it('does not run it for a non-pinning provider', () => {
    expect(() =>
      checkDeployPrerequisites('compose-ha', {
        has,
        ProviderClass: silent,
        pulumiVersion: () => '3.231.0',
      }),
    ).not.toThrow();
  });

  it('does NOT read the pulumi version when no provider pins a mode', () => {
    // Regression pin: reading it shells out. Called unconditionally, it turned
    // a pure-unit preflight test into real subprocess I/O that timed out in
    // CI, where the unit job has no pulumi on PATH. Locally it "passed"
    // because a dev PATH has pulumi — the worst kind of green.
    let probed = false;
    checkDeployPrerequisites('compose', {
      has,
      ProviderClass: silent,
      pulumiVersion: () => {
        probed = true;
        return '3.231.0';
      },
    });
    expect(probed, 'version probe ran for a provider that pins no checksum mode').toBe(false);
  });

  it('reads it exactly once when a provider DOES pin one', () => {
    let calls = 0;
    expect(() =>
      checkDeployPrerequisites('compose-ha', {
        has,
        ProviderClass: pinning,
        pulumiVersion: () => {
          calls++;
          return '3.259.0';
        },
      }),
    ).not.toThrow();
    expect(calls).toBe(1);
  });

  it('still reports a MISSING tool first — absence beats staleness', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has: (b: string) => b !== 'pulumi',
        ProviderClass: pinning,
        pulumiVersion: () => '3.231.0',
      }),
    ).toThrow(/Missing host-side tools/);
  });
});
