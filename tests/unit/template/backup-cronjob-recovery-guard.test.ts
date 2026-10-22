/**
 * The backup CronJob's primary/standby guard must FAIL LOUD when it cannot
 * prove which one it is talking to.
 *
 * Latent false-green found during the 2026-08-16 backup RCA (run 31927810430):
 * the guard compared `$(psql ... pg_is_in_recovery())` inside a `[ ... ]`
 * test. When psql itself fails (database starting up, exec transport broken),
 * the substitution is EMPTY, `"" != "f"` is true, and the job logs "skipping
 * base backup" and exits 0 — a nightly backup that silently succeeds while
 * never backing anything up. The guard may only skip on a literal `t`
 * (genuine standby), proceed on a literal `f`, and must exit non-zero on
 * anything else, including a failed probe.
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
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { STANDBY_SELFSIGNED_ISSUER } from '../../../src/lib/deploy/tls-issuer-names.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CRONJOB = join(ROOT, 'carbon', 'k8s', 'base', 'backup', 'cronjob.yaml');

describe('backup CronJob recovery guard', () => {
  const script = readFileSync(CRONJOB, 'utf-8');

  it('never maps a failed recovery probe to "skip and succeed"', () => {
    // The failure-shaped pattern: psql substituted directly into a test, where
    // an error collapses to the empty string and reads as "standby".
    expect(script).not.toMatch(/\[\s*"\$\(psql/);
  });

  it('a failed probe exits non-zero with its own message', () => {
    // The probe's exit status must be checked explicitly and be loud.
    expect(script).toMatch(/pg_is_in_recovery/);
    expect(script).toMatch(/recovery probe failed/i);
  });

  it('only a literal t skips, only a literal f proceeds, anything else fails', () => {
    // A case with an explicit catch-all that exits non-zero: unexpected
    // output (error text, empty, warnings) can never be read as "standby".
    expect(script).toMatch(/case\s+"\$REC"\s+in/);
    expect(script).toMatch(/\*\)[\s\S]{0,400}exit 1/);
  });
});

// ---------------------------------------------------------------------------
// The TLS snapshot step: after the wal-g exec, it saves the vibecarbon-tls
// Secret to the backups bucket (Task 6 restores it on a new cluster). It
// streams the Secret from kubectl straight into the db container's
// `wal-g st put -s` (which holds the bucket credentials), so the key is never
// printed and never a file on the pod. It never changes the exit code the
// backup contract (BACKUP_RESULT, exit 3, podFailurePolicy) depends on.
// ---------------------------------------------------------------------------

type CronDoc = {
  spec: {
    jobTemplate: {
      spec: {
        template: {
          spec: {
            containers: Array<{
              command: string[];
              env: Array<{
                name: string;
                valueFrom?: { configMapKeyRef?: Record<string, unknown> };
              }>;
            }>;
          };
        };
      };
    };
  };
};
const container = () =>
  (loadYaml(readFileSync(CRONJOB, 'utf-8')) as CronDoc).spec.jobTemplate.spec.template.spec
    .containers[0];
const cronScript = () => container().command[2];
const PREFIX = 's3://proj-backups/backups/proj/prod/tls/prod';
const UPLOAD = `kubectl exec -i -n vibecarbon statefulset/db -c db -- env WALG_S3_PREFIX=${PREFIX} wal-g st put -s -f --no-compress --no-encrypt k8s-secret.json`;

/** The TLS step: from after the wal-g exec to the rc-75 line. */
function tlsStep() {
  const s = cronScript();
  const start = s.indexOf("' || rc=$?");
  const end = s.indexOf('if [ "$rc" -eq 75 ]');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start + "' || rc=$?".length, end);
}

