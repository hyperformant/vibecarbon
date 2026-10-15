import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The database has no public port. Operators reach it through
 * `vibecarbon shell` / SSH, and compose-ha replication runs over WireGuard
 * (5433, never a provider firewall rule here). So no compose firewall may
 * open 5432 or 6543, and `vibecarbon access` rewrites only SSH and the k8s
 * API. The Pulumi programs aren't graph-tested, so this pins the rule set at
 * source level.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');
const PROVIDERS = ['hetzner', 'digitalocean', 'vultr', 'linode', 'scaleway'];

describe('compose firewalls publish no database port', () => {
  it.each(PROVIDERS)('%s-compose.js has no inbound rule for 5432 or 6543', (provider) => {
    const src = read(`src/lib/iac/programs/${provider}-compose.js`);
    for (const port of ['5432', '6543']) {
      // Quoted ('5432') or numeric (port: 5432) rule values, any key spelling.
      expect(src, `${provider}-compose.js opens ${port}`).not.toMatch(
        new RegExp(`(?:port|portRange|ports)\\s*:\\s*'?${port}'?`),
      );
    }
  });

  it.each(PROVIDERS)('%s.js locks only SSH and the k8s API to operator CIDRs', (provider) => {
    const src = read(`src/lib/providers/${provider}.js`);
    expect(src).toMatch(/const OPERATOR_LOCKED_PORTS = new Set\(\[SSH_PORT, K8S_API_PORT\]\);/);
    expect(src).not.toMatch(/POOLER_/);
  });
});
