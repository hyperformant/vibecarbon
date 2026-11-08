/**
 * Sweep leaked resources for SPECIFIC e2e scratch project names via the
 * runner's own project-scoped sweep (utils/sweep-provider.ts), on every
 * provider whose compute token is set. This
 * is the sanctioned cleanup for testapp-* projects whose destroy already ran
 * but left raw out-of-state resources (the destroy's orphan handling is
 * stack-based and cannot see them; the account-wide sweep script is
 * deliberately not used here — this targets only the named projects).
 *
 * Usage: REAL_INFRA=true tsx tests/e2e/sweep-project.ts <projectName>...
 * Tokens: each provider's computeTokenEnv (tests/config.ts) from env or
 * tests/.env.e2e (same lookup the runner uses). A provider without one is
 * skipped, and at least one must be set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from '../../src/lib/dotenv.js';
import { testConfig } from '../config.js';
import { sweepProjectOrphans } from './utils/sweep-provider.ts';

const names = process.argv.slice(2).filter((n) => n.startsWith('testapp-'));
if (names.length === 0) {
  console.error('usage: tsx tests/e2e/sweep-project.ts <testapp-...> [more...]');
  process.exit(2);
}

// Read the operator env file (same set the runner exports) so each sweep's
// bucket half can enumerate too: with only a compute token a sweep skips its
// storage half and a leaked bucket survives. Real env wins: a blank export
// counts as unset and falls back to this file, never the other way around.
const envFile = join(import.meta.dirname, '..', '.env.e2e');
const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf-8')) : {};
const env: Record<string, string | undefined> = { ...fileEnv };
for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;

const providers = Object.entries(testConfig.e2e.providers)
  .map(([id, p]) => ({ id, token: env[p.computeTokenEnv] }))
  .filter((p): p is { id: string; token: string } => !!p.token);
if (providers.length === 0) {
  console.error('no provider compute token found in env or tests/.env.e2e');
  process.exit(2);
}

for (const name of names) {
  for (const { id, token } of providers) {
    const { counts } = await sweepProjectOrphans({
      tag: '[sweep-project]',
      provider: id,
      projectName: name,
      token,
      env,
    });
    console.log(`${name} (${id}): ${JSON.stringify(counts)}`);
  }
}
