/**
 * carbon/backup/tls-retry.sh: the compose TLS issuance scheduler.
 *
 * Traefik never retries a failed first issuance on its own: the default cert
 * is served "until Traefik is restarted" (Traefik ACME docs, Fallback). So a
 * deploy that finishes with TLS pending relies on this cron (every 30 min) to
 * restart Traefik until the apex certificate lands. Its guards:
 *   - a certificate for the apex in acme.json: done, the counter resets;
 *   - a retired node, or a disarmed issuer (compose-ha standby): never issue;
 *   - a Traefik younger than 15 minutes: never restart it. A restart abandons
 *     an in-flight DNS-01 order, and a second order on the same
 *     _acme-challenge name meets cached answers (DNS-01 settle doctrine);
 *   - 48 restarts (24 h): give up, so a permanently broken DNS setup stops
 *     costing Let's Encrypt orders; `vibecarbon status` shows it.
 *
 * Runs the real script under bash with a PATH-shim `docker` that records its
 * argv and answers ps, inspect and exec from fixture files.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ACME_DISARMED_CA_SERVER } from '../../../src/lib/deploy/acme-role.js';

const SCRIPT = fileURLToPath(new URL('../../../carbon/backup/tls-retry.sh', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'tls-retry-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROD_CA = 'https://acme-v02.api.letsencrypt.org/directory';

type Fixture = {
  acmeHasApex?: boolean;
  traefikStartedSecondsAgo?: number;
  caServer?: string;
  retired?: boolean;
  count?: number;
  domain?: string;
};

/**
 * The shim. `docker compose ps -q <svc>` prints a container id,
 * `docker inspect -f <fmt> <id>` answers from fixture files, and
 * `docker compose exec -T traefik grep ...` exits 0 only when the fixture says
 * acme.json holds the apex. Every call is appended to calls.log.
 */
function runRetry(f: Fixture = {}) {
  const {
    acmeHasApex = false,
    traefikStartedSecondsAgo = 3600,
    caServer = PROD_CA,
    retired = false,
    count,
    domain = 'app.example.com',
  } = f;
  const dir = mkdtempSync(join(scratch, 'p-'));
  const bin = join(dir, 'bin');
  const fx = join(dir, 'fx');
  mkdirSync(bin);
  mkdirSync(fx);
  mkdirSync(join(dir, 'backups'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const started = new Date(Date.now() - traefikStartedSecondsAgo * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, '.123456789Z');
  writeFileSync(join(fx, 'started'), `${started}\n`);
  writeFileSync(
    join(fx, 'cmd'),
    `${JSON.stringify([
      '--providers.docker=true',
      '--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json',
      `--certificatesresolvers.letsencrypt.acme.caserver=${caServer}`,
    ])}\n`,
  );
  writeFileSync(join(fx, 'rule'), `Host(\`${domain}\`)\n`);
  writeFileSync(join(fx, 'apex'), acmeHasApex ? '0' : '1');
  if (retired) writeFileSync(join(dir, '.vibecarbon-retired'), '');
  if (count !== undefined) writeFileSync(join(dir, 'backups', 'tls-retry.count'), `${count}\n`);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "docker $*" >> "${log}"
case "$*" in
  "compose ps -q traefik") echo traefikcid ;;
  "compose ps -q app") echo appcid ;;
  *"{{.State.StartedAt}} traefikcid") cat "${fx}/started" ;;
  *"{{json .Config.Cmd}} traefikcid") cat "${fx}/cmd" ;;
  *"traefik.http.routers.app.rule"*" appcid") cat "${fx}/rule" ;;
  "compose exec -T traefik grep "*) exit "$(cat "${fx}/apex")" ;;
  "compose restart traefik") echo " Container traefik  Started" ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const r = spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf-8',
    env: { PATH: `${bin}:${process.env.PATH}` },
    timeout: 30_000,
  });
  const countFile = join(dir, 'backups', 'tls-retry.count');
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: readFileSync(log, 'utf-8').split('\n').filter(Boolean),
    count: existsSync(countFile) ? readFileSync(countFile, 'utf-8').trim() : null,
  };
}

