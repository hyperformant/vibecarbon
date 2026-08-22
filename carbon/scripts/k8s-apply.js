#!/usr/bin/env node
/**
 * Apply Kubernetes manifests using Kustomize
 *
 * Usage:
 *   node scripts/k8s-apply.js                    # Apply local overlay
 *   node scripts/k8s-apply.js production-nbg1    # Apply specific overlay
 *   node scripts/k8s-apply.js --dry-run          # Show what would be applied
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, getEnabledFeatures, parseArgs } from './lib/manifest.js';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage: node scripts/k8s-apply.js [overlay] [options]

Arguments:
  overlay     Kustomize overlay to apply (default: local)
              Available: local, production-nbg1, production-hel1

Options:
  --dry-run   Show what would be applied without executing
  --verbose   Verbose output
  -h, --help  Show this help message

Examples:
  node scripts/k8s-apply.js              # Apply local overlay
  node scripts/k8s-apply.js production-nbg1  # Apply production overlay
  npm run k8s:apply                         # Via package.json script
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

// Build the kubectl apply command
const dryRunFlag = args.dryRun ? ' --dry-run=client' : '';
const cmd = `kubectl apply -k ${overlayPath}${dryRunFlag}`;

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
  process.exit(error.status || 1);
}
