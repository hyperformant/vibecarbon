#!/usr/bin/env node
/**
 * Stop Docker Compose services based on enabled features
 *
 * Usage:
 *   node scripts/docker-down.js           # Stop services
 *   node scripts/docker-down.js -v        # Stop and remove volumes
 *   node scripts/docker-down.js --dry-run # Show command without running
 */

import { execSync } from 'node:child_process';
import { buildComposeCommand, loadManifest, parseArgs } from './lib/manifest.js';

const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs);

// Check for -v flag (volumes) - different from --verbose
const removeVolumes = rawArgs.includes('-v') && !rawArgs.includes('--verbose');
const removeImages = rawArgs.includes('--rmi');

if (args.help) {
  console.log(`
Usage: node scripts/docker-down.js [options]

Options:
  --all       Include all optional services (ignores .vibecarbon.json)
  -v          Remove volumes (docker compose down -v)
  --prod      Include production overlay
  --rmi       Remove locally-built images (docker compose down --rmi local)
  --dry-run   Print the command without executing it
  --verbose   Verbose output
  -h, --help  Show this help message

Examples:
  node scripts/docker-down.js        # Stop services from .vibecarbon.json
  node scripts/docker-down.js --all  # Stop ALL services
  node scripts/docker-down.js -v     # Stop and remove volumes
  node scripts/docker-down.js -v --rmi  # Stop, remove volumes and built images
  npm run docker:down                   # Via package.json script
`);
  process.exit(0);
}

const manifest = loadManifest();
let action = 'down';
if (removeVolumes) action += ' -v';
if (removeImages) action += ' --rmi local';
const cmd = buildComposeCommand(action, manifest, { prod: args.prod, all: args.all });

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
  process.exit(error.status || 1);
}
