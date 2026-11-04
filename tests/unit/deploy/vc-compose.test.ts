/**
 * vc-compose: the one Compose command on a deployed server.
 *
 * Every server-side Compose call (reconcile.sh, the systemd unit, the add-on
 * job, the backup and TLS scripts, and every command the CLI sends over ssh)
 * runs `sh vc-compose <args>` from the project dir. The bundle renders the
 * script with the deploy's own `-f` set (composeFileFlags), and the script adds
 * the replication overlay when the node carries it (a compose-ha node does, a
 * single compose server never does).
 *
 * Why it exists (2026-11-04, DO compose-ha scale): restoreCompose re-ran
 * app-migrate as a bare `docker compose run`, which reads docker-compose.yml
 * alone. There app-migrate has only a `build:` section (prod.yml gives it its
 * image and resets the build), so the bare run tried to build on the server
 * and failed: `"/docker-entrypoint.sh": not found`.
 *
 * These tests run the rendered script against a stub `docker` that records
 * its working directory, its argv (one per line) and its stdin.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeFileFlags, renderBundle } from '../../../src/lib/deploy/bundle.js';
import {
  COMPOSE_REPLICATION_OVERLAY,
  renderComposeCommand,
  VC_COMPOSE,
  VC_COMPOSE_SCRIPT,
} from '../../../src/lib/deploy/compose/command.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const BASE_FLAGS = '-f docker-compose.yml -f docker-compose.prod.yml';

const dirs: string[] = [];
function tempDir(prefix = 'vc-compose-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A `docker` on PATH that records cwd, argv and stdin, then exits $STUB_EXIT. */
function stubDocker(): { bin: string; record: string } {
  const bin = tempDir('vc-compose-bin-');
  const record = join(bin, 'record');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
{ echo "CWD=$(pwd)"; for a in "$@"; do echo "ARG=$a"; done; } > "${record}"
cat > "${record}.stdin"
exit \${STUB_EXIT:-0}
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return { bin, record };
}

function readRecord(record: string) {
  const lines = readFileSync(record, 'utf-8').trim().split('\n');
  return {
    cwd: lines.find((l) => l.startsWith('CWD='))?.slice(4),
    argv: lines.filter((l) => l.startsWith('ARG=')).map((l) => l.slice(4)),
    stdin: readFileSync(`${record}.stdin`, 'utf-8'),
  };
}

/** Run `sh <script> <args>` from `cwd`, with the stub first on PATH. */
function runScript(
  script: string,
  args: string[],
  opts: { cwd: string; bin: string; input?: string; env?: Record<string, string> },
) {
  return spawnSync('sh', [script, ...args], {
    cwd: opts.cwd,
    input: opts.input ?? '',
    encoding: 'utf-8',
    env: { ...process.env, ...opts.env, PATH: `${opts.bin}:${process.env.PATH}` },
  });
}

const words = (flags: string) => flags.split(' ').filter(Boolean);

describe('renderComposeCommand: the script every server-side Compose call runs', () => {
  it('is spelled `sh vc-compose`, through sh so the file mode never matters', () => {
    expect(VC_COMPOSE_SCRIPT).toBe('vc-compose');
    expect(VC_COMPOSE).toBe('sh vc-compose');
  });

  it('runs docker compose with the baked -f set, then the caller arguments, in its own directory', () => {
    const project = tempDir();
    writeFileSync(join(project, VC_COMPOSE_SCRIPT), renderComposeCommand(BASE_FLAGS));
    const { bin, record } = stubDocker();
    // Called by absolute path from elsewhere: it still runs in the project dir,
    // where compose finds the files, the .env and the project name.
    const r = runScript(
      join(project, VC_COMPOSE_SCRIPT),
      ['exec', '-T', 'db', 'psql', '-c', 'select 1'],
      { cwd: tmpdir(), bin },
    );
    expect(r.status, r.stderr).toBe(0);
    const { cwd, argv } = readRecord(record);
    expect(cwd).toBe(project);
    expect(argv).toEqual([
      'compose',
      ...words(BASE_FLAGS),
      'exec',
      '-T',
      'db',
      'psql',
      '-c',
      'select 1',
    ]);
  });

  it('adds the replication overlay after the baked set when the node carries it', () => {
    const project = tempDir();
    writeFileSync(join(project, VC_COMPOSE_SCRIPT), renderComposeCommand(BASE_FLAGS));
    writeFileSync(join(project, COMPOSE_REPLICATION_OVERLAY), 'services: {}\n');
    const { bin, record } = stubDocker();
    const r = runScript(VC_COMPOSE_SCRIPT, ['up', '-d', 'repl-gateway'], { cwd: project, bin });
    expect(r.status, r.stderr).toBe(0);
    expect(readRecord(record).argv).toEqual([
      'compose',
      ...words(BASE_FLAGS),
      '-f',
      COMPOSE_REPLICATION_OVERLAY,
      'up',
      '-d',
      'repl-gateway',
    ]);
  });

  it('a node without the overlay (a single compose server) gets the baked set alone', () => {
    const project = tempDir();
    writeFileSync(join(project, VC_COMPOSE_SCRIPT), renderComposeCommand(BASE_FLAGS));
    const { bin, record } = stubDocker();
    runScript(VC_COMPOSE_SCRIPT, ['ps'], { cwd: project, bin });
    expect(readRecord(record).argv).not.toContain(COMPOSE_REPLICATION_OVERLAY);
  });

  it('passes stdin through (psql and node scripts are piped into exec -T)', () => {
    const project = tempDir();
    writeFileSync(join(project, VC_COMPOSE_SCRIPT), renderComposeCommand(BASE_FLAGS));
    const { bin, record } = stubDocker();
    runScript(VC_COMPOSE_SCRIPT, ['exec', '-T', 'db', 'psql'], {
      cwd: project,
      bin,
      input: 'SELECT 1;\n',
    });
    expect(readRecord(record).stdin).toBe('SELECT 1;\n');
  });

  it('exits with compose exit status, so a failed command fails its caller', () => {
    const project = tempDir();
    writeFileSync(join(project, VC_COMPOSE_SCRIPT), renderComposeCommand(BASE_FLAGS));
    const { bin } = stubDocker();
    const r = runScript(VC_COMPOSE_SCRIPT, ['run', '--rm', 'app-migrate'], {
      cwd: project,
      bin,
      env: { STUB_EXIT: '17' },
    });
    expect(r.status).toBe(17);
  });
});