const restarts = (run: ReturnType<typeof runRetry>) =>
  run.calls.filter((c) => c.includes('restart traefik'));

describe('tls-retry.sh', () => {
  it('never restarts a traefik younger than 15 minutes', () => {
    const run = runRetry({ acmeHasApex: false, traefikStartedSecondsAgo: 600 });
    expect(run.calls.filter((c) => c.includes('restart traefik'))).toHaveLength(0);
    expect(run.code).toBe(0);
  });

  it('a certificate for the apex: exits 0 without a restart and resets the counter', () => {
    const run = runRetry({ acmeHasApex: true, count: 7 });
    expect(run.code, run.stderr).toBe(0);
    expect(restarts(run)).toHaveLength(0);
    expect(run.count).toBeNull();
  });

  it('no apex certificate and a Traefik older than 15 minutes: exactly one restart, counted', () => {
    const run = runRetry({ acmeHasApex: false, traefikStartedSecondsAgo: 16 * 60, count: 2 });
    expect(run.code, run.stderr).toBe(0);
    expect(run.calls.filter((c) => c === 'docker compose restart traefik')).toHaveLength(1);
    expect(run.count).toBe('3');
  });

  it('a first run with no counter file restarts and starts the count at 1', () => {
    const run = runRetry({ acmeHasApex: false });
    expect(restarts(run)).toHaveLength(1);
    expect(run.count).toBe('1');
  });

  it('a disarmed issuer (compose-ha standby) never restarts', () => {
    const run = runRetry({ acmeHasApex: false, caServer: ACME_DISARMED_CA_SERVER });
    expect(run.code, run.stderr).toBe(0);
    expect(restarts(run)).toHaveLength(0);
  });

  it('reads the disarm from the running container command, never from .env', () => {
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\.env\b/);
    const run = runRetry({});
    expect(run.calls).toContain('docker inspect -f {{json .Config.Cmd}} traefikcid');
  });

  it('a retired node never restarts and never calls docker', () => {
    const run = runRetry({ acmeHasApex: false, retired: true });
    expect(run.code).toBe(0);
    expect(run.calls).toHaveLength(0);
  });

  it('48 restarts: gives up, logs it and stops restarting', () => {
    const run = runRetry({ acmeHasApex: false, count: 48 });
    expect(run.code).toBe(0);
    expect(restarts(run)).toHaveLength(0);
    expect(run.stdout).toContain('giving up');
    expect(run.count).toBe('48');
  });

  it('47 restarts: the 48th still runs', () => {
    const run = runRetry({ acmeHasApex: false, count: 47 });
    expect(restarts(run)).toHaveLength(1);
    expect(run.count).toBe('48');
  });

  it('reads acme.json with grep -q inside the traefik container and never prints it', () => {
    const run = runRetry({ acmeHasApex: true });
    const greps = run.calls.filter((c) => c.startsWith('docker compose exec -T traefik grep '));
    expect(greps).toHaveLength(1);
    expect(greps[0]).toMatch(/grep -Eq .*app\\\.example\\\.com.* \/letsencrypt\/acme\.json$/);
    const text = readFileSync(SCRIPT, 'utf-8');
    expect(text).not.toMatch(/\bcat\b[^\n]*acme\.json/);
    expect(run.calls.some((c) => /\bcat\b/.test(c))).toBe(false);
  });

  it('an apex it cannot read from the app router does nothing', () => {
    const run = runRetry({ acmeHasApex: false, domain: 'bad domain;rm' });
    expect(run.code).toBe(0);
    expect(restarts(run)).toHaveLength(0);
    expect(run.calls.some((c) => c.includes('exec'))).toBe(false);
  });
});
