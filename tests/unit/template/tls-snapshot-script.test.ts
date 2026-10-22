/**
 * carbon/backup/tls-snapshot.sh: the compose server saves its TLS certificate
 * to the backups bucket, beside every base backup (compose-backup.sh runs it
 * after the push) and on demand (`vibecarbon deploy`, once TLS is trusted).
 *
 * acme.json holds the private key, so the file is streamed from the traefik
 * container straight into the db container's `wal-g st put -s` (which already
 * holds the bucket credentials): no copy on the host, nothing on argv, and
 * nothing printed. A snapshot is only ever written from a node that issues
 * the certificate (never a retired node, a disarmed compose-ha standby or a
 * standby-role db) and only when acme.json holds the apex certificate, so a
 * worse file never replaces a good snapshot.
 *
 * Runs the real script under bash with a `docker` PATH shim that records its
 * argv and answers from fixture files; the upload's stdin is captured.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ACME_DISARMED_CA_SERVER } from '../../../src/lib/deploy/acme-role.js';
import { tlsSnapshotS3Prefix } from '../../../src/lib/deploy/tls-snapshot.js';

const SCRIPT = fileURLToPath(new URL('../../../carbon/backup/tls-snapshot.sh', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'tls-snapshot-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROD_CA = 'https://acme-v02.api.letsencrypt.org/directory';
const PREFIX = tlsSnapshotS3Prefix({
  backupBucket: 'proj-backups',
  projectName: 'proj',
  envName: 'prod',
  ca: 'prod',
});
const UPLOAD = `docker compose exec -T -e WALG_S3_PREFIX=${PREFIX} db wal-g st put -s -f --no-compress --no-encrypt compose-acme.json`;

/** An acme.json shaped like Traefik's, with a stand-in key that must never be printed. */
const KEY_MARKER = 'S3CR3T-KEY-MATERIAL';
const acmeJson = (main: string) =>
  `${JSON.stringify(
    {
      letsencrypt: {
        Account: { Email: 'admin@app.example.com', PrivateKey: KEY_MARKER },
        Certificates: [
          {
            domain: { main },
            certificate: 'LS0tLS1CRUdJTi...',
            key: KEY_MARKER,
            Store: 'default',
          },
        ],
      },
    },
    null,
    2,
  )}\n`;

type Fixture = {
  /** What `printenv TLS_SNAPSHOT_S3_PREFIX` prints in traefik; null = unset (exit 1). */
  prefix?: string | null;
  /** What `printenv TLS_SNAPSHOT_DOMAIN` prints in traefik; null = unset. */
  domain?: string | null;
  /** The `main` of the one certificate in acme.json. */
  acmeMain?: string;
  caServer?: string;
  /** WALG_ROLE in the db container; null = unset. */
  walgRole?: string | null;
  retired?: boolean;
  traefikRunning?: boolean;
  uploadFails?: boolean;
};

