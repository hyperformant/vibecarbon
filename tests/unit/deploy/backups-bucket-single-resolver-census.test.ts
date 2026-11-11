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

    it('catches a chooser call outside the deploy', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant('src/restore.js', 'const plan = chooseBackupsBucket({ environment });\n');
      plant(DEPLOY, 'const plan = chooseBackupsBucket({ environment });\n');
      expect(chooserCallers(tmp)).toEqual(['src/restore.js']);
    });
  });
});
