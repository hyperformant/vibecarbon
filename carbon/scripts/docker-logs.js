#!/usr/bin/env node
/**
 * View Docker Compose logs for enabled services
 *
 * Usage:
 *   node scripts/docker-logs.js           # Follow all logs
 *   node scripts/docker-logs.js app       # Follow logs for specific service
 *   node scripts/docker-logs.js --dry-run # Show command without running
 */

import { execSync } from 'node:child_process';
import { buildComposeCommand, loadManifest, parseArgs } from './lib/manifest.js';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage: node scripts/docker-logs.js [service] [options]

Arguments:
  service     Optional service name to filter logs

Options:
  --prod      Include production overlay
  --dry-run   Print the command without executing it
  --verbose   Verbose output
  -h, --help  Show this help message

Examples:
  node scripts/docker-logs.js          # Follow all logs
  node scripts/docker-logs.js app      # Follow app service logs
  node scripts/docker-logs.js db       # Follow database logs
  npm run docker:logs                     # Via package.json script
`);
  process.exit(0);
}

const manifest = loadManifest();
const service = args.positional[0] || '';
const action = `logs -f ${service}`.trim();
const cmd = buildComposeCommand(action, manifest, { prod: args.prod });

if (args.dryRun) {
  console.log('Would run:', cmd);
  process.exit(0);
}

if (args.verbose) {
  console.log('Running:', cmd);
}

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (error) {
  // Logs can be interrupted with Ctrl+C, which is expected
  if (error.status !== 130) {
    process.exit(error.status || 1);
  }
}
