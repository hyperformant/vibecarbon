#!/usr/bin/env node
/**
 * Development server script with proper signal handling.
 * Spawns both the API server (tsx watch) and Vite dev server,
 * and ensures clean shutdown on Ctrl+C.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const isWindows = process.platform === 'win32';

// Read project name from package.json
let projectName = 'your app';
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  projectName = pkg.name || projectName;
} catch {
  // Ignore errors, use default
}

// Read port configuration from .env.local
function getPortConfig() {
  const defaults = { vite: 5173, api: 3000 };
  try {
    const envFiles = ['.env.local', '.env'];
    for (const file of envFiles) {
      if (existsSync(file)) {
        const content = readFileSync(file, 'utf-8');
        const getEnvValue = (key) => {
          const match = content.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?`, 'm'));
          return match ? match[1] : null;
        };

        const portOffset = Number.parseInt(getEnvValue('DEV_PORT_OFFSET') || '0', 10);
        const vitePort = getEnvValue('DEV_VITE_PORT') || String(5173 + portOffset);
        const apiPort = getEnvValue('DEV_API_PORT') || String(3000 + portOffset);

        return { vite: Number.parseInt(vitePort, 10), api: Number.parseInt(apiPort, 10) };
      }
    }
  } catch {
    // Fall through to defaults
  }
  return defaults;
}

/** Resolves to true if no listener can grab the port on 0.0.0.0. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
}

/** Best-effort `command/pid` lookup for whatever owns a busy port. */
function describePortHolder(port) {
  if (isWindows) return null;
  // execFileSync (no shell) — port is already numeric, but using execFile
  // keeps us aligned with the codebase's no-shell convention.
  if (!Number.isInteger(port)) return null;
  try {
    const out = execFileSync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-P', '-n'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const dataLines = out.trim().split('\n').slice(1);
    if (dataLines.length === 0) return null;
    const [command, pid] = dataLines[0].split(/\s+/);
    return { command, pid };
  } catch {
    return null;
  }
}

const ports = getPortConfig();

// ANSI colors
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Pre-flight: fail fast if either port is already in use. Without this,
// `tsx watch` swallows the EADDRINUSE from the API server, Vite keeps
// serving on its port, and `/api/*` requests return 502 with empty bodies —
// surfacing in the UI as "Unexpected end of JSON input".
const portChecks = await Promise.all(
  [
    { name: 'API', port: ports.api },
    { name: 'Vite', port: ports.vite },
  ].map(async (p) => ({ ...p, free: await isPortFree(p.port) })),
);
const conflicts = portChecks.filter((c) => !c.free);
if (conflicts.length > 0) {
  console.error(`\n  ${yellow('✗')}  Cannot start dev servers — port conflict:\n`);
  for (const { name, port } of conflicts) {
    const holder = describePortHolder(port);
    const who = holder ? `  (held by ${holder.command} PID ${holder.pid})` : '';
    console.error(`     ${name} port ${bold(String(port))} is in use${who}`);
  }
  console.error(
    `\n  An orphaned dev session is likely still running. To recover:\n` +
      `    ${cyan('pkill -f "scripts/dev.js"')}   ${cyan('# kill the previous dev-server tree')}\n` +
      `    ${cyan('npm run dev:start')}              ${cyan('# restart')}\n`,
  );
  process.exit(1);
}

// The service-URL banner is printed *after* both dev servers are listening (see
// announceWhenReady below) rather than up-front. Otherwise Vite's "ready in Xms"
// and the API's startup logs print afterward and scroll the URLs off-screen.
function printBanner() {
  console.log(`
  ${cyan('✦')}  ${bold(projectName)} is ready

  ${cyan('→')}  ${bold('Frontend:')}  ${cyan(`http://localhost:${ports.vite}`)}
  ${cyan('→')}  ${bold('API:')}       ${cyan(`http://localhost:${ports.api}`)}
  ${cyan('→')}  ${bold('Studio:')}    ${cyan('http://studio.localhost')} (no auth in dev)
  ${cyan('→')}  ${bold('Traefik:')}   ${cyan('http://traefik.localhost')} (no auth in dev)
`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until both dev servers hold their ports (i.e. are listening), then print
// the URL banner so it lands as the last thing on screen. We watch the ports
// instead of piping child stdout because `stdio: 'inherit'` keeps Vite's TTY
// (colours + interactive `h+enter` shortcuts); piping would forfeit both.
async function announceWhenReady() {
  const deadline = Date.now() + 30_000; // print anyway after 30s, don't hang
  while (Date.now() < deadline) {
    if (shuttingDown) return;
    const free = await Promise.all([isPortFree(ports.vite), isPortFree(ports.api)]);
    if (free.every((isFree) => !isFree)) break; // both ports in use → listening
    await delay(200);
  }
  if (shuttingDown) return;
  // Let the servers' own "ready"/"Starting server" lines flush first.
  await delay(400);
  if (!shuttingDown) printBanner();
}

const children = [];

// A package manager exports its own config as npm_config_* env vars; the
// nested `npx` then warns "Unknown env config …". Silence npm's own warnings
// for these dev tool processes — tsx/vite write their own logs, not via npm.
const childEnv = { ...process.env, npm_config_loglevel: 'error' };

// Spawn server process with its own process group for clean shutdown
const server = spawn('npx', ['tsx', 'watch', '--env-file=.env.local', 'src/server/index.ts'], {
  stdio: 'inherit',
  shell: isWindows,
  detached: !isWindows, // Create process group on Unix for clean group kill
  env: childEnv,
});
children.push(server);

// Spawn client process
const client = spawn('npx', ['vite'], {
  stdio: 'inherit',
  shell: isWindows,
  detached: !isWindows,
  env: childEnv,
});
children.push(client);

// Track if we're shutting down
let shuttingDown = false;

// Print the URL banner once both servers are up (fire-and-forget).
announceWhenReady();

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('\n  Shutting down...');

  // Kill all child process groups
  for (const child of children) {
    if (child.exitCode === null) {
      if (isWindows) {
        spawn('taskkill', ['/pid', child.pid, '/f', '/t']);
      } else {
        // Kill the entire process group (negative PID)
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Fallback: kill just the process
          try {
            child.kill('SIGTERM');
          } catch {
            // Process already dead
          }
        }
      }
    }
  }

  // Exit immediately - don't wait
  process.exit(exitCode);
}

// Handle signals
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// If either child exits while the session is meant to be running, take the
// rest down with it. Otherwise an API crash leaves Vite happily serving a
// half-dead app where /api/* returns 502s.
for (const child of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const failed = code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT';
    if (failed) {
      console.error(
        `\n  ${yellow('✗')}  Dev process exited unexpectedly (code=${code}, signal=${signal}). Stopping remaining processes.`,
      );
    }
    shutdown(failed ? (code ?? 1) : 0);
  });
}
