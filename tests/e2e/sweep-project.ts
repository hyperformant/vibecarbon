/**
 * Sweep leaked Hetzner resources for SPECIFIC e2e scratch project names via
 * the runner's own project-scoped sweep (scenarios/_run-lifecycle.ts). This
 * is the sanctioned cleanup for testapp-* projects whose destroy already ran
 * but left raw out-of-state resources (the destroy's orphan handling is
 * stack-based and cannot see them; the account-wide sweep script is
 * deliberately not used here — this targets only the named projects).
 *
 * Usage: REAL_INFRA=true tsx tests/e2e/sweep-project.ts <projectName>...
 * Token: HETZNER_API_TOKEN from env or tests/.env.e2e (same lookup the
 * runner uses).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from '../../src/lib/dotenv.js';
import { sweepOrphanedHetznerResources } from './scenarios/_run-lifecycle.ts';
import { sweepOrphanedDigitalOceanResources } from './utils/sweep-digitalocean.ts';
import { sweepOrphanedLinodeResources } from './utils/sweep-linode.ts';
import { sweepOrphanedScalewayResources } from './utils/sweep-scaleway.ts';
import { sweepOrphanedVultrResources } from './utils/sweep-vultr.ts';

const names = process.argv.slice(2).filter((n) => n.startsWith('testapp-'));
if (names.length === 0) {
  console.error('usage: tsx tests/e2e/sweep-project.ts <testapp-...> [more...]');
  process.exit(2);
}

// Read the operator env file (same set the runner exports) so the sweep's
// S3 half can enumerate buckets too — with only the Hetzner token it
// silently skips S3 ("No S3 credentials") and a leaked bucket survives.
// Real env wins: every read below checks process.env first (a blank export
// counts as unset, as before) and falls back to this file, never the other way around.
const envFile = join(import.meta.dirname, '..', '.env.e2e');
const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf-8')) : {};
const token = process.env.HETZNER_API_TOKEN || fileEnv.HETZNER_API_TOKEN;
if (!token) {
  console.error('HETZNER_API_TOKEN not found in env or tests/.env.e2e');
  process.exit(2);
}

for (const name of names) {
  const { counts } = await sweepOrphanedHetznerResources('[sweep-project]', name, token);
  console.log(`${name} (hetzner): ${JSON.stringify(counts)}`);
  // DO half runs only when the operator env carries a DO token — the same
  // opt-in shape as the d1/d2/d3 scenarios themselves.
  const digitaloceanToken = process.env.DIGITALOCEAN_API_TOKEN || fileEnv.DIGITALOCEAN_API_TOKEN;
  if (digitaloceanToken) {
    const { counts: doCounts } = await sweepOrphanedDigitalOceanResources('[sweep-project]', name, {
      token: digitaloceanToken,
    });
    console.log(`${name} (digitalocean): ${JSON.stringify(doCounts)}`);
  }
  // Linode half — same token-gated opt-in shape as the DO half above.
  const linodeToken = process.env.LINODE_API_TOKEN || fileEnv.LINODE_API_TOKEN;
  if (linodeToken) {
    const { counts: linodeCounts } = await sweepOrphanedLinodeResources('[sweep-project]', name, {
      token: linodeToken,
    });
    console.log(`${name} (linode): ${JSON.stringify(linodeCounts)}`);
  }
  // Vultr half — same token-gated opt-in shape. The storage region rides
  // along because Vultr's object-storage keys are per-subscription (one
  // subscription = one cluster); without it the bucket half self-reports
  // incomplete rather than probing a cluster the keys can't authenticate to.
  const vultrToken = process.env.VULTR_API_TOKEN || fileEnv.VULTR_API_TOKEN;
  if (vultrToken) {
    const { counts: vultrCounts } = await sweepOrphanedVultrResources('[sweep-project]', name, {
      token: vultrToken,
      storageRegion: process.env.VULTR_STORAGE_REGION || fileEnv.VULTR_STORAGE_REGION,
    });
    console.log(`${name} (vultr): ${JSON.stringify(vultrCounts)}`);
  }
  // Scaleway half — same token-gated opt-in shape. The access key rides
  // along for the bucket half (the SAME IAM pair signs S3); the project id
  // scopes the IAM ssh-key walk to the dedicated Project.
  const scalewayToken = process.env.SCALEWAY_SECRET_KEY || fileEnv.SCALEWAY_SECRET_KEY;
  if (scalewayToken) {
    const { counts: scalewayCounts } = await sweepOrphanedScalewayResources(
      '[sweep-project]',
      name,
      {
        token: scalewayToken,
        storageKey: process.env.SCALEWAY_ACCESS_KEY || fileEnv.SCALEWAY_ACCESS_KEY,
        projectId: process.env.SCALEWAY_DEFAULT_PROJECT_ID || fileEnv.SCALEWAY_DEFAULT_PROJECT_ID,
      },
    );
    console.log(`${name} (scaleway): ${JSON.stringify(scalewayCounts)}`);
  }
}