describe('backup CronJob TLS snapshot step', () => {
  it('reads TLS_SNAPSHOT_S3_PREFIX from the deploy-owned settings ConfigMap, optionally', () => {
    const ref = container().env.find((e) => e.name === 'TLS_SNAPSHOT_S3_PREFIX');
    expect(ref?.valueFrom?.configMapKeyRef).toEqual({
      name: 'vibecarbon-backup-settings',
      key: 'TLS_SNAPSHOT_S3_PREFIX',
      optional: true,
    });
  });

  it('sits after the wal-g exec and before the rc-75 line, guarded on rc 0, 3 or 75', () => {
    const step = tlsStep();
    expect(step).toContain('kubectl get secret vibecarbon-tls -n vibecarbon -o json');
    expect(step).toContain(`"${STANDBY_SELFSIGNED_ISSUER}"`);
    expect(step).toContain('cert-manager\\.io/issuer-name');
    expect(step).toContain(
      'kubectl exec -i -n vibecarbon statefulset/db -c db -- env WALG_S3_PREFIX="$TLS_SNAPSHOT_S3_PREFIX" wal-g st put -s -f --no-compress --no-encrypt k8s-secret.json',
    );
    expect(step).toMatch(/"\$rc" -eq 0 \] \|\| \[ "\$rc" -eq 3 \] \|\| \[ "\$rc" -eq 75 \]/);
    // The step never assigns rc (its own status lives in tls_rc).
    expect(step).not.toMatch(/\brc=/);
    // Both ends of the upload are bounded, the upload by the shorter one, and
    // a timeout (GNU 124, busybox 143) is a note.
    expect(step).toContain('timeout 130 kubectl get secret vibecarbon-tls -n vibecarbon -o json |');
    expect(step).toContain('timeout 120 kubectl exec -i -n vibecarbon statefulset/db');
    expect(step).toMatch(
      /"\$tls_rc" -eq 124 \] \|\| \[ "\$tls_rc" -eq 143 \][\s\S]{0,200}timed out after 120s/,
    );
  });

  it('prints only to stderr, never echoes the Secret, and carries no apostrophes', () => {
    const step = tlsStep();
    const code = step
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const line of code.split('\n').filter((l) => /\becho\b/.test(l))) {
      expect(line).toMatch(/>&2/);
      expect(line).not.toMatch(/-o json/);
    }
    expect(code).not.toContain('BACKUP_RESULT');
    expect(step).not.toContain("'");
  });

  // Run the real script with a kubectl shim: the wal-g exec exits `rc`, the
  // Secret answers from fixtures, and the upload stdin is captured.
  const work = mkdtempSync(join(tmpdir(), 'vc-cron-tls-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  function runCron({
    rc,
    prefix = PREFIX,
    issuer = 'letsencrypt-prod-cloudflare',
    secretExists = true,
  }: {
    rc: number;
    prefix?: string;
    issuer?: string;
    secretExists?: boolean;
  }) {
    const root = mkdtempSync(join(work, 'r-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'calls.log');
    writeFileSync(log, '');
    const secret = JSON.stringify({
      kind: 'Secret',
      metadata: { name: 'vibecarbon-tls', annotations: { 'cert-manager.io/issuer-name': issuer } },
      data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'S3CR3T-KEY-MATERIAL' },
    });
    writeFileSync(join(root, 'secret.json'), secret);
    writeFileSync(
      join(bin, 'kubectl'),
      `#!/bin/bash
printf '%s\\n' "kubectl $*" >> "${log}"
case "$*" in
  "exec -n vibecarbon statefulset/db -c db -- env "*) ${rc === 0 || rc === 3 ? 'echo "BACKUP_RESULT=pushed:base_1"' : ':'}; exit ${rc} ;;
  "get secret vibecarbon-tls -n vibecarbon -o jsonpath="*) ${secretExists ? `echo -n "${issuer}"` : 'echo "Error from server (NotFound)" >&2; exit 1'} ;;
  "get secret vibecarbon-tls -n vibecarbon -o json") ${secretExists ? `cat "${root}/secret.json"` : 'exit 1'} ;;
  "exec -i -n vibecarbon statefulset/db -c db -- env WALG_S3_PREFIX="*) cat > "${root}/uploaded"; echo "INFO: put ok" >&2 ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 99 ;;
esac
`,
    );
    chmodSync(join(bin, 'kubectl'), 0o755);
    const r = spawnSync('bash', ['-c', cronScript()], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        BACKUP_RETENTION_DAYS: '7',
        TLS_SNAPSHOT_S3_PREFIX: prefix,
      },
      timeout: 10_000,
    });
    const up = join(root, 'uploaded');
    return {
      code: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      calls: readFileSync(log, 'utf-8').split('\n').filter(Boolean),
      uploaded: existsSync(up) ? readFileSync(up, 'utf-8') : null,
      secret,
    };
  }
  const uploads = (r: ReturnType<typeof runCron>) => r.calls.filter((c) => c.includes('st put'));

  it.each([
    [0, true, 0],
    [3, true, 3],
    [75, true, 0],
    [1, false, 1],
  ])('wal-g exec rc %i: snapshot=%s, Job exit %i, one marker at most', (rc, snap, exit) => {
    const r = runCron({ rc });
    expect(r.code, r.stderr).toBe(exit);
    expect(uploads(r)).toEqual(snap ? [UPLOAD] : []);
    if (snap) expect(r.uploaded).toBe(r.secret);
    expect(r.stdout.match(/^BACKUP_RESULT=/gm)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(r.stdout + r.stderr).not.toContain('S3CR3T-KEY-MATERIAL');
  });

  it('a standby self-signed Secret, an unannotated one, or none: no upload, exit unchanged', () => {
    for (const r of [
      runCron({ rc: 0, issuer: STANDBY_SELFSIGNED_ISSUER }),
      runCron({ rc: 0, issuer: '' }),
      runCron({ rc: 0, secretExists: false }),
    ]) {
      expect(r.code, r.stderr).toBe(0);
      expect(uploads(r)).toEqual([]);
    }
  });

  it.each([
    ['empty', ''],
    ['not an s3 URL', 'https://x/y'],
    ['shell metacharacters', 's3://b/backups/p/e/tls/prod;id'],
  ])('a TLS_SNAPSHOT_S3_PREFIX that is %s: no kubectl get, exit unchanged', (_l, prefix) => {
    const r = runCron({ rc: 0, prefix });
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('kubectl get'))).toEqual([]);
  });
});
