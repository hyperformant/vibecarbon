/**
 * carbon/backup/tls-retry.sh: the compose TLS issuance scheduler.
 *
 * Traefik never retries a failed first issuance on its own: the default cert
 * is served "until Traefik is restarted" (Traefik ACME docs, Fallback). So a
 * deploy that finishes with TLS pending relies on this cron (every 30 min) to
 * restart Traefik until the apex certificate lands. Its guards:
 *   - a certificate for the apex in acme.json: done, the counter resets;
 *   - a retired node, or a disarmed issuer (compose-ha standby): never issue;
 *   - an apex that does not resolve to this host ("deploy first, point DNS
 *     after"): wait for DNS, neither restarting nor counting;
 *   - a Traefik younger than 15 minutes: never restart it. A restart abandons
 *     an in-flight DNS-01 order, and a second order on the same
 *     _acme-challenge name meets cached answers (DNS-01 settle doctrine);
 *   - 48 restarts (24 h): give up, so a permanently broken DNS setup stops
 *     costing Let's Encrypt orders; `vibecarbon status` shows it.
 * It logs a state only when it changes, so a healthy env does not grow the
 * log every 30 minutes.
 *
 * Runs the real script under bash with PATH shims: `docker` records its argv
 * and answers ps, inspect and exec from fixture files; `getent` and
 * `hostname` answer the apex resolution and the host addresses.
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
const HOST_V4 = '203.0.113.10';

type Fixture = {
  acmeHasApex?: boolean;
  traefikStartedSecondsAgo?: number;
  caServer?: string;
  retired?: boolean;
  /** Written verbatim to backups/tls-retry.count (no newline added). */
  countText?: string;
  /** What `getent ahostsv4 <apex>` resolves. */
  resolvesV4?: string[];
  /** What `getent ahostsv6 <apex>` resolves. */
  resolvesV6?: string[];
  /** What `hostname -I` prints. */
  hostAddrs?: string[];
  /** The stand-in backup/tls-snapshot.sh exits 1. */
  snapshotFails?: boolean;
};

/** A project dir with shims answering from fixture files. */
function project(f: Fixture = {}) {
  const {
    acmeHasApex = false,
    traefikStartedSecondsAgo = 3600,
    caServer = PROD_CA,
    retired = false,
    countText,
    resolvesV4 = [HOST_V4],
    resolvesV6 = [],
    hostAddrs = [HOST_V4, '10.0.0.2', '172.17.0.1'],
    snapshotFails = false,
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
  writeFileSync(join(fx, 'apex'), acmeHasApex ? '0' : '1');
  // getent ahosts prints each address once per socket type.
  const ahosts = (ips: string[]) =>
    ips.map((ip) => `${ip}       STREAM app.example.com\n${ip}       DGRAM  \n`).join('');
  writeFileSync(join(fx, 'v4'), ahosts(resolvesV4));
  // ahostsv6 maps A records into ::ffff: addresses when there is no AAAA.
  writeFileSync(
    join(fx, 'v6'),
    ahosts(resolvesV6.length ? resolvesV6 : resolvesV4.map((ip) => `::ffff:${ip}`)),
  );
  writeFileSync(join(fx, 'host'), `${hostAddrs.join(' ')} \n`);
  if (retired) writeFileSync(join(dir, '.vibecarbon-retired'), '');
  // A stand-in for the snapshot script: records its run, prints a marker on stdout.
  mkdirSync(join(dir, 'backup'));
  writeFileSync(
    join(dir, 'backup', 'tls-snapshot.sh'),
    `printf '%s\\n' "bash backup/tls-snapshot.sh" >> "${log}"\necho "SNAPSHOT-STDOUT"\nexit ${snapshotFails ? 1 : 0}\n`,
  );
  if (countText !== undefined) writeFileSync(join(dir, 'backups', 'tls-retry.count'), countText);
  const shim = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(bin, name), 0o755);
  };
  shim(
    'docker',
    `printf '%s\\n' "docker $*" >> "${log}"
case "$*" in
  "compose ps -q traefik") echo traefikcid ;;
  *"{{.State.StartedAt}} traefikcid") cat "${fx}/started" ;;
  *"{{json .Config.Cmd}} traefikcid") cat "${fx}/cmd" ;;
  "compose exec -T traefik grep "*) exit "$(cat "${fx}/apex")" ;;
  "compose restart traefik") echo " Container traefik  Started" ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`,
  );
  shim(
    'getent',
    `case "$1" in
  ahostsv4) f="${fx}/v4" ;;
  ahostsv6) f="${fx}/v6" ;;
  *) exit 2 ;;
esac
[ -s "$f" ] || exit 2
cat "$f"
`,
  );
  shim('hostname', `[ "$1" = "-I" ] || exit 1\ncat "${fx}/host"\n`);
  return { dir, bin, log };
}