function run(f: Fixture = {}) {
  const {
    prefix = PREFIX,
    domain = 'app.example.com',
    acmeMain = 'app.example.com',
    caServer = PROD_CA,
    walgRole = 'primary',
    retired = false,
    traefikRunning = true,
    uploadFails = false,
  } = f;
  const root = mkdtempSync(join(scratch, 'p-'));
  const dir = join(root, 'project');
  const bin = join(root, 'bin');
  const fx = join(root, 'fx');
  for (const d of [dir, bin, fx]) mkdirSync(d);
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(fx, 'acme.json'), acmeJson(acmeMain));
  writeFileSync(
    join(fx, 'cmd'),
    `${JSON.stringify([
      '--providers.docker=true',
      '--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json',
      `--certificatesresolvers.letsencrypt.acme.caserver=${caServer}`,
    ])}\n`,
  );
  const answer = (name: string, v: string | null) => {
    if (v !== null) writeFileSync(join(fx, name), `${v}\n`);
  };
  answer('prefix', prefix);
  answer('domain', domain);
  answer('role', walgRole);
  if (retired) writeFileSync(join(dir, '.vibecarbon-retired'), '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
printf '%s\\n' "docker $*" >> "${log}"
answer() { [ -f "${fx}/$1" ] || exit 1; cat "${fx}/$1"; }
case "$*" in
  "compose ps -q traefik") ${traefikRunning ? 'echo traefikcid' : ':'} ;;
  "inspect -f {{json .Config.Cmd}} traefikcid") cat "${fx}/cmd" ;;
  "compose exec -T traefik printenv TLS_SNAPSHOT_S3_PREFIX") answer prefix ;;
  "compose exec -T traefik printenv TLS_SNAPSHOT_DOMAIN") answer domain ;;
  "compose exec -T db printenv WALG_ROLE") answer role ;;
  "compose exec -T traefik grep "*)
    shift 5
    set -- "\${@:1:$(($# - 1))}" "${fx}/acme.json"
    exec grep "$@" ;;
  "compose exec -T traefik cat /letsencrypt/acme.json") cat "${fx}/acme.json" ;;
  "compose exec -T -e WALG_S3_PREFIX="*" db wal-g st put "*)
    cat > "${fx}/uploaded"
    ${uploadFails ? 'echo "ERROR: AccessDenied" >&2; exit 1' : 'echo "INFO: put ok" >&2'} ;;
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
  const uploadedPath = join(fx, 'uploaded');
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: readFileSync(log, 'utf-8').split('\n').filter(Boolean),
    uploaded: existsSync(uploadedPath) ? readFileSync(uploadedPath, 'utf-8') : null,
    acme: readFileSync(join(fx, 'acme.json'), 'utf-8'),
    projectFiles: readdirSync(dir),
  };
}

const uploads = (r: ReturnType<typeof run>) => r.calls.filter((c) => c.includes('st put'));

