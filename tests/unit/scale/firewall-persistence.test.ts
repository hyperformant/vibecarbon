import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reader/writer mismatch guard for the compose firewall id.
//
// `scale.js` read `envConfig.firewallId` to re-attach the blue-green
// replacement server to its cloud firewall. No writer anywhere ever set that
// key: both compose Pulumi programs EXPORT `firewallId`, but every consumer of
// their outputs read serverIp/serverId and dropped the rest. So the read was
// always undefined, `buildReplacementServerArgs` produced `firewalls: []`, and
// `scale` deleted a firewalled server and replaced it with an unfirewalled one.
//
// A pure unit test of either half passes happily on its own — that is exactly
// how this survived. What has to hold is the CHAIN: the program exports it, the
// effect captures it, the persist step writes it onto the server entry, and
// scale reads it back off THAT entry (per-server, because compose-ha gives each
// node its own firewall — one per Pulumi stack).
//
// The wire-level "does the provider actually attach it" half is covered
// behaviorally in replacement-server-args.test.ts for both providers.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8');

describe('compose firewallId survives the whole export -> persist -> read chain', () => {
  it('both compose Pulumi programs export firewallId', () => {
    for (const program of [
      'src/lib/iac/programs/hetzner-compose.js',
      'src/lib/iac/programs/digitalocean-compose.js',
    ]) {
      expect(read(program), `${program} must export firewallId for scale to re-attach`).toMatch(
        /firewallId:\s*firewall\.id/,
      );
    }
  });

  it('the single-compose provision effect captures firewallId off the stack outputs', () => {
    expect(read('src/lib/deploy/effects/index.js')).toMatch(
      /providerFirewallId\s*=\s*result\.outputs\.firewallId/,
    );
  });

  it('the compose-ha provision effect captures firewallId for BOTH nodes', () => {
    const src = read('src/lib/deploy/effects/compose-ha.js');
    expect(src).toMatch(/firewallId:\s*primaryResult\.outputs\.firewallId/);
    expect(src).toMatch(/firewallId:\s*standbyResult\.outputs\.firewallId/);
  });

  it('both persist paths write firewallId onto the SERVER entry', () => {
    // Single compose: orchestrator builds servers[0] from deployResult.
    expect(read('src/lib/deploy/orchestrator.js')).toMatch(
      /deployResult\.firewallId\s*&&\s*\{\s*firewallId:\s*deployResult\.firewallId\s*\}/,
    );
    // compose-ha: one entry per node, each with its own stack's firewall.
    const ha = read('src/lib/deploy/effects/compose-ha.js');
    expect(ha).toMatch(/primary\.firewallId\s*&&\s*\{\s*firewallId:\s*primary\.firewallId\s*\}/);
    expect(ha).toMatch(/standby\.firewallId\s*&&\s*\{\s*firewallId:\s*standby\.firewallId\s*\}/);
  });

  it('scale reads it off the server entry, never off envConfig (nothing writes that)', () => {
    const src = read('src/scale.js');
    expect(src).toMatch(/firewallId:\s*server\.firewallId/);
    // Judge CODE, not prose — the fix's own comment names the dead key.
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(
      code,
      'envConfig.firewallId has no writer — reading it silently yields undefined and ' +
        'produces an unfirewalled replacement server',
    ).not.toMatch(/envConfig\.firewallId/);
  });
});
