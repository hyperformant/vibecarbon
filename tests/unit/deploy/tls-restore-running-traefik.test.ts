/**
 * The saved certificate is read and written through a RUNNING Traefik with
 * `exec`, and a one-off `run` container is used only when Traefik is stopped.
 *
 * The bug (2026-11-04, DigitalOcean compose-ha rig): with the observability
 * add-on Traefik holds a static ipv4_address, so `run --rm ... traefik` beside
 * a running Traefik dies with "Address already in use". The live check then
 * read as "could not check the live certificate" and the restore was skipped
 * on every warm deploy and on every promoted failover node.
 *
 * These tests run the REAL rendered scripts under bash, with a stub `docker`
 * on PATH that answers `ps -q traefik` and records every other call.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DROP_COMPOSE_FILES_SH, writeVcCompose } from '../../_shared/vc-compose-stub.js';
import { acmeJson } from './_tls-fixtures.ts';

const { restoreComposeTls } = await import('../../../src/lib/deploy/compose/tls-restore.js');

const SNAPSHOT = acmeJson({});
const S3 = { bucket: 'b', accessKey: 'AK', secretKey: 'SK', region: 'r', endpoint: 'https://e' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-tls-running-'));
  mkdirSync(join(dir, 'bin'));
  writeVcCompose(dir);
  // ps -q traefik prints an id while TRAEFIK_RUNNING=1; exec/run/restart are
  // logged (inner `sh -c` text shown as <inner>); exec/run keep their stdin.
  writeFileSync(
    join(dir, 'bin', 'docker'),
    `#!/bin/sh\n${DROP_COMPOSE_FILES_SH}` +
      `shift\nsub=$1\nline=\n` +
      `for a in "$@"; do case "$a" in *' '*) a='<inner>';; esac; line="\${line:+$line }$a"; done\n` +
      `echo "$line" >> "${dir}/calls.log"\n` +
      `case "$sub" in\n` +
      `  ps) [ "\${TRAEFIK_RUNNING:-0}" = 1 ] && echo abc123; exit 0;;\n` +
      `  exec|run) cat > "${dir}/stdin.bin"; echo "\${INNER_ANSWER:-}"; exit 0;;\n` +
      `  *) exit 0;;\n` +
      `esac\n`,
  );
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The scripts restoreComposeTls would send: [liveCheck, write]. */
async function renderedScripts(restart = true): Promise<string[]> {
  const scripts: string[] = [];
  await restoreComposeTls({
    ip: '10.0.0.1',
    sshKeyPath: '/k',
    projectName: 'myapp',
    domain: 'app.example.com',
    envName: 'production',
    ca: 'staging',
    s3Config: S3,
    restart,
    deps: {
      read: async () => ({ text: SNAPSHOT }),
      ssh: async (_ip: string, _k: string, argv: string[]) => {
        scripts.push(argv[2]);
        return scripts.length === 1 ? 'absent' : '';
      },
    },
  });
  // The scripts cd into /opt/myapp; run them in the stand-in project dir.
  return scripts.map((s) => s.replace('cd /opt/myapp', `cd ${dir}`));
}

function runScript(script: string, { running, input = '', answer = '' }: Record<string, unknown>) {
  const r = spawnSync('bash', ['-c', script], {
    input: input as string,
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      TRAEFIK_RUNNING: running ? '1' : '0',
      INNER_ANSWER: answer as string,
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
  } catch {}
  return { ...r, calls };
}

describe('the live check, Traefik running', () => {
  it('goes through exec -T and never starts a run container', async () => {
    const [check] = await renderedScripts();
    const r = runScript(check, { running: true, answer: 'present' });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('exec -T traefik sh -c <inner> sh'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('run'))).toBe(false);
    expect(r.stdout.trim()).toBe('present');
  });
  it('prints absent when the inner grep says so', async () => {
    const [check] = await renderedScripts();
    const r = runScript(check, { running: true, answer: 'absent' });
    expect(r.stdout.trim()).toBe('absent');
    expect(r.calls.some((c) => c.startsWith('run'))).toBe(false);
  });
});

describe('Traefik stopped', () => {
  it('the live check uses run --rm --no-deps -T, never exec', async () => {
    const [check] = await renderedScripts();
    const r = runScript(check, { running: false, answer: 'absent' });
    expect(r.status).toBe(0);
    expect(
      r.calls.some((c) =>
        c.startsWith('run --rm --no-deps -T --entrypoint sh traefik -c <inner> sh'),
      ),
    ).toBe(true);
    expect(r.calls.some((c) => c.startsWith('exec'))).toBe(false);
    expect(r.stdout.trim()).toBe('absent');
  });
  it('the write streams the snapshot through run, and does not restart', async () => {
    const [, write] = await renderedScripts();
    const r = runScript(write, { running: false, input: SNAPSHOT });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'stdin.bin'), 'utf8')).toBe(SNAPSHOT);
    expect(r.calls.some((c) => c.startsWith('exec'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('restart'))).toBe(false);
  });
});

describe('the write, Traefik running', () => {
  it('delivers the snapshot bytes on stdin through exec -T, then restarts Traefik', async () => {
    const [, write] = await renderedScripts(true);
    const r = runScript(write, { running: true, input: SNAPSHOT });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'stdin.bin'), 'utf8')).toBe(SNAPSHOT);
    expect(r.calls.some((c) => c.startsWith('exec -T traefik sh -c <inner> sh'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('run'))).toBe(false);
    expect(r.calls.at(-1)).toBe('restart traefik');
  });
  it('with restart false, leaves the running Traefik alone', async () => {
    const [, write] = await renderedScripts(false);
    const r = runScript(write, { running: true, input: SNAPSHOT });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('restart'))).toBe(false);
  });
});
