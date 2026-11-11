/**
 * Census: one backups bucket per project and storage region, one resolver.
 *
 * src/lib/backups-bucket.js owns every answer about the backups bucket: the
 * deploy chooses it there (chooseBackupsBucket, then settleBackupsBucket) and
 * nothing else derives a backups name. That only holds while:
 *   (b) a backups NAME is spelled only by its definitions in s3-base.js and by
 *       backups-bucket.js: `deriveRegionBackupsBucketName(` and a
 *       `deriveProjectBucketName(` naming 'backups' appear nowhere else, and
 *       `chooseBackupsBucket(` is called only by the deploy (orchestrator.js)
 *       and backups-bucket.js itself.
 *   (c) nothing under src/ builds a backups S3 config by spreading an uploads
 *       config with the bucket swapped (`{ ...s3Config, bucket: … }`): that
 *       keeps the uploads bucket's region and endpoint, so a backups bucket in
 *       another region is asked at the wrong host. backupStorageConfig is the
 *       one way to talk to the backups bucket.
 *   (e) both sides of a k8s-ha pair use the environment's one backups bucket:
 *       src/lib/deploy/effects/k8s-ha.js spreads `...options` into each
 *       `deployK3s({` call and sets no per-side `backupTarget`, `s3Config` or
 *       `backupS3Config`; and the bucket-name-only `backupBucketName` is gone
 *       from src/ (every k8s consumer takes the whole target).
 * These walk the tree rather than list sites, so a new site is caught; the
 * bite test plants each violation in a temporary tree and proves it fails.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCANNED = ['src', 'tests/e2e'];
const S3_BASE = 'src/lib/providers/s3-base.js';
const OWNER = 'src/lib/backups-bucket.js';
const DEPLOY = 'src/lib/deploy/orchestrator.js';
const K8S_HA = 'src/lib/deploy/effects/k8s-ha.js';
const SWAPPED_BUCKET_SPREAD = /\{\s*\.\.\.[\w.?]*s3Config\s*,\s*bucket\s*:/;
const PER_SIDE_STORAGE_KEY = /(^|[{,\s])(backupTarget|s3Config|backupS3Config)\s*[:,}]/m;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(m|c)?[jt]s$/.test(full)) out.push(full);
  }
  return out;
}

/** Every scanned file under `root`, as `[relative path, text]`. */
function files(root: string): Array<[string, string]> {
  return SCANNED.flatMap((d) => walk(join(root, d))).map((f) => [
    relative(root, f),
    readFileSync(f, 'utf-8'),
  ]);
}

