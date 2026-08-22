/**
 * Vibecarbon Remove Command
 *
 * Mirrors `add`: interactive-by-default, single-dash flags, variadic
 * positional. Bare `vibecarbon remove` prompts for which feature to
 * remove. Service data (volumes, databases) is preserved — only
 * deployment configs (Docker / k8s manifests) get removed.
 *
 * Form rule: vibecarbon uses single-dash flags only — see
 * memory:feedback_cli_single_dash_flags.
 */

import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import {
  fetchServiceManifest,
  loadManifest,
  removeFromBaseKustomization,
  saveManifest,
} from './add.js';
import { exitCancelled } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { runCommand } from './lib/command.js';
import { assertInProjectDir } from './lib/project-guard.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'remove',
  summary: 'Remove a feature from a Vibecarbon project',
  positional: [
    {
      name: 'features',
      variadic: true,
      optional: true,
      description: 'One or more features to remove (skips the prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
    { name: 'force', boolean: true, description: 'Skip confirmation prompt (alias for -y)' },
    {
      name: 'online',
      boolean: true,
      description: 'Fetch the latest service definitions from GitHub instead of the packaged copy',
    },
  ],
  examples: [
    { command: 'vibecarbon remove', description: 'prompts for a feature to remove' },
    { command: 'vibecarbon remove redis', description: 'remove a specific feature' },
    { command: 'vibecarbon remove redis -force', description: 'remove without confirmation' },
  ],
};

// ============================================================================
// FILE REMOVAL
// ============================================================================

function removeFile(filePath) {
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function removeDirectory(dirPath) {
  if (existsSync(dirPath)) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// ============================================================================
// REMOVE SERVICE
// ============================================================================

async function removeService(serviceName, options) {
  const { force } = options;
  // Default to the packaged service definitions (mirrors `add`); `-online`
  // opts into fetching the latest from GitHub.
  const offline = !options.online;

  const projectManifest = loadManifest();

  // Check if service is installed
  if (!projectManifest.services?.[serviceName]) {
    p.log.warn(`Service "${serviceName}" is not installed in this project.`);
    return false;
  }

  // Fetch service manifest to know what files to remove
  let serviceManifest;
  try {
    serviceManifest = await fetchServiceManifest(serviceName, offline);
  } catch (error) {
    // If we can't fetch the manifest, try to remove based on conventions
    p.log.warn(`Could not fetch service manifest: ${error.message}`);
    p.log.info('Attempting removal based on conventions...');
    serviceManifest = {
      name: serviceName,
      files: {
        'compose/docker-compose.yml': `docker-compose.${serviceName}.yml`,
        'k8s/': `k8s/base/${serviceName}/`,
      },
      kustomization: { entry: `${serviceName}/` },
    };
  }

  // Confirm removal
  if (!force) {
    const confirm = await p.confirm({
      message: `Remove ${serviceManifest.name} from this project?`,
      initialValue: false,
    });

    if (!confirm) {
      p.log.info('Removal cancelled.');
      return false;
    }
  }

  const s = spinner();
  s.start(`Removing ${serviceManifest.name}...`);

  // Try to stop the service's containers first
  const composeFile = `docker-compose.${serviceName}.yml`;
  if (existsSync(join(process.cwd(), composeFile))) {
    runCommand(
      ['docker', 'compose', '-f', 'docker-compose.yml', '-f', composeFile, 'stop', serviceName],
      {
        stdio: 'ignore',
        ignoreError: true,
      },
    );
  }

  // Remove files based on manifest mappings
  for (const [src, dest] of Object.entries(serviceManifest.files || {})) {
    const fullPath = join(process.cwd(), dest);
    if (src.endsWith('/')) {
      // Directory
      removeDirectory(fullPath);
    } else {
      // File
      removeFile(fullPath);
    }
  }

  // Remove from kustomization.yaml
  if (serviceManifest.kustomization?.entry) {
    removeFromBaseKustomization(serviceManifest.kustomization.entry);
  }

  // Update project manifest
  delete projectManifest.services[serviceName];
  saveManifest(projectManifest);

  s.stop(`${serviceManifest.name} removed successfully`);

  p.note(
    [
      `- All ${serviceManifest.name} deployment configs have been removed`,
      `- Service data (volumes, database) was NOT deleted`,
      `- To fully remove data: docker volume rm <project>-${serviceName}_data`,
    ].join('\n'),
    'Cleanup Notes',
  );

  return true;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(cliArgs) {
  const { values, positional, handled } = parseFlagsOrExit(cliArgs, SPEC);
  if (handled) return;

  // Detect project
  const projectConfig = assertInProjectDir();

  // Resolve which services to remove. Positional list wins; otherwise
  // prompt on TTY, fail off-TTY with the canonical message.
  /** @type {string[]} */
  const seedServices = /** @type {string[]|undefined} */ (positional.features || []).map((s) =>
    s.toLowerCase(),
  );

  if (seedServices.length === 0) {
    requireTTYOrFlags({
      requirements: [
        {
          flag: 'features',
          description: 'name a feature to remove',
          satisfied: false,
        },
      ],
    });
  }

  introCommand('remove');

  /** @type {string[]} */
  let services = seedServices;
  if (services.length === 0) {
    // Pick from features actually present in this project's manifest.
    const installed = Object.keys(projectConfig?.services || {});
    if (installed.length === 0) {
      p.log.error('No features installed in this project.');
      p.log.info(`Add one with ${c.info('vibecarbon add <feature>')}.`);
      process.exit(1);
    }
    const choice = await p.select({
      message: 'Which feature do you want to remove?',
      options: installed.map((name) => ({ value: name, label: name })),
    });
    if (p.isCancel(choice)) {
      exitCancelled();
    }
    services = [/** @type {string} */ (choice)];
  }

  // -y and -force are synonymous: both skip the confirmation prompt.
  const force = !!values.y || !!values.force;

  let success = true;
  for (const serviceName of services) {
    const result = await removeService(serviceName, {
      force,
      online: !!values.online,
    });
    if (!result) {
      success = false;
    }
  }

  if (success) {
    p.note(
      ['# Restart services to apply changes:', 'vibecarbon down && vibecarbon up'].join('\n'),
      'Next steps',
    );
    p.outro('Services removed successfully!');
  } else {
    p.outro('Some services could not be removed.');
    process.exit(1);
  }
}

export async function run(args) {
  await main(args);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export { SPEC };
