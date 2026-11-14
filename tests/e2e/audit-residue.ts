/**
 * Weekly read-only audit: inventories every e2e provider account and reports
 * anything test-shaped that was left behind. Never deletes.
 *
 * Exit 1 when any residue is found, else 2 when an inventory was incomplete,
 * else 0. The summary goes to stdout and, in Actions, to $GITHUB_STEP_SUMMARY.
 * Output is public in CI: only test-shaped rows are named (see residue-audit.ts).
 *
 * Usage: REAL_INFRA=true tsx tests/e2e/audit-residue.ts
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from '../../src/lib/dotenv.js';
import { applyNetworkDefaults } from '../../src/lib/net-defaults.js';
import { testConfig } from '../config.js';
import {
  auditExitCode,
  classify,
  type InventoryRow,
  inventory,
  renderSummary,
} from './utils/residue-audit.ts';

applyNetworkDefaults();

// The operator env file fills in only what the real env leaves blank; CI
// passes everything through env.
const envFile = join(import.meta.dirname, '..', '.env.e2e');
const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf-8')) : {};
const env: Record<string, string | undefined> = { ...fileEnv };
for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;

const providers = [...Object.keys(testConfig.e2e.providers), 'cloudflare'];
const results = await Promise.all(
  providers.map(async (p) => {
    try {
      return await inventory(p, env);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return {
        rows: [] as InventoryRow[],
        complete: false,
        incomplete: [`${p}: ${why}`.slice(0, 200)],
        notCovered: [] as string[],
      };
    }
  }),
);

const now = Date.now();
const rows = results.flatMap((r) => r.rows).map((r) => ({ ...r, verdict: classify(r, now) }));
const incomplete = results.flatMap((r) => r.incomplete);
const notCovered = results.flatMap((r) => r.notCovered);
const summary = renderSummary(rows, incomplete, notCovered);

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(auditExitCode(rows, incomplete));