/**
 * A project dir shaped like a generated one: carbon's compose files and
 * backup scripts, plus the add-on overlays (shipped by `vibecarbon add`, so
 * not in carbon/ itself), and a .env.
 */
function project(): string {
  const dir = tempDir('vc-compose-project-');
  for (const f of readdirSync(join(REPO, 'carbon'))) {
    if (/^docker-compose\..*ya?ml$/.test(f)) cpSync(join(REPO, 'carbon', f), join(dir, f));
  }
  cpSync(join(REPO, 'carbon', 'backup'), join(dir, 'backup'), { recursive: true });
  for (const addon of ['observability', 'redis']) {
    cpSync(
      join(REPO, 'services', addon, 'compose', 'docker-compose.yml'),
      join(dir, `docker-compose.${addon}.yml`),
    );
    cpSync(
      join(REPO, 'services', addon, 'compose', 'docker-compose.prod.yml'),
      join(dir, `docker-compose.${addon}.prod.yml`),
    );
  }
  writeFileSync(join(dir, '.env'), 'PROJECT_NAME=myproj\n');
  return dir;
}

const FEATURES: Record<string, Record<string, unknown>> = {
  'no add-ons': {},
  observability: { observability: true },
  'n8n + metabase': { n8n: true, metabase: true },
  redis: { redis: true },
  'every add-on': { observability: true, n8n: true, metabase: true, redis: true },
};

describe('renderBundle stages vc-compose with the deploy -f set', () => {
  let cwd: string | undefined;
  afterEach(() => {
    if (cwd) process.chdir(cwd);
    cwd = undefined;
  });

  function stage(options: Record<string, unknown>): string {
    cwd = process.cwd();
    process.chdir(project());
    const dir = renderBundle('myproj', options);
    dirs.push(dir);
    return dir;
  }

  for (const [name, options] of Object.entries(FEATURES)) {
    it(`${name}: executable, and runs compose over exactly the files the bundle staged`, () => {
      const bundle = stage(options);
      const path = join(bundle, VC_COMPOSE_SCRIPT);
      expect(readFileSync(path, 'utf-8')).toBe(renderComposeCommand(composeFileFlags(options)));
      expect(statSync(path).mode & 0o111).not.toBe(0);

      const { bin, record } = stubDocker();
      const r = runScript(VC_COMPOSE_SCRIPT, ['config'], { cwd: bundle, bin });
      expect(r.status, r.stderr).toBe(0);
      const argv = readRecord(record).argv;
      const files = argv.filter((_, i) => argv[i - 1] === '-f');
      expect(files.slice(0, 2)).toEqual(['docker-compose.yml', 'docker-compose.prod.yml']);
      // Every file it names went out in the same bundle, so a server never
      // reads a set its bundle cannot satisfy.
      for (const f of files) expect(existsSync(join(bundle, f)), f).toBe(true);
      // And every compose file the bundle staged is in the set.
      const staged = readdirSync(bundle).filter((f) => /^docker-compose\..*ya?ml$/.test(f));
      expect(new Set(files)).toEqual(new Set(staged));
    });
  }

  it('every other staged artifact reaches Compose only through vc-compose', () => {
    const bundle = stage(FEATURES['every add-on + dns-01']);
    const offenders: string[] = [];
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (name === VC_COMPOSE_SCRIPT || /\.ya?ml$|^\.env$|\.env$/.test(name)) continue;
        const text = readFileSync(full, 'utf-8');
        text.split('\n').forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          if (/\bdocker compose\b|-f docker-compose\./.test(line)) {
            offenders.push(`${relative(bundle, full)}:${i + 1}: ${line.trim()}`);
          }
        });
        if (text.includes(VC_COMPOSE)) callers.push(relative(bundle, full));
      }
    };
    walk(bundle);
    expect(offenders).toEqual([]);
    // The ones that run Compose at all: reconcile, the unit, the add-on job,
    // and the backup and TLS scripts the cron runs.
    expect(callers).toEqual(
      expect.arrayContaining([
        'reconcile.sh',
        'myproj.service',
        'addons-start.sh',
        'backup/compose-backup.sh',
        'backup/tls-snapshot.sh',
        'backup/tls-retry.sh',
      ]),
    );
  });
});
