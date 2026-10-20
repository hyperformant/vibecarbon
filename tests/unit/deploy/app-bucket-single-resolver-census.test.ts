/**
 * Census: one app bucket per environment, one resolver.
 *
 * Each environment of a project has its own long-lived app bucket, and its
 * objects sit at that bucket's root. That only holds while:
 *   (a) the bucket NAME is derived in one place and read through
 *       resolveEnvStorage, so no site re-derives a different name;
 *   (b) the compose writer of the app S3_BUCKET also hands it VC_ENV (compose's
 *       WAL-G prefix reads it), the k8s writer does not (nothing in k8s reads
 *       it), and nothing deployed, the template app or the e2e checks knows
 *       an object key prefix (S3_KEY_PREFIX / keyPrefix, removed by design);
 *   (c) no CORS rule is merged across environments;
 *   (d) every WAL-G prefix carries an env segment, so two envs never share a
 *       backup chain (the documented exception: local dev's empty string);
 *   (e) nothing reads the retired storageBucketGeneration key.
 * These walk the tree rather than list sites, so a new site is caught.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const rel = (f: string) => relative(ROOT, f);
const srcFiles = walk(join(ROOT, 'src'), (f) => f.endsWith('.js'));

describe('app bucket single resolver census', () => {
  it('(a) deriveEnvAppBucketName( is called only from s3-base.js, prompts.js and destroy.js', () => {
    const allowed = new Set([
      'src/lib/providers/s3-base.js',
      'src/lib/deploy/prompts.js',
      'src/destroy.js',
    ]);
    expect(srcFiles.length).toBeGreaterThan(50);
    const offenders = srcFiles
      .filter((f) => /deriveEnvAppBucketName\(/.test(readFileSync(f, 'utf-8')))
      .map(rel)
      .filter((f) => !allowed.has(f));
    expect(
      offenders,
      `read the app bucket through resolveEnvStorage, not deriveEnvAppBucketName: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(a) deriveProjectBucketName( is limited to the backups and state derivations', () => {
    const allowed = new Set(['src/lib/providers/s3-base.js', 'src/lib/deploy/prompts.js']);
    const offenders = srcFiles
      .filter((f) => /deriveProjectBucketName\(/.test(readFileSync(f, 'utf-8')))
      .map(rel)
      .filter((f) => !allowed.has(f));
    expect(
      offenders,
      `read the app bucket through resolveEnvStorage: ${offenders.join(', ')}`,
    ).toEqual([]);
    // prompts.js may derive only the backups bucket; the app bucket never
    // comes from the per-project derivation.
    const prompts = readFileSync(join(ROOT, 'src/lib/deploy/prompts.js'), 'utf-8');
    const calls = [...prompts.matchAll(/deriveProjectBucketName\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.filter((c) => !/'backups'/.test(c))).toEqual([]);
  });

  it('(b) the compose S3_BUCKET writer assigns VC_ENV, the k8s one does not', () => {
    const assignsBucket = /S3_BUCKET\s*[=:]|\.S3_BUCKET\s*=/;
    const assignsEnv = /\.VC_ENV\s*=/;
    const writers = srcFiles
      .filter((f) => assignsBucket.test(readFileSync(f, 'utf-8')))
      // create.js writes the local-dev .env, which has no deployed environment.
      .filter((f) => rel(f) !== 'src/create.js');
    expect(writers.map(rel).sort()).toEqual([
      'src/lib/deploy/bundle.js',
      'src/lib/deploy/k8s/k3s.js',
    ]);
    const read = (r: string) => readFileSync(join(ROOT, r), 'utf-8');
    // compose's WALG_S3_PREFIX reads ${VC_ENV}.
    expect(read('src/lib/deploy/bundle.js')).toMatch(assignsEnv);
    // k8s renders its WAL-G prefix from walgPrefix and nothing there reads
    // VC_ENV, so the Secret must not carry a dead (in k8s-ha, wrong) value.
    expect(read('src/lib/deploy/k8s/k3s.js')).not.toMatch(assignsEnv);
    const k8sReaders = walk(join(ROOT, 'carbon/k8s'), () => true)
      .filter((f) => readFileSync(f, 'utf-8').includes('VC_ENV'))
      .map(rel);
    expect(k8sReaders, `carbon/k8s now reads VC_ENV: ${k8sReaders.join(', ')}`).toEqual([]);
  });

  it('(b) no object key prefix survives in src/, the template app or the e2e checks', () => {
    const files = [
      ...srcFiles,
      ...walk(join(ROOT, 'carbon/src'), (f) => /\.tsx?$/.test(f)),
      join(ROOT, 'carbon/.env.example'),
      ...walk(join(ROOT, 'tests/e2e'), (f) => f.endsWith('.ts')),
    ];
    const offenders = files
      .filter((f) => /S3_KEY_PREFIX|keyPrefix/.test(readFileSync(f, 'utf-8')))
      .map(rel);
    expect(
      offenders,
      `an object key prefix is still read or written: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(c) no CORS merge across environments survives in src/', () => {
    const offenders = srcFiles
      .filter((f) => /corsOrigins|mergeCorsOrigins/.test(readFileSync(f, 'utf-8')))
      .map(rel);
    expect(
      offenders,
      `the bucket has one owner env, so its CORS rule is never merged: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(d) every WALG_S3_PREFIX construction has an env segment, except the empty dev override', () => {
    const files = [
      ...srcFiles,
      ...walk(join(ROOT, 'carbon'), (f) => /docker-compose[^/]*\.yml$/.test(f)),
      ...walk(join(ROOT, 'carbon/k8s'), (f) => /\.ya?ml$/.test(f)),
    ];
    const assignment = /^\s*(?:export\s+)?["']?WALG_S3_PREFIX["']?\s*[:=]\s*(\S.*)$/;
    const seen: string[] = [];
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        const m = assignment.exec(line);
        if (!m || line.trimStart().startsWith('#')) continue;
        const value = m[1].trim();
        seen.push(`${rel(f)}:${i + 1}`);
        if (value === '""' || value === "''") continue;
        if (!/walgPrefix|VC_ENV/.test(value)) offenders.push(`${rel(f)}:${i + 1}: ${value}`);
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(offenders, `WALG_S3_PREFIX without an env segment: ${offenders.join('; ')}`).toEqual([]);
  });

  it('(e) no file under src/ mentions storageBucketGeneration', () => {
    const offenders = srcFiles
      .filter((f) => readFileSync(f, 'utf-8').includes('storageBucketGeneration'))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
