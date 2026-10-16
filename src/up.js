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
import { releaseMovedStack, resolveComposeProjectName } from './lib/compose-project-name.js';
import { devS3Endpoint, devS3Port } from './lib/dev-s3.js';
import { formatDotenvLine, parseDotenv } from './lib/dotenv.js';
import { localComposeEnv } from './lib/images.js';
import { formatStackPath, listVibecarbonStacks } from './lib/local-stacks.js';
import { reclaimOrphanPorts } from './lib/orphan.js';
import { warnAboutOrphanStacks } from './lib/orphan-stack-notice.js';
import { detectPackageManager } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import {
  deriveComposeProjectName,
  findSubnetConflict,
  listDockerNetworks,
  pickFreeSubnetPrefix,
} from './lib/subnet.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
export const SPEC = {
  name: 'up',
  summary: 'Start the local development environment',
  description: [
    'Get your entire dev environment running with one command: Docker, database,',
    'migrations, API, and Vite dev server. Your package manager is detected',
    'automatically, and port/subnet conflicts are resolved on the fly.',
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
 * Read `key` from `.env.local`, then `.env` — the first file that carries a
 * NON-EMPTY value wins, else null. Parsing is `parseDotenv` (src/lib/dotenv.js),
 * the codebase's one dotenv reader; the per-key regex this
 * replaced could not match an empty `KEY=` and so fell through to the next
 * file — treating '' as absent here keeps that exact fall-through.
 * @param {string} key
 * @param {string} cwd
 * @returns {string|null}
 */
function getEnvValue(key, cwd) {
  for (const file of ['.env.local', '.env']) {
    const filePath = join(cwd, file);
    if (!existsSync(filePath)) continue;
    const value = parseDotenv(readFileSync(filePath, 'utf-8'))[key];
    if (value) return value;
  }
  return null;
}

/**
 * Get the ports this project will use, accounting for offsets
 */
function getProjectPorts(cwd) {
  const offset = Number.parseInt(getEnvValue('DEV_PORT_OFFSET', cwd) || '0', 10);

  return [
    { name: 'Traefik', port: Number(getEnvValue('DEV_TRAEFIK_PORT', cwd)) || 80 + offset },
    { name: 'Vite', port: Number(getEnvValue('DEV_VITE_PORT', cwd)) || 5173 + offset },
    { name: 'API', port: Number(getEnvValue('DEV_API_PORT', cwd)) || 3000 + offset },
    { name: 'DB (PostgreSQL)', port: Number(getEnvValue('DEV_DB_PORT', cwd)) || 5432 + offset },
    {
      name: 'Local S3',
      port: devS3Port({
        DEV_S3_PORT: getEnvValue('DEV_S3_PORT', cwd),
        DEV_PORT_OFFSET: String(offset),
      }),
    },
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
      env: localComposeEnv(),
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
      80 + offset,
      5173 + offset,
      3000 + offset,
      5432 + offset,
      devS3Port({ DEV_PORT_OFFSET: String(offset) }),
    ];
    const results = await Promise.all(ports.map(isPortInUse));
    if (results.every((inUse) => !inUse)) return offset;
  }
  return 100; // fallback
}

/**
 * Write DEV_PORT_OFFSET to .env.local, creating the file if it doesn't exist.
 * Returns true if the value was saved.
 *
 * In-place REWRITER (like setSubnetPrefix below): each literal-key line is
 * located whole and re-emitted through formatDotenvLine (src/lib/dotenv.js),
 * so comments, blanks and order stay verbatim and no value is read out of
 * the file. Allow-listed by exact path in
 * tests/unit/lib/dotenv-dialect-census.test.ts. The match is the WHOLE
 * existing line whatever its quoting: `create` writes the bare form
 * (`DEV_PORT_OFFSET=0`) while pre-2026-09-20 files hold `"0"`. A quoted-only
 * match would append a second DEV_PORT_OFFSET line to a fresh project; every
 * reader is last-wins (util.parseEnv in the CLI and the template alike), so
 * the stale first line would be silently shadowed rather than reported.
 */
export function setPortOffset(offset, cwd) {
  const envPath = join(cwd, '.env.local');
  const existing = existsSync(envPath);
  let content = existing ? readFileSync(envPath, 'utf-8') : '';
  const line = formatDotenvLine('DEV_PORT_OFFSET', String(offset));
  const regex = /^DEV_PORT_OFFSET=.*$/m;

  if (regex.test(content)) {
    content = content.replace(regex, () => line);
  } else {
    const prefix = content.trimEnd();
    content = `${prefix ? `${prefix}\n\n` : ''}# Port offset (set by vibecarbon up to avoid conflicts)\n${line}\n`;
  }

  // Client-visible twin: vite only exposes VITE_-prefixed vars, and the admin
  // panel's service links (getServiceUrl in carbon admin-services.ts) need the
  // offset to build `traefik.localhost:<80+offset>` — without it every link
  // points at port 80, i.e. whichever OTHER project owns the default ports
  // (RCA 2026-07-17: swim2's admin panel linked into my-app's traefik).
  // Kept in lockstep with DEV_PORT_OFFSET by writing both here.
  const viteLine = formatDotenvLine('VITE_DEV_PORT_OFFSET', String(offset));
  const viteRegex = /^VITE_DEV_PORT_OFFSET=.*$/m;
  if (viteRegex.test(content)) {
    content = content.replace(viteRegex, () => viteLine);
  } else {
    content = `${content.trimEnd()}\n${viteLine}\n`;
  }

  // The local S3 port moves with the offset (docker-up.js publishes
  // DEV_S3_PORT, else 8333 + offset), so the endpoint the app and
  // ensure-dev-bucket.js dial must move with it. Only a localhost endpoint is
  // the dev Garage; a real bucket's endpoint is left alone, and an explicit
  // DEV_S3_PORT still wins inside devS3Port.
  const endpointRegex = /^S3_ENDPOINT=.*$/m;
  const endpointLine = content.match(endpointRegex)?.[0];
  const endpoint = endpointLine ? parseDotenv(endpointLine).S3_ENDPOINT : '';
  if (endpoint && isLocalhostUrl(endpoint)) {
    const next = devS3Endpoint({
      DEV_S3_PORT: getEnvValue('DEV_S3_PORT', cwd),
      DEV_PORT_OFFSET: String(offset),
    });
    content = content.replace(endpointRegex, () => formatDotenvLine('S3_ENDPOINT', next));
  }

  writeFileSync(envPath, content, { mode: 0o600 });
  return true;
}

function isLocalhostUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
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
  const line = formatDotenvLine('DEV_SUBNET_PREFIX', String(prefix));
  const regex = /^DEV_SUBNET_PREFIX=.*$/m;

  if (regex.test(content)) {
    content = content.replace(regex, () => line);
  } else {
    const body = content.trimEnd();
    content = `${body ? `${body}\n\n` : ''}# Network subnet prefix (set by vibecarbon up to avoid Docker pool overlaps)\n${line}\n`;
  }

  writeFileSync(envPath, content, { mode: 0o600 });
}

