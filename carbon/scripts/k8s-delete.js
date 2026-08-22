#!/usr/bin/env node
/**
 * Delete Kubernetes manifests using Kustomize
 *
 * Usage:
 *   node scripts/k8s-delete.js                    # Delete local overlay
 *   node scripts/k8s-delete.js production-nbg1    # Delete specific overlay
 *   node scripts/k8s-delete.js --dry-run          # Show what would be deleted
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, getEnabledFeatures, parseArgs } from './lib/manifest.js';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage: node scripts/k8s-delete.js [overlay] [options]

Arguments:
  overlay     Kustomize overlay to delete (default: local)
              Available: local, production-nbg1, production-hel1

Options:
  --dry-run   Show what would be deleted without executing
  --verbose   Verbose output
  -h, --help  Show this help message

Examples:
  node scripts/k8s-delete.js              # Delete local overlay
  node scripts/k8s-delete.js production-nbg1  # Delete production overlay
  npm run k8s:delete                         # Via package.json script
`);
  process.exit(0);
}

const manifest = loadManifest();
const overlay = args.positional[0] || 'local';
const overlayPath = join(process.cwd(), 'k8s', 'overlays', overlay);

if (!existsSync(overlayPath)) {
  console.error(`Error: Overlay '${overlay}' not found at ${overlayPath}`);
  console.error('Available overlays: local, production-nbg1, production-hel1');
  process.exit(1);
}

const features = getEnabledFeatures(manifest);
if (args.verbose && features.length > 0) {
  console.log('Enabled features:', features.join(', '));
}

// Build the kubectl delete command
const dryRunFlag = args.dryRun ? ' --dry-run=client' : '';
const cmd = `kubectl delete -k ${overlayPath}${dryRunFlag}`;

if (args.dryRun) {
  console.log('Would run:', cmd);
  console.log('\nDry run output:');
}

if (args.verbose) {
  console.log('Running:', cmd);
}

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (error) {
  // Exit code 1 from kubectl delete is common (resources not found), don't fail hard
  if (args.verbose) {
    console.log('kubectl delete exited with code:', error.status);
  }
  process.exit(error.status || 1);
}