/** Files outside s3-base.js and backups-bucket.js that spell a backups name. */
function backupsNameOffenders(root: string): string[] {
  return files(root)
    .filter(([f]) => f !== S3_BASE && f !== OWNER)
    .filter(
      ([, text]) =>
        /deriveRegionBackupsBucketName\(/.test(text) ||
        [...text.matchAll(/deriveProjectBucketName\(([^)]*)\)/g)].some((m) =>
          /['"`]backups['"`]/.test(m[1]),
        ),
    )
    .map(([f]) => f)
    .sort();
}

/** Files other than the deploy and backups-bucket.js that call chooseBackupsBucket. */
function chooserCallers(root: string): string[] {
  return files(root)
    .filter(([f]) => f !== DEPLOY && f !== OWNER)
    .filter(([, text]) => /chooseBackupsBucket\(/.test(text))
    .map(([f]) => f)
    .sort();
}

/** Files under src/ that spread an uploads config with the bucket swapped. */
function swappedBucketSpreads(root: string): string[] {
  return files(root)
    .filter(([f]) => f.startsWith('src/'))
    .filter(([, text]) => SWAPPED_BUCKET_SPREAD.test(text))
    .map(([f]) => f)
    .sort();
}

/** Files under src/ that still name `backupBucketName`. */
function bucketNameOnlyMentions(root: string): string[] {
  return files(root)
    .filter(([f]) => f.startsWith('src/'))
    .filter(([, text]) => /backupBucketName/.test(text))
    .map(([f]) => f)
    .sort();
}

/** The argument text of every `<name>(` call in `text`, parentheses balanced. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`${name}(`, from);
    if (at === -1) return out;
    const open = at + name.length;
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    out.push(text.slice(open + 1, end));
    from = end;
  }
}

/**
 * Why each `deployK3s({` call in k8s-ha.js gives its side a storage target of
 * its own: no `...options` spread, or a per-side `backupTarget`, `s3Config` or
 * `backupS3Config` key (comments aside). Empty when both sides share options.
 */
function perSideStorageOffenders(root: string): string[] {
  const text = readFileSync(join(root, K8S_HA), 'utf-8');
  const calls = callArgs(text, 'deployK3s').map((args) => args.replace(/\/\/[^\n]*/g, ''));
  if (calls.length === 0) return ['no deployK3s({ call found'];
  return calls.flatMap((args, i) => {
    const out: string[] = [];
    if (!/\.\.\.options\b/.test(args)) out.push(`call ${i + 1} does not spread ...options`);
    const key = PER_SIDE_STORAGE_KEY.exec(args);
    if (key) out.push(`call ${i + 1} sets its own ${key[2]}`);
    return out;
  });
}

describe('backups bucket single resolver census', () => {
  it('scans the real tree (not vacuously green)', () => {
    const all = files(ROOT).map(([f]) => f);
    expect(all.length).toBeGreaterThan(50);
    expect(all).toContain(OWNER);
    expect(readFileSync(join(ROOT, OWNER), 'utf-8')).toMatch(/chooseBackupsBucket\(/);
    expect(readFileSync(join(ROOT, DEPLOY), 'utf-8')).toMatch(/chooseBackupsBucket\(/);
  });

  it('(b) only s3-base.js and backups-bucket.js spell a backups bucket name', () => {
    const offenders = backupsNameOffenders(ROOT);
    expect(
      offenders,
      `choose the backups bucket with chooseBackupsBucket and read it with backupsTargetOf (src/lib/backups-bucket.js): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(b) chooseBackupsBucket( is called only by the deploy and backups-bucket.js', () => {
    const offenders = chooserCallers(ROOT);
    expect(
      offenders,
      `the deploy chooses the backups bucket; every other command reads the record with backupsTargetOf: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(c) no src/ file spreads an uploads config with the bucket swapped', () => {
    const offenders = swappedBucketSpreads(ROOT);
    expect(
      offenders,
      `build the backups bucket's S3 config with backupStorageConfig (src/lib/backups-bucket.js), which takes its region and endpoint from the target: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(e) both k8s-ha sides take the one backups target through ...options', () => {
    expect(callArgs(readFileSync(join(ROOT, K8S_HA), 'utf-8'), 'deployK3s')).toHaveLength(2);
    expect(perSideStorageOffenders(ROOT)).toEqual([]);
  });

  it('(e) no src/ file names backupBucketName', () => {
    const offenders = bucketNameOnlyMentions(ROOT);
    expect(
      offenders,
      `pass the whole backups target (backupTarget: { bucket, region, endpoint }), never its name alone: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  describe('bite: each arm fails on a planted violation', () => {
    let tmp = '';
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = '';
    });
    const plant = (file: string, text: string) => {
      mkdirSync(dirname(join(tmp, file)), { recursive: true });
      writeFileSync(join(tmp, file), text);
    };

    it('catches a backups name derived outside the owners, and lets the owners and the app/state names be', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant(
        'src/lib/deploy/prompts.js',
        "const b = deriveProjectBucketName(projectConfig, 'backups');\n",
      );
      plant('tests/e2e/checks/x.ts', "const r = deriveRegionBackupsBucketName(project, 'fsn1');\n");
      plant('src/lib/other.js', "const s = deriveProjectBucketName(projectConfig, 'storage');\n");
      plant(OWNER, "deriveProjectBucketName(projectConfig, 'backups');\n");
      plant(S3_BASE, "deriveProjectBucketName(projectConfig, 'backups');\n");
      expect(backupsNameOffenders(tmp)).toEqual([
        'src/lib/deploy/prompts.js',
        'tests/e2e/checks/x.ts',
      ]);
    });

    it('catches a swapped-bucket spread under src/, whatever the config is called', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant(
        'src/a.js',
        'snapshot({ s3Config: { ...s3Config, bucket: backupS3Config?.bucket } });\n',
      );
      plant('src/b.js', 'restore({ s3Config: { ...ctx.s3Config, bucket: ctx.backup.bucket } });\n');
      plant('src/c.js', 'const cfg = s3Config ? { ...s3Config,\n  bucket: name } : null;\n');
      // The one builder, and a spread that keeps the bucket, are fine.
      plant('src/d.js', 'const cfg = backupStorageConfig(s3Config, backupTarget);\n');
      plant('src/e.js', 'const cfg = { ...s3Config, region };\n');
      plant('tests/e2e/x.ts', 'const cfg = { ...s3Config, bucket: other };\n');
      expect(swappedBucketSpreads(tmp)).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
    });

    it('catches a k8s-ha side with its own storage target, and backupBucketName anywhere in src/', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      const side = (extra: string) =>
        `deployK3s({\n  ...options,\n  // backupTarget: comes from options\n  role: 'x',${extra}\n})`;
      plant(K8S_HA, `${side('')}\n${side('')}\n`);
      expect(perSideStorageOffenders(tmp)).toEqual([]);
      plant(K8S_HA, `${side('')}\n${side('\n  backupTarget: null,')}\n`);
      expect(perSideStorageOffenders(tmp)).toEqual(['call 2 sets its own backupTarget']);
      plant(K8S_HA, `${side('\n  s3Config,')}\n${side('')}\n`);
      expect(perSideStorageOffenders(tmp)).toEqual(['call 1 sets its own s3Config']);
      plant(K8S_HA, `${side('\n  backupS3Config: x,')}\ndeployK3s({ role: 'standby' })\n`);
      expect(perSideStorageOffenders(tmp)).toEqual([
        'call 1 sets its own backupS3Config',
        'call 2 does not spread ...options',
      ]);
      plant('src/lib/deploy/k8s/k3s.js', 'buildInfraSecretData({ backupBucketName });\n');
      plant('tests/unit/x.test.ts', 'backupBucketName: null,\n');
      expect(bucketNameOnlyMentions(tmp)).toEqual(['src/lib/deploy/k8s/k3s.js']);
    });

    it('catches a chooser call outside the deploy', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant('src/restore.js', 'const plan = chooseBackupsBucket({ environment });\n');
      plant(DEPLOY, 'const plan = chooseBackupsBucket({ environment });\n');
      expect(chooserCallers(tmp)).toEqual(['src/restore.js']);
    });
  });
});