/**
 * Write COMPOSE_PROJECT_NAME to .env (NOT .env.local), same reasoning as
 * setSubnetPrefix: compose interpolates only .env, including for a bare
 * `docker compose down`. Pinning keeps the stack (and its db volume) stable
 * when the project folder is renamed.
 */
export function setComposeProjectName(name, cwd) {
  const envPath = join(cwd, '.env');
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const line = formatDotenvLine('COMPOSE_PROJECT_NAME', name);
  const regex = /^\s*(?:export\s+)?COMPOSE_PROJECT_NAME\s*=.*$/m;

  if (regex.test(content)) {
    content = content.replace(regex, () => line);
  } else {
    const body = content.trimEnd();
    content = `${body ? `${body}\n\n` : ''}# Local Docker stack name (pinned by vibecarbon up so renaming the folder keeps your data)\n${line}\n`;
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
    p.log.info(`Run ${c.info('vibecarbon create <project-name>')} to create a new project.`);
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

  // Pin the compose project name so renaming this folder keeps its database,
  // adopt a stack whose folder moved, and refuse to hijack a copy's stack.
  // The pin is read from .env only: compose interpolates nothing else.
  const envFile = join(cwd, '.env');
  const pinned = existsSync(envFile)
    ? parseDotenv(readFileSync(envFile, 'utf-8')).COMPOSE_PROJECT_NAME || null
    : null;
  const projectName = getEnvValue('PROJECT_NAME', cwd);
  const stacks = listVibecarbonStacks();
  const resolved = resolveComposeProjectName({
    cwd,
    projectName,
    pinned,
    stacks,
  });
  if (resolved.action === 'refuse') {
    p.log.error(`${projectName} already has a local stack from ${formatStackPath(resolved.from)}`);
    p.log.info(
      'if this folder is a copy, give it its own PROJECT_NAME in .env and .env.local, or run `vibecarbon down` in the other folder first',
    );
    process.exit(1);
  }
  if (resolved.action === 'adopt') {
    p.log.info(
      `this project moved from ${formatStackPath(resolved.from)}, so vibecarbon is reusing its local database`,
    );
  }
  if (resolved.action === 'pin' || resolved.action === 'adopt') {
    setComposeProjectName(resolved.name, cwd);
  }
  if (resolved.action === 'adopt' && !releaseMovedStack(resolved.name, { cwd })) {
    p.log.warn(
      'could not stop the old containers, so they may keep pointing at the previous folder',
    );
  }
  process.env.COMPOSE_PROJECT_NAME = resolved.name;
  // dev:start recreates the resolved stack, so it is never an orphan of itself.
  warnAboutOrphanStacks({ exclude: [resolved.name], list: () => stacks });

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
    env: gitSafeEnv(localComposeEnv()),
  });

  waitForDevTree(child);
}

/**
 * Hand the terminal to the dev-server tree and exit only after it has.
 *
 * cli.js installs a global SIGINT handler that exits at once — right for a
 * CLI stuck in a retry loop, wrong here. `up` is the shell's foreground job,
 * so the prompt returns the moment it exits, while dev.js underneath is
 * still shutting the API down. Its last log lines then print over the
 * prompt (tsx's spinner even clears the line), which reads as a hang and
 * invites a second Ctrl+C. The tty already delivers Ctrl+C to the whole
 * foreground group, so the child sees it without our help; all we must do is
 * stay alive until it has finished. SIGTERM is different: it comes from a
 * `kill`, reaches only us, and has to be forwarded.
 *
 * `graceMs` bounds the wait after a signal so a wedged tree cannot hold the
 * terminal hostage (dev.js force-kills its own children after 5s, so a
 * healthy tree is long gone by then).
 */
export function waitForDevTree(child, { exit = process.exit, graceMs = 10_000 } = {}) {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  let giveUp;
  const boundTheWait = () => {
    giveUp ??= setTimeout(() => exit(130), graceMs);
  };
  process.on('SIGINT', boundTheWait);
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
    boundTheWait();
  });

  child.on('close', (code) => {
    clearTimeout(giveUp);
    exit(code ?? 0);
  });
}
