/**
 * vibecarbon up
 *
 * Wrapper around `<pm> dev:start` that auto-detects the project's package manager.
 * Detects port conflicts and automatically applies a port offset before starting.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import * as p from '@clack/prompts';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { c } from './lib/colors.js';
import { gitSafeEnv, runCommandThroughTaskLog } from './lib/command.js';
import { reclaimOrphanPorts } from './lib/orphan.js';
import { detectPackageManager } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import {
  deriveComposeProjectName,
  findSubnetConflict,
  listDockerNetworks,
  pickFreeSubnetPrefix,
} from './lib/subnet.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
const SPEC = {
  name: 'up',
  summary: 'Start the local development environment',
  description: [
    "Detects the project's package manager and runs the dev:start script,",
    'which boots Docker services, runs database migrations, and starts the',
    'API and Vite dev servers. If ports are already in use, a port offset',
    'is applied automatically.',
    '',
    // Lock files are listed in the order detectPackageManager (src/lib/
    // project.js) actually probes them, which is NOT the npm-first order the
    // rest of this help implies. It matters in a project carrying more than
    // one lock file: pnpm-lock.yaml wins over package-lock.json there.
    'Package manager detection order:',
    '  1. Lock file (pnpm-lock.yaml, bun.lock, package-lock.json)',
    '  2. package.json `packageManager` field',
    '  3. Falls back to npm',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
  ],
};

/**
 * Read a value from .env.local
 */
function getEnvValue(key, cwd) {
  for (const file of ['.env.local', '.env']) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const match = content.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?`, 'm'));
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Get the ports this project will use, accounting for offsets
 */
function getProjectPorts(cwd) {
  const offset = Number.parseInt(getEnvValue('DEV_PORT_OFFSET', cwd) || '0', 10);

  return [
    {
      name: 'Kong (Supabase API)',
      port: Number(getEnvValue('DEV_KONG_PORT', cwd)) || 8000 + offset,
    },
    {
      name: 'Kong SSL',
      port: Number(getEnvValue('DEV_KONG_SSL_PORT', cwd)) || 8443 + offset,
    },
    { name: 'Traefik', port: Number(getEnvValue('DEV_TRAEFIK_PORT', cwd)) || 80 + offset },
    { name: 'Vite', port: Number(getEnvValue('DEV_VITE_PORT', cwd)) || 5173 + offset },
    { name: 'API', port: Number(getEnvValue('DEV_API_PORT', cwd)) || 3000 + offset },
    { name: 'DB (PostgreSQL)', port: Number(getEnvValue('DEV_DB_PORT', cwd)) || 5432 + offset },
  ];
}

/**
 * Check if a port is in use by attempting to bind to it
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Get host ports bound by this project's running Docker containers.
 * Returns a Set of port numbers.
 */
function getOwnDockerPorts(cwd) {
  try {
    const output = execFileSync('docker', ['compose', 'ps', '--format', 'json'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ports = new Set();
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      try {
        const container = JSON.parse(line);
        // Publishers is an array of { URL, TargetPort, PublishedPort, Protocol }
        if (Array.isArray(container.Publishers)) {
          for (const pub of container.Publishers) {
            if (pub.PublishedPort) ports.add(pub.PublishedPort);
          }
        }
      } catch {
        // skip non-JSON lines
      }
    }
    return ports;
  } catch {
    return new Set();
  }
}

/**
 * Find the lowest offset (in increments of 100) where no ports conflict
 */
async function findFreeOffset(_cwd) {
  for (let offset = 100; offset <= 500; offset += 100) {
    const ports = [
      8000 + offset,
      8443 + offset,
      80 + offset,
      5173 + offset,
      3000 + offset,
      5432 + offset,
    ];
    const results = await Promise.all(ports.map(isPortInUse));
    if (results.every((inUse) => !inUse)) return offset;
  }
  return 100; // fallback
}

/**
 * Write DEV_PORT_OFFSET to .env.local, creating the file if it doesn't exist.
 * Returns true if the value was saved.
 */
export function setPortOffset(offset, cwd) {
  const envPath = join(cwd, '.env.local');
  const existing = existsSync(envPath);
  let content = existing ? readFileSync(envPath, 'utf-8') : '';
  const regex = /^DEV_PORT_OFFSET="[^"]*"/m;

  if (regex.test(content)) {
    content = content.replace(regex, `DEV_PORT_OFFSET="${offset}"`);
  } else {
    const prefix = content.trimEnd();
    content = `${prefix ? `${prefix}\n\n` : ''}# Port offset (set by vibecarbon up to avoid conflicts)\nDEV_PORT_OFFSET="${offset}"\n`;
  }

  // Client-visible twin: vite only exposes VITE_-prefixed vars, and the admin
  // panel's service links (getServiceUrl in carbon admin-services.ts) need the
  // offset to build `studio.localhost:<80+offset>` — without it every link
  // points at port 80, i.e. whichever OTHER project owns the default ports
  // (RCA 2026-07-17: swim2's admin panel linked into my-app's traefik).
  // Kept in lockstep with DEV_PORT_OFFSET by writing both here.
  const viteRegex = /^VITE_DEV_PORT_OFFSET="[^"]*"/m;
  if (viteRegex.test(content)) {
    content = content.replace(viteRegex, `VITE_DEV_PORT_OFFSET="${offset}"`);
  } else {
    content = `${content.trimEnd()}\nVITE_DEV_PORT_OFFSET="${offset}"\n`;
  }

  writeFileSync(envPath, content, { mode: 0o600 });
  return true;
}

