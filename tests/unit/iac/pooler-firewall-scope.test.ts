import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Supavisor pooler ports (5432 session / 6543 transaction) are password
 * auth straight into Postgres. Compose firewalls open them to OPERATOR CIDRS
 * ONLY — the same allowlist as SSH — never to the world. The Pulumi programs
 * aren't graph-tested, so this pins the rule shape at source level; the e2e
 * supavisor-pooler check provides live ground truth.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('pooler firewall rules are operator-scoped, never world-open', () => {
  it.each([
    ['src/lib/iac/programs/hetzner-compose.js', 'sourceIps'],
    ['src/lib/iac/programs/digitalocean-compose.js', 'sourceAddresses'],
  ])('%s declares 5432 and 6543 scoped to allowedSshIps', (rel, sourceKey) => {
    const src = read(rel);
    for (const port of ['5432', '6543']) {
      // The rule for this port must exist…
      const ruleRe = new RegExp(`port(?:Range)?: '${port}'[^}]*`);
      const match = src.match(ruleRe);
      expect(match, `no inbound rule for ${port} in ${rel}`).not.toBeNull();
      // …and its source must be the operator allowlist, not 0.0.0.0/0.
      expect(match?.[0]).toContain(`${sourceKey}: allowedSshIps`);
      expect(match?.[0]).not.toContain('0.0.0.0/0');
    }
  });
});