function run(p: ReturnType<typeof project>, domain: string | null = 'app.example.com') {
  const r = spawnSync('bash', [SCRIPT, ...(domain === null ? [] : [domain])], {
    cwd: p.dir,
    encoding: 'utf-8',
    env: { PATH: `${p.bin}:${process.env.PATH}` },
    timeout: 30_000,
  });
  const countFile = join(p.dir, 'backups', 'tls-retry.count');
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: readFileSync(p.log, 'utf-8').split('\n').filter(Boolean),
    count: existsSync(countFile) ? readFileSync(countFile, 'utf-8').trim() : null,
  };
}

const runRetry = (f: Fixture = {}, domain?: string | null) => run(project(f), domain);

const restarts = (r: ReturnType<typeof run>) =>
  r.calls.filter((c) => c.includes('restart traefik'));

describe('tls-retry.sh', () => {
  it('never restarts a traefik younger than 15 minutes', () => {
    const run = runRetry({ acmeHasApex: false, traefikStartedSecondsAgo: 600 });
    expect(run.calls.filter((c) => c.includes('restart traefik'))).toHaveLength(0);
    expect(run.code).toBe(0);
  });

  it('a certificate for the apex: exits 0 without a restart and resets the counter', () => {
    const r = runRetry({ acmeHasApex: true, countText: '7\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(restarts(r)).toHaveLength(0);
    expect(r.count).toBeNull();
  });

  it('no apex certificate and a Traefik older than 15 minutes: exactly one restart, counted', () => {
    const r = runRetry({ acmeHasApex: false, traefikStartedSecondsAgo: 16 * 60, countText: '2\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls.filter((c) => c === 'docker compose restart traefik')).toHaveLength(1);
    expect(r.count).toBe('3');
  });

  it('a first run with no counter file restarts and starts the count at 1', () => {
    const r = runRetry({ acmeHasApex: false });
    expect(restarts(r)).toHaveLength(1);
    expect(r.count).toBe('1');
  });

  it('a counter file with no trailing newline is still read', () => {
    const r = runRetry({ acmeHasApex: false, countText: '5' });
    expect(restarts(r)).toHaveLength(1);
    expect(r.count).toBe('6');
  });

  it('a disarmed issuer (compose-ha standby) never restarts', () => {
    const r = runRetry({ acmeHasApex: false, caServer: ACME_DISARMED_CA_SERVER });
    expect(r.code, r.stderr).toBe(0);
    expect(restarts(r)).toHaveLength(0);
  });

  it('reads the disarm from the running container command, never from .env', () => {
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\.env\b/);
    const r = runRetry({});
    expect(r.calls).toContain('docker inspect -f {{json .Config.Cmd}} traefikcid');
  });

  it('a retired node never restarts and never calls docker', () => {
    const r = runRetry({ acmeHasApex: false, retired: true });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
  });

  it('48 restarts: gives up, logs it and stops restarting', () => {
    const r = runRetry({ acmeHasApex: false, countText: '48\n' });
    expect(r.code).toBe(0);
    expect(restarts(r)).toHaveLength(0);
    expect(r.stdout).toContain('giving up');
    expect(r.count).toBe('48');
  });

  it('47 restarts: the 48th still runs', () => {
    const r = runRetry({ acmeHasApex: false, countText: '47\n' });
    expect(restarts(r)).toHaveLength(1);
    expect(r.count).toBe('48');
  });

  it('reads acme.json with grep -q inside the traefik container and never prints it', () => {
    const r = runRetry({ acmeHasApex: true });
    const greps = r.calls.filter((c) => c.startsWith('docker compose exec -T traefik grep '));
    expect(greps).toHaveLength(1);
    expect(greps[0]).toMatch(/grep -Eq .*app\\\.example\\\.com.* \/letsencrypt\/acme\.json$/);
    const text = readFileSync(SCRIPT, 'utf-8');
    expect(text).not.toMatch(/\bcat\b[^\n]*acme\.json/);
    expect(r.calls.some((c) => /\bcat\b/.test(c))).toBe(false);
  });

  it.each([
    ['missing', null],
    ['not a hostname', 'bad domain;rm'],
  ])('an apex argument that is %s does nothing', (_label, domain) => {
    const r = runRetry({ acmeHasApex: false }, domain);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
  });
});

describe('tls-retry.sh: deploy first, point DNS after', () => {
  it('an apex that resolves elsewhere: waits for DNS, neither restarting nor counting', () => {
    const r = runRetry({ acmeHasApex: false, resolvesV4: ['198.51.100.7'], countText: '3\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(restarts(r)).toHaveLength(0);
    expect(r.count).toBe('3');
    expect(r.stdout).toContain('waiting for DNS: app.example.com does not point here');
  });

  it('an apex that does not resolve at all waits the same way', () => {
    const r = runRetry({ acmeHasApex: false, resolvesV4: [] });
    expect(restarts(r)).toHaveLength(0);
    expect(r.count).toBeNull();
    expect(r.stdout).toContain('waiting for DNS: app.example.com does not point here');
  });

  it('logs the wait only when the state changes', () => {
    const p = project({ acmeHasApex: false, resolvesV4: ['198.51.100.7'] });
    const first = run(p);
    const second = run(p);
    expect(first.stdout).toContain('waiting for DNS');
    expect(second.stdout).toBe('');
  });

  it('an IPv6-only apex pointing at the host IPv6 counts as pointing here', () => {
    const r = runRetry({
      acmeHasApex: false,
      resolvesV4: [],
      resolvesV6: ['2001:db8::10'],
      hostAddrs: [HOST_V4, '2001:db8::10'],
    });
    expect(restarts(r)).toHaveLength(1);
  });

  it('an AAAA elsewhere does not count when the host has IPv6 of its own', () => {
    const r = runRetry({
      acmeHasApex: false,
      resolvesV4: ['198.51.100.7'],
      resolvesV6: ['2001:db8::99'],
      hostAddrs: [HOST_V4, '2001:db8::10'],
    });
    expect(restarts(r)).toHaveLength(0);
  });

  it('a host with no public address of its own (NAT) cannot tell, so it does not gate', () => {
    const r = runRetry({
      acmeHasApex: false,
      resolvesV4: ['198.51.100.7'],
      hostAddrs: ['10.0.0.2', '172.17.0.1'],
    });
    expect(restarts(r)).toHaveLength(1);
  });
});

describe('tls-retry.sh: state-change logging', () => {
  it('a present certificate is logged once, not every 30 minutes', () => {
    const p = project({ acmeHasApex: true });
    expect(run(p).stdout).toContain('certificate for app.example.com is present');
    expect(run(p).stdout).toBe('');
  });

  const snapshots = (r: ReturnType<typeof run>) =>
    r.calls.filter((c) => c === 'bash backup/tls-snapshot.sh');

  it('the first tick that finds the certificate snapshots it once, on stderr', () => {
    const p = project({ acmeHasApex: true });
    const first = run(p);
    expect(snapshots(first)).toHaveLength(1);
    expect(first.stdout).not.toContain('SNAPSHOT-STDOUT');
    expect(first.stderr).toContain('SNAPSHOT-STDOUT');
    // The calls log is cumulative: still the one run.
    expect(snapshots(run(p))).toHaveLength(1);
  });

  it('a certificate that lands after restarts is snapshotted when it is first seen', () => {
    const p = project({ acmeHasApex: false });
    expect(snapshots(run(p))).toHaveLength(0);
    writeFileSync(join(p.dir, 'fx', 'apex'), '0');
    expect(snapshots(run(p))).toHaveLength(1);
  });

  it('a failed snapshot never fails the tick', () => {
    const r = runRetry({ acmeHasApex: true, snapshotFails: true });
    expect(r.code, r.stderr).toBe(0);
    expect(snapshots(r)).toHaveLength(1);
  });

  it('no certificate: no snapshot', () => {
    expect(snapshots(runRetry({ acmeHasApex: false }))).toHaveLength(0);
  });

  it('a young Traefik is logged once', () => {
    const p = project({ acmeHasApex: false, traefikStartedSecondsAgo: 60 });
    expect(run(p).stdout).toContain('letting its ACME order finish');
    expect(run(p).stdout).toBe('');
  });

  it('every restart is logged (bounded at 48)', () => {
    const p = project({ acmeHasApex: false });
    expect(run(p).stdout).toContain('(1 of 48)');
    expect(run(p).stdout).toContain('(2 of 48)');
  });
});