/**
 * Write DEV_SUBNET_PREFIX to .env (NOT .env.local): docker compose
 * interpolates .env on every invocation — including bare `docker compose
 * down` — while .env.local is only merged in by our wrapper scripts. Writing
 * anywhere else would let overlay subsets resolve a different subnet and
 * recreate the live network mid-op.
 */
function setSubnetPrefix(prefix, cwd) {
  const envPath = join(cwd, '.env');
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const regex = /^DEV_SUBNET_PREFIX=.*$/m;

  if (regex.test(content)) {
    content = content.replace(regex, `DEV_SUBNET_PREFIX="${prefix}"`);
  } else {
    const body = content.trimEnd();
    content = `${body ? `${body}\n\n` : ''}# Network subnet prefix (set by vibecarbon up to avoid Docker pool overlaps)\nDEV_SUBNET_PREFIX="${prefix}"\n`;
  }

  writeFileSync(envPath, content, { mode: 0o600 });
}

/** True if the Docker daemon answers `docker info`. */
function dockerInfoOk() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail fast with a clear message if Docker isn't reachable. `up` boots the
 * local compose stack, so without this a first-timer without a running daemon
 * gets a raw socket error instead of guidance.
 *
 * @param {{ probe?: () => boolean }} [deps] - probe returns true when Docker is up; injectable for testing
 */
export function assertDockerRunning({ probe = dockerInfoOk } = {}) {
  if (!probe()) {
    p.log.error(
      'Docker is not available. Start Docker (Docker Desktop, or `sudo systemctl start docker`) and try again.',
    );
    p.log.info('If Docker is not installed, see https://docs.docker.com/get-docker/');
    process.exit(1);
  }
}

