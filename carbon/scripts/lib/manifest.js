/**
 * Shared manifest utilities for Vibecarbon scripts
 * Reads .vibecarbon.json to determine which services are enabled
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load the vibecarbon manifest from the current directory
 * @returns {Object} The manifest object with version and services
 */
export function loadManifest() {
  const path = join(process.cwd(), '.vibecarbon.json');
  if (!existsSync(path)) {
    return { version: '1', services: {} };
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Get list of enabled service names from manifest
 * Supports both "services" (new) and "features" (legacy) keys
 * @param {Object} manifest - The vibecarbon manifest
 * @returns {string[]} Array of service names
 */
export function getEnabledServices(manifest) {
  // Support both "services" (new) and "features" (legacy)
  const services = manifest.services || manifest.features || {};
  return Object.keys(services);
}

/**
 * Discover all optional service compose files in the project directory
 * Excludes core files (prod, override, ha-*) and service-specific overrides
 * @returns {string[]} Array of optional service compose file names
 */
export function discoverOptionalServices() {
  const cwd = process.cwd();
  const corePatterns = [
    'docker-compose.yml',
    'docker-compose.prod.yml',
    'docker-compose.override.yml',
    /^docker-compose\.ha-.*\.yml$/,
    /^docker-compose\..*\.override\.yml$/, // Service-specific overrides (handled separately)
    /^docker-compose\..*\.prod\.yml$/, // Service-specific prod configs (use --prod flag)
  ];

  const files = readdirSync(cwd).filter((file) => {
    if (!file.startsWith('docker-compose.') || !file.endsWith('.yml')) {
      return false;
    }
    // Exclude core patterns
    for (const pattern of corePatterns) {
      if (typeof pattern === 'string' && file === pattern) return false;
      if (pattern instanceof RegExp && pattern.test(file)) return false;
    }
    return true;
  });

  return files;
}

/**
 * Get list of Docker Compose files to use based on enabled services
 * @param {Object} manifest - The vibecarbon manifest
 * @param {Object} options - Options for file selection
 * @param {boolean} options.prod - Include production overlay
 * @param {boolean} options.all - Include all optional services (ignores manifest)
 * @returns {string[]} Array of compose file paths
 */
export function getComposeFiles(manifest, options = {}) {
  const files = ['docker-compose.yml'];
  const cwd = process.cwd();

  if (options.prod) {
    files.push('docker-compose.prod.yml');
  }

  // Collect service files (either from --all discovery or manifest)
  let serviceFiles = [];
  if (options.all) {
    serviceFiles = discoverOptionalServices();
  } else {
    for (const service of getEnabledServices(manifest)) {
      const serviceFile = `docker-compose.${service}.yml`;
      if (existsSync(join(cwd, serviceFile))) {
        serviceFiles.push(serviceFile);
      }
    }
  }

  // Add each service file, followed by its environment-specific override
  for (const serviceFile of serviceFiles) {
    files.push(serviceFile);

    if (options.prod) {
      // In prod mode, check for service-specific prod file
      // e.g., docker-compose.observability.yml -> docker-compose.observability.prod.yml
      const prodFile = serviceFile.replace('.yml', '.prod.yml');
      if (existsSync(join(cwd, prodFile))) {
        files.push(prodFile);
      }
    } else {
      // In dev mode, check for service-specific override file
      // e.g., docker-compose.observability.yml -> docker-compose.observability.override.yml
      const overrideFile = serviceFile.replace('.yml', '.override.yml');
      if (existsSync(join(cwd, overrideFile))) {
        files.push(overrideFile);
      }
    }
  }

  // In dev mode, include the main override file LAST so it can override
  // service-specific compose files with dev passwords/config
  if (!options.prod && existsSync(join(cwd, 'docker-compose.override.yml'))) {
    files.push('docker-compose.override.yml');
  }

  // dev-init.js generates this file to mount the admin SQL with real credentials
  // (only exists when developing the CLI itself, not in derived projects)
  if (!options.prod && existsSync(join(cwd, 'docker-compose.dev-init.yml'))) {
    files.push('docker-compose.dev-init.yml');
  }

  return files;
}

/**
 * Check if a specific service is enabled
 * @param {Object} manifest - The vibecarbon manifest
 * @param {string} serviceName - Name of the service to check
 * @returns {boolean} True if service is enabled
 */
export function isServiceEnabled(manifest, serviceName) {
  const services = manifest.services || manifest.features || {};
  return Boolean(services[serviceName]);
}

/**
 * Build docker compose command with appropriate files
 * @param {string} action - The compose action (up, down, logs, etc.)
 * @param {Object} manifest - The vibecarbon manifest
 * @param {Object} options - Options for command building
 * @param {boolean} options.prod - Use production config
 * @param {boolean} options.all - Include all optional services
 * @param {string[]} options.extraArgs - Additional arguments
 * @returns {string} The full docker compose command
 */
export function buildComposeCommand(action, manifest, options = {}) {
  const files = getComposeFiles(manifest, { prod: options.prod, all: options.all });
  const fileArgs = files.map((f) => `-f ${f}`).join(' ');
  const extraArgs = options.extraArgs ? options.extraArgs.join(' ') : '';

  return `docker compose ${fileArgs} ${action} ${extraArgs}`.trim();
}

/**
 * Parse CLI arguments for common flags
 * @param {string[]} args - CLI arguments
 * @returns {Object} Parsed arguments
 */
export function parseArgs(args) {
  return {
    prod: args.includes('--prod'),
    all: args.includes('--all'),
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose') || args.includes('-v'),
    help: args.includes('--help') || args.includes('-h'),
    positional: args.filter((arg) => !arg.startsWith('-')),
  };
}

// Legacy aliases for backwards compatibility
export const getEnabledFeatures = getEnabledServices;
export const isFeatureEnabled = isServiceEnabled;
