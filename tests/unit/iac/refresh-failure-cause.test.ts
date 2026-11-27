/**
 * refreshFailureCause: what the refresh warning says when a refresh fails.
 *
 * It used to print the first top-level error line, which for a refresh is the
 * stack's own `error: update failed` (e2e run 45922250720: "[pulumi]
 * pre-destroy refresh warning: error: update failed"). It now names each
 * failing resource and the provider's own error line, from the Diagnostics
 * block of the refresh's output. The real engine's output for a gone Vultr
 * instance is tests/integration/iac/vultr-refresh-prune.test.ts.
 */
import { describe, expect, it } from 'vitest';

const { pulumiDestroyFailureCause, refreshFailureCause, summarizePulumiError } = await import(
  '../../../src/lib/iac/index.js'
);

/** A bridged provider's refresh failure, as the Automation API's CommandError carries it. */
const BRIDGED = [
  'code: 255',
  ' stdout: Refreshing (civ3):',
  '    pulumi:pulumi:Stack p-civ3 running ',
  '    vultr:index:ReservedIp ingress  **refreshing failed**     1 error',
  '    pulumi:pulumi:Stack p-civ3 running error: update failed',
  'Diagnostics:',
  '  vultr:index:ReservedIp (ingress):',
  '    error: refreshing urn:pulumi:civ3::p::vultr:index/reservedIp:ReservedIp::ingress: 1 error occurred:',
  '    \t* sdk-v2/provider2.go:520: sdk.helper_schema: error getting Reserved IPs: {"error":"reserved ip not found","status":404}: provider=vultr@2.27.1',
  '',
  '  pulumi:pulumi:Stack (p-civ3):',
  '    error: update failed',
  '',
  ' stderr: Command failed with exit code 255: pulumi refresh --yes --skip-preview',
].join('\n');

describe('refreshFailureCause', () => {
  it("names the failing resource and the provider's error line, never `update failed`", () => {
    expect(refreshFailureCause(new Error(BRIDGED))).toBe(
      'vultr:index:ReservedIp (ingress): error getting Reserved IPs: {"error":"reserved ip not found","status":404}: provider=vultr@2.27.1',
    );
  });

  it('names every failing resource', () => {
    const two = BRIDGED.replace(
      '  pulumi:pulumi:Stack (p-civ3):',
      [
        '  vultr:index:Instance (master):',
        '    error: refreshing urn:pulumi:civ3::p::vultr:index/instance:Instance::master: error getting instance (i-1): {"error":"instance not found","status":404}',
        '',
        '  pulumi:pulumi:Stack (p-civ3):',
      ].join('\n'),
    );
    expect(refreshFailureCause(new Error(two))).toBe(
      'vultr:index:ReservedIp (ingress): error getting Reserved IPs: {"error":"reserved ip not found","status":404}: provider=vultr@2.27.1; ' +
        'vultr:index:Instance (master): error getting instance (i-1): {"error":"instance not found","status":404}',
    );
  });

  it('with no resource diagnostic, the one-line summary as before', () => {
    const err = new Error('code: 255\n stdout: \n stderr: error: could not read the state file\n');
    expect(refreshFailureCause(err)).toBe(summarizePulumiError(err));
    expect(refreshFailureCause(err)).toContain('error: could not read the state file');
  });
});

describe("the destroy failure's cause reads the engine's wrapper the same way", () => {
  it('a wrapper line that is only `1 error occurred:` is skipped for the line under it', () => {
    const out = [
      'Diagnostics:',
      '  vultr:index:ReservedIp (ingress):',
      '    error: deleting urn:pulumi:civ3::p::vultr:index/reservedIp:ReservedIp::ingress: 1 error occurred:',
      '    \t* error destroying Reserved IP (9b32): {"error":"The server must be closed to detach this IP because it is being used as the main IP","status":400}',
    ].join('\n');
    expect(pulumiDestroyFailureCause(out)).toBe(
      'error destroying Reserved IP (9b32): {"error":"The server must be closed to detach this IP because it is being used as the main IP","status":400}',
    );
  });

  it("a wrapper with the provider's error on the same line keeps that error", () => {
    expect(
      pulumiDestroyFailureCause(
        '    error: deleting urn:pulumi:s::p::fakecloud:index:Vpc::network: DELETE /v2/vpcs/1: 409 Can not delete VPC with members',
      ),
    ).toBe('DELETE /v2/vpcs/1: 409 Can not delete VPC with members');
  });
});