export async function run(args = []) {
  const { handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs first so an accidental `vibecarbon up` from a
  // parent directory fails with the canonical "not in a Vibecarbon
  // project" message instead of a confusing package.json error.
  assertInProjectDir();

  introCommand('up');

  const cwd = process.cwd();
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (!pkg.scripts?.['dev:start']) {
    p.log.error('No "dev:start" script found in package.json.');
    p.log.info(`Run ${c.info('vibecarbon create <name>')} to create a new project.`);
    process.exit(1);
  }

  // Verify env files exist — blank vars cause cryptic Docker failures
  const hasEnv = existsSync(join(cwd, '.env')) || existsSync(join(cwd, '.env.local'));
  if (!hasEnv) {
    const initPm = detectPackageManager(cwd);
    const initRun = initPm === 'pnpm' ? 'pnpm' : `${initPm} run`;
    p.log.error(
      `No .env file found. Run \`${initRun} dev:init\` to generate dev environment files.`,
    );
    process.exit(1);
  }

  // Docker must be running before any of the port/subnet probes (which call
  // docker) or dev:start — otherwise the user gets a raw daemon-socket error.
  assertDockerRunning();

  // Check for port conflicts (excluding ports already bound by this project's containers)
  const ports = getProjectPorts(cwd);
  const ownPorts = getOwnDockerPorts(cwd);
  const conflicts = [];
  for (const { name, port } of ports) {
    if ((await isPortInUse(port)) && !ownPorts.has(port)) {
      conflicts.push({ name, port });
    }
  }

  if (conflicts.length > 0) {
    // First reclaim any ports held by THIS project's own orphaned dev session
    // (a previous `dev.js` tree that outlived its parent and kept squatting on
    // the ports). Killing the orphan lets us reuse the normal port band; only
    // genuinely foreign conflicts fall through to offset-bumping.
    const { remaining } = await reclaimOrphanPorts(conflicts, cwd, {
      recheck: isPortInUse,
      onReclaim: ({ name, port }, { killed }) =>
        p.log.success(
          `Reclaimed ${name} port ${c.bold(String(port))} from orphaned dev session (PID ${killed.join(', ')})`,
        ),
    });

    if (remaining.length > 0) {
      p.log.warn('Port conflicts detected (not owned by this project):');
      for (const { name, port } of remaining) {
        p.log.message(`  ${c.dim(name.padEnd(20))} port ${c.bold(String(port))} is in use`);
      }

      const offset = await findFreeOffset(cwd);
      setPortOffset(offset, cwd);
      p.log.success(`Applied DEV_PORT_OFFSET=${offset} to .env.local`);
    }
  }

  // Network subnet conflicts, the sibling of the port check above: every
  // project pins vibecarbon-network to ${DEV_SUBNET_PREFIX:-172.30.0}.0/24
  // (see the generated docker-compose.yml), so the second project on one
  // Docker daemon needs its own /24 or network creation fails with "Pool
  // overlaps with other one on this address space". The project's OWN
  // network never counts as a conflict — compose reuses it in place.
  const networks = listDockerNetworks();
  if (networks) {
    const ownProject =
      process.env.COMPOSE_PROJECT_NAME ||
      getEnvValue('COMPOSE_PROJECT_NAME', cwd) ||
      deriveComposeProjectName(basename(cwd));
    const prefix = getEnvValue('DEV_SUBNET_PREFIX', cwd) || '172.30.0';
    const conflict = findSubnetConflict(prefix, networks, ownProject);
    if (conflict) {
      p.log.warn(
        `Network subnet conflict: ${c.bold(`${prefix}.0/24`)} is held by ${c.bold(conflict.name)}`,
      );
      const freePrefix = pickFreeSubnetPrefix(networks, ownProject);
      if (!freePrefix) {
        p.log.error(
          'No free /24 left in 172.30.0.0/16. Set DEV_SUBNET_PREFIX in .env to a prefix outside that range (e.g. "172.31.0").',
        );
        process.exit(1);
      }
      setSubnetPrefix(freePrefix, cwd);
      p.log.success(`Applied DEV_SUBNET_PREFIX=${freePrefix} to .env`);
    }
  }

  const pm = detectPackageManager(cwd);

  // Auto-install deps on first `up` — `vibecarbon create` intentionally skips
  // install (shaves ~30s off create under parallel load) so node_modules may
  // not exist yet. We detect and run the install once; subsequent `up` calls
  // see node_modules and skip straight to dev:start.
  if (!existsSync(join(cwd, 'node_modules'))) {
    const installArgs =
      pm === 'npm' ? ['install'] : pm === 'bun' ? ['install'] : ['install', '--no-frozen-lockfile'];
    try {
      await runCommandThroughTaskLog([pm, ...installArgs], {
        cwd,
        title: `Installing dependencies with ${pm} (first run)`,
        successMessage: 'Dependencies installed',
        // `up` is routinely reached through a wrapper package manager, whose
        // injected npm_config_* would otherwise reach this install — see
        // PM_RUN_CONTEXT_RE in lib/command.js.
        cleanEnv: true,
      });
    } catch (err) {
      p.log.error(`Install failed. Run \`${pm} install\` manually to retry.`);
      process.exit(err?.status ?? 1);
    }
  }

  p.log.info(`Starting dev environment with ${c.bold(pm)}...`);

  const spawnArgs = pm === 'npm' ? ['run', 'dev:start'] : ['dev:start'];
  const child = spawn(pm, spawnArgs, {
    cwd,
    stdio: 'inherit',
    // Same scrub as the install above — `up` reached through a wrapper package
    // manager hands the wrapper's npm_config_* dialect to this npm, which npm
    // 12 flags with `npm warn Unknown env config` on every run. Raw spawn has
    // no cleanEnv option; gitSafeEnv() is the exported form of that scrub.
    env: gitSafeEnv(),
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}