describe('tls-snapshot.sh', () => {
  it('a matching acme.json: exactly one st put, fed acme.json on stdin, no file in the project dir', () => {
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toEqual([UPLOAD]);
    expect(r.calls).toContain('docker compose exec -T traefik cat /letsencrypt/acme.json');
    expect(r.uploaded).toBe(r.acme);
    expect(r.projectFiles).toEqual([]);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain(KEY_MARKER);
    expect(r.stderr).toContain(`${PREFIX}/compose-acme.json`);
  });

  it('a standby-role db (compose-ha standby): no st put, exit 0', () => {
    const r = run({ walgRole: 'standby' });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
    expect(r.stdout).toBe('');
  });

  it('an unset WALG_ROLE reads as the primary', () => {
    const r = run({ walgRole: null });
    expect(uploads(r)).toEqual([UPLOAD]);
  });

  it('a retired node: nothing runs, exit 0', () => {
    const r = run({ retired: true });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it('a disarmed issuer in the running traefik command: no st put, exit 0', () => {
    const r = run({ caServer: ACME_DISARMED_CA_SERVER });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
  });

  it('an acme.json without the apex certificate: no st put, exit 0', () => {
    const r = run({ acmeMain: 'other.example.com' });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
    // A subdomain certificate is not the apex: the pattern is anchored.
    expect(uploads(run({ acmeMain: 'app.example.com.evil' }))).toHaveLength(0);
    expect(uploads(run({ domain: 'example.com', acmeMain: 'appXexample.com' }))).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['unset', null],
    ['not an s3 URL', 'https://bucket/backups/p/e/tls/prod'],
    ['a bucket with no path', 's3://bucket'],
    ['shell metacharacters', 's3://bucket/backups/p/e/tls/prod;id'],
    ['a space', 's3://bucket/backups/p e/tls/prod'],
  ])('a TLS_SNAPSHOT_S3_PREFIX that is %s: skips with exit 0', (_label, prefix) => {
    const r = run({ prefix });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
    expect(r.stdout).toBe('');
  });

  it.each([
    ['empty', ''],
    ['unset', null],
    ['a regex metacharacter', 'app.example.com|x'],
  ])('a TLS_SNAPSHOT_DOMAIN that is %s: skips with exit 0', (_label, domain) => {
    const r = run({ domain });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
  });

  it('no running traefik: skips with exit 0', () => {
    const r = run({ traefikRunning: false });
    expect(r.code, r.stderr).toBe(0);
    expect(uploads(r)).toHaveLength(0);
  });

  it('a failed upload exits non-zero with a one-line cause and no key material', () => {
    const r = run({ uploadFails: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/tls snapshot upload failed/);
    expect(r.stderr).not.toContain(KEY_MARKER);
    expect(r.stdout).toBe('');
  });

  it('the script sets umask 077, writes only stderr, and never prints a backup marker', () => {
    const text = readFileSync(SCRIPT, 'utf-8');
    expect(text).toMatch(/^umask 077$/m);
    expect(text).not.toContain('BACKUP_RESULT');
    const code = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // Every echo goes to stderr.
    for (const line of code.split('\n').filter((l) => /\becho\b/.test(l))) {
      expect(line).toMatch(/>&2/);
    }
    // The prefix is read from the traefik service env, never from .env.
    expect(code).not.toMatch(/\.env\b/);
    expect(code).toContain('printenv TLS_SNAPSHOT_S3_PREFIX');
  });
});

describe('the snapshot prefix and apex reach the servers as data', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

  it('the prod traefik service carries both, interpolated from .env', () => {
    const prod = read('carbon/docker-compose.prod.yml');
    const traefik = prod.slice(
      prod.indexOf('\n  traefik:\n'),
      prod.indexOf('\n    ports:', prod.indexOf('\n  traefik:\n')),
    );
    expect(traefik).toMatch(
      /\n {4}environment:\n {6}TLS_SNAPSHOT_S3_PREFIX: \$\{TLS_SNAPSHOT_S3_PREFIX:-\}\n {6}TLS_SNAPSHOT_DOMAIN: \$\{DOMAIN:-\}$/,
    );
  });

  it('the compose deploy passes the prefix to renderBundle only with a backup bucket', () => {
    const src = read('src/lib/deploy/orchestrator.js');
    const call = src.slice(src.indexOf('const bundlePath = renderBundle('));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/tlsSnapshotPrefix/);
    expect(src).toMatch(
      /backupS3Config\?\.bucket\s*\?\s*tlsSnapshotS3Prefix\(\{\s*backupBucket: backupS3Config\.bucket/,
    );
  });

  it('k3s computes the issuer before renderK8sBase and puts the prefix in the settings ConfigMap', () => {
    const src = read('src/lib/deploy/k8s/k3s.js');
    const start = src.indexOf('export async function applyK3sManifests(');
    const fn = src.slice(start, src.indexOf('\nexport ', start + 1));
    const issuer = fn.indexOf('const issuerName = pickIssuerName(');
    expect(issuer).toBeGreaterThan(-1);
    expect(issuer).toBeLessThan(fn.indexOf('renderK8sBase('));
    expect(fn).toMatch(
      /renderBackupSettingsConfigMap\(\{\s*\.\.\.backupSettings,\s*tlsSnapshotPrefix/,
    );
    // One computation of the issuer per deploy.
    expect(fn.match(/pickIssuerName\(/g)).toHaveLength(1);
  });

  it('create copies the script, executable', () => {
    const src = read('src/create.js');
    expect(src).toContain("copyTemplate('backup/tls-snapshot.sh'");
    expect(src).toContain("chmodSync(join(projectDir, 'backup/tls-snapshot.sh'), 0o755)");
  });

  it('the backup Role can read the vibecarbon-tls Secret and no other', async () => {
    const { loadAll } = await import('js-yaml');
    const role = (
      loadAll(read('carbon/k8s/base/backup/rbac.yaml')) as Array<{
        kind: string;
        rules?: Array<{ resources: string[]; verbs: string[]; resourceNames?: string[] }>;
      }>
    ).find((d) => d.kind === 'Role');
    const secretRules = role?.rules?.filter((r) => r.resources.includes('secrets')) ?? [];
    expect(secretRules).toEqual([
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: ['vibecarbon-tls'],
      },
    ]);
  });
});
