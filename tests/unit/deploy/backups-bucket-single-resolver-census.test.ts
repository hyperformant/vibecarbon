/**
 * Census: one backups bucket per project and storage region, one resolver.
 *
 * src/lib/backups-bucket.js owns every answer about the backups bucket: the
 * deploy chooses it there (chooseBackupsBucket, then settleBackupsBucket),
 * every other command reads it through backupsTargetOf, and nothing else
 * derives a backups name. That only holds while:
 *   (a) nothing under src/ or tests/e2e/ but backups-bucket.js reads the
 *       record field itself (`.backupS3`, `['backupS3']`, or a destructuring
 *       `const { backupS3 } = envConfig`, at any depth of an object or array
 *       pattern, assigned or bound by a for-of or for-in head such as
 *       `for (const [name, { backupS3 }] of envs)`): restore, backup, status, destroy,
 *       failover, scale, configure and the e2e checks all take the bucket, its
 *       region and its endpoint from backupsTargetOf, so an old record without
 *       a region or endpoint means one thing everywhere. Writers use the
 *       `backupS3:` key and env-identity.js lists the field name; neither
 *       matches. env-identity.js's one destructuring of the field is allowed
 *       by its exact pattern (DESTRUCTURE_ALLOWED says why). Function
 *       parameters are not checked (scale.js's option `{ backupS3 = null }`
 *       is a resolved config, not the record), except a first parameter with
 *       a default, which reads like an assignment. Comment lines are not code
 *       and are skipped.
 *   (b) a backups NAME is spelled only by its definitions in s3-base.js and by
 *       backups-bucket.js: `deriveRegionBackupsBucketName(` and a
 *       `deriveProjectBucketName(` naming 'backups' appear nowhere else, and
 *       `chooseBackupsBucket(` is called only by the deploy (orchestrator.js)
 *       and backups-bucket.js itself.
 *   (c) nothing under src/ builds a backups S3 config by spreading an uploads
 *       config with the bucket swapped: an object literal with a
 *       `...s3Config` spread anywhere in it and a `bucket` key (or the
 *       shorthand `bucket`) at its own level after the spread, past any
 *       nested-brace value. That keeps the uploads bucket's region and
 *       endpoint, so a backups bucket in another region is asked at the wrong
 *       host. backupStorageConfig is the one way to talk to the backups bucket.
 *   (d) `loadBackupS3Config`, the old raw reader of the record, is gone from
 *       src/ and tests/ for good.
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
const CENSUS = 'tests/unit/deploy/backups-bucket-single-resolver-census.test.ts';
const RAW_RECORD_READ = /\.backupS3\b|\[\s*['"]backupS3['"]\s*\]/;
// The record field as a key of a destructuring pattern, at any depth; a
// binding named like it (`{ bucket: backupS3 }`) follows a `:` and is not one.
const RECORD_KEY_IN_PATTERN = /[{,]\s*backupS3\s*[:,}=]/;
/** The one destructuring of the record field allowed outside backups-bucket.js. */
const DESTRUCTURE_ALLOWED = [
  {
    file: 'src/lib/env-identity.js',
    pattern: /^\{\s*backupS3:\s*_purged,\s*\.\.\.kept\s*\}$/,
    why: 'resolveEnvSeed takes the field out of a purged seed by name, so the rebuild chooses its bucket as a new environment would; it drops the record and never reads where the backups are',
  },
];
// An uploads config spread into an object literal (`...s3Config`,
// `...ctx.s3Config`); swappedBucketSpreads checks the keys after it.
const UPLOADS_SPREAD = /\.\.\.[\w.?]*s3Config\b/g;
// Arm (d) skips this file, which names the reader in its header.
const OLD_READER = 'loadBackupS3Config';
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
function files(root: string, dirs: string[] = SCANNED): Array<[string, string]> {
  return dirs
    .flatMap((d) => walk(join(root, d)))
    .map((f) => [relative(root, f), readFileSync(f, 'utf-8')]);
}

/** The text without its comment-only lines (JSDoc, block and line comments). */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/** The text from the `{` or `[` at `open` through its matching close, both kinds balanced. */
function balancedBrackets(text: string, open: number): string {
  let depth = 0;
  let end = open;
  for (; end < text.length; end++) {
    if (text[end] === '{' || text[end] === '[') depth++;
    else if ((text[end] === '}' || text[end] === ']') && --depth === 0) break;
  }
  return text.slice(open, end + 1);
}

/**
 * Every object or array destructuring pattern in `code` that binds from
 * something: `const|let|var { … } = …` and `({ … } = …)`, and a loop head's
 * `for (const { … } of …)` or `for (const [k, { … }] in …)` (also a bare
 * `for ({ … } of …)`), brackets balanced. A call's object argument and an
 * arrow's parameter are followed by `)`, so neither counts.
 */
function destructuringPatterns(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:\b(const|let|var)\s*|\(\s*)[{[]/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const pattern = balancedBrackets(code, open);
    const after = code.slice(open + pattern.length);
    const assigned = /^\s*=(?![=>])/.test(after);
    const looped = /^\s+of\b/.test(after) || (m[1] !== undefined && /^\s+in\b/.test(after));
    if (assigned || looped) out.push(pattern);
  }
  return out;
}

/** Does `code` destructure the record field, other than the allowed drop in `file`? */
function destructuresRecord(file: string, code: string): boolean {
  return destructuringPatterns(code).some(
    (pattern) =>
      RECORD_KEY_IN_PATTERN.test(pattern) &&
      !DESTRUCTURE_ALLOWED.some((a) => a.file === file && a.pattern.test(pattern)),
  );
}

/** Files under src/ or tests/e2e/, other than backups-bucket.js, that read the record field. */
function rawRecordReaders(root: string): string[] {
  return files(root)
    .filter(([f]) => f !== OWNER)
    .filter(([f, text]) => {
      const code = codeLines(text);
      return RAW_RECORD_READ.test(code) || destructuresRecord(f, code);
    })
    .map(([f]) => f)
    .sort();
}

/** Files under src/ or tests/ that still name the old raw reader. */
function oldReaderMentions(root: string): string[] {
  return files(root, ['src', 'tests'])
    .filter(([f]) => f !== CENSUS)
    .filter(([, text]) => text.includes(OLD_READER))
    .map(([f]) => f)
    .sort();
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

/** An entry of an object literal that sets `bucket` (`bucket: …`, or the shorthand). */
const isBucketKey = (entry: string) =>
  /^\s*['"]?bucket['"]?\s*(:|$)/.test(entry.replace(/\/\/[^\n]*/g, ''));

/**
 * Does an object literal in `code` spread an uploads config and then set
 * `bucket` at its own level? The literal is the nearest unclosed `{` before
 * the spread (a `(` or `[` first means a call or an array, no object). Its
 * entries after the spread are split at its own commas; a nested value's
 * braces, brackets and parentheses are skipped whole, so a `bucket` inside
 * `appKey: { bucket }` is that object's, and a `bucket` after such a value is
 * still seen.
 */
function hasSwappedBucketSpread(code: string): boolean {
  for (const m of code.matchAll(UPLOADS_SPREAD)) {
    const at = m.index ?? 0;
    let depth = 0;
    let inObject = false;
    for (let i = at - 1; i >= 0; i--) {
      const ch = code[i];
      if (ch === '}' || ch === ')' || ch === ']') depth++;
      else if (ch === '{' || ch === '(' || ch === '[') {
        if (depth === 0) {
          inObject = ch === '{';
          break;
        }
        depth--;
      }
    }
    if (!inObject) continue;
    let level = 0;
    let entry = '';
    for (let i = at + m[0].length; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{' || ch === '(' || ch === '[') {
        level++;
        continue;
      }
      if (ch === '}' || ch === ')' || ch === ']') {
        if (level === 0) {
          if (isBucketKey(entry)) return true;
          break;
        }
        level--;
        continue;
      }
      if (level > 0) continue;
      if (ch === ',') {
        if (isBucketKey(entry)) return true;
        entry = '';
      } else {
        entry += ch;
      }
    }
  }
  return false;
}

/** Files under src/ that spread an uploads config with the bucket swapped. */
function swappedBucketSpreads(root: string): string[] {
  return files(root)
    .filter(([f]) => f.startsWith('src/'))
    .filter(([, text]) => hasSwappedBucketSpread(codeLines(text)))
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

  it('(a) only backups-bucket.js reads the backupS3 record; everything else asks backupsTargetOf', () => {
    const offenders = rawRecordReaders(ROOT);
    expect(
      offenders,
      `read the backups bucket with backupsTargetOf(envConfig) (src/lib/backups-bucket.js): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(d) the old raw reader is gone from src/ and tests/', () => {
    const offenders = oldReaderMentions(ROOT);
    expect(
      offenders,
      `read the backups bucket with backupsTargetOf (src/lib/backups-bucket.js): ${offenders.join(', ')}`,
    ).toEqual([]);
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
      // The shorthand, and a bucket that is not the key right after the spread.
      plant('src/f.js', 'const bucket = backup.bucket;\nread({ ...s3Config, bucket });\n');
      plant('src/g.js', 'read({ ...ctx.s3Config, region: r,\n  bucket: b });\n');
      plant('src/h.js', 'read({ ...s3Config, endpoint, bucket, region });\n');
      // A spread that is not first, a bucket after a nested-brace value, and
      // one after a second spread.
      plant('src/l.js', 'read({ region, ...s3Config, bucket });\n');
      plant('src/m.js', 'read({ ...s3Config, appKey: { id: k }, bucket: b });\n');
      plant(
        'src/n.js',
        'read({\n  ...base,\n  ...ctx.s3Config,\n  retry: { n: 1 },\n  bucket,\n});\n',
      );
      // The one builder, a spread that keeps the bucket, a nested object's
      // bucket, look-alike keys, a comment, and tests/e2e are fine.
      plant('src/d.js', 'const cfg = backupStorageConfig(s3Config, backupTarget);\n');
      plant('src/e.js', 'const cfg = { ...s3Config, region };\n');
      plant('src/i.js', 'const cfg = { ...s3Config, appKey: { bucket: b } };\n');
      plant('src/j.js', 'const cfg = { ...s3Config, stateBucket: s, bucketPin: p };\n');
      plant('src/k.js', '/**\n * never `{ ...s3Config, bucket }`\n */\nexport const x = 1;\n');
      plant('tests/e2e/x.ts', 'const cfg = { ...s3Config, bucket: other };\n');
      // A bucket set before the spread is overwritten by it, a spread into a
      // call or an array is no object's, and a nested object's spread keeps
      // its own keys.
      plant('src/o.js', 'const cfg = { bucket: b, ...s3Config, region };\n');
      plant('src/p.js', 'log(...s3Config, bucket);\nconst a = [...s3Configs, bucket];\n');
      plant('src/q.js', 'const cfg = { outer: { ...s3Config, region }, bucket: b };\n');
      expect(swappedBucketSpreads(tmp)).toEqual([
        'src/a.js',
        'src/b.js',
        'src/c.js',
        'src/f.js',
        'src/g.js',
        'src/h.js',
        'src/l.js',
        'src/m.js',
        'src/n.js',
      ]);
    });

    it('catches a raw read of the backupS3 record outside backups-bucket.js, and lets writers and comments be', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant('src/destroy.js', "const region = envConfig.backupS3.region || 'fsn1';\n");
      plant('src/lib/x.js', 'const b = e?.backupS3?.bucket;\n');
      plant('src/lib/y.js', "const b = env['backupS3'].bucket;\n");
      plant('tests/e2e/checks/z.ts', 'const t = config.environments?.[env]?.backupS3;\n');
      // The owner, a writer's key, the identity field list, a comment, a
      // variable named like the field, and tests/unit are fine.
      plant(OWNER, 'const record = envConfig?.backupS3;\n');
      plant('src/lib/w.js', 'save({ backupS3: target, backupS3Config });\n');
      plant('src/lib/env-identity.js', "export const F = ['s3', 'backupS3'];\n");
      plant(
        'src/lib/v.js',
        '// reads environments.<env>.backupS3\nconst a = ctx.backupS3Config;\n',
      );
      plant('tests/unit/a.test.ts', 'expect(env.backupS3).toEqual(x);\n');
      expect(rawRecordReaders(tmp)).toEqual([
        'src/destroy.js',
        'src/lib/x.js',
        'src/lib/y.js',
        'tests/e2e/checks/z.ts',
      ]);
    });

    it('catches the record destructured out of an object, and lets env-identity drop it by name', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant('src/lib/a.js', 'const { backupS3 } = envConfig;\n');
      plant('src/lib/b.js', 'const {\n  s3,\n  backupS3: record,\n} = env;\n');
      plant('src/lib/c.js', 'let record;\n({ backupS3: record } = cfg);\n');
      plant('src/lib/d.js', 'const { s3: { region }, backupS3 } = env;\n');
      plant('tests/e2e/checks/e.ts', 'let { backupS3 = null } = env;\n');
      // A loop head binds from each element just as an assignment does.
      plant('src/lib/i.js', 'for (const { backupS3 } of envs) use(backupS3);\n');
      plant(
        'src/lib/j.js',
        'for (const [name, { backupS3: b }] of Object.entries(environments)) {}\n',
      );
      plant('src/lib/k.js', 'for (let [, { s3, backupS3 }] in all) {}\n');
      plant('src/lib/l.js', 'let e;\nfor ({ backupS3: e } of envs) {}\n');
      plant('src/lib/m.js', 'const [first, { backupS3 }] = list;\n');
      // env-identity drops the field from a purged seed by name; a writer, a
      // look-alike name, an arrow's parameter and tests/unit are fine.
      plant('src/lib/env-identity.js', 'const { backupS3: _purged, ...kept } = identity;\n');
      plant('src/lib/f.js', 'save({ backupS3: target });\nprepare(ctx, { backupS3 });\n');
      plant('src/lib/g.js', 'const { backupS3Config } = ctx;\n');
      plant('src/lib/h.js', 'const pick = ({ backupS3 }) => backupS3;\n');
      plant('tests/unit/a.test.ts', 'const { backupS3 } = env;\n');
      plant('src/lib/n.js', 'for (const [name, e] of envs) use(name, e);\n');
      plant('src/lib/o.js', 'for (const backupS3Config of configs) {}\n');
      // An array argument and an `in` test outside a loop head bind nothing.
      plant('src/lib/p.js', 'run([{ backupS3 }]);\nconst seen = ([{ backupS3 }] in index);\n');
      expect(rawRecordReaders(tmp)).toEqual([
        'src/lib/a.js',
        'src/lib/b.js',
        'src/lib/c.js',
        'src/lib/d.js',
        'src/lib/i.js',
        'src/lib/j.js',
        'src/lib/k.js',
        'src/lib/l.js',
        'src/lib/m.js',
        'tests/e2e/checks/e.ts',
      ]);
      // The allowance is that one drop, not the file.
      plant(
        'src/lib/env-identity.js',
        'const { backupS3: _purged, ...kept } = identity;\nconst { backupS3 } = live;\n',
      );
      expect(rawRecordReaders(tmp)).toContain('src/lib/env-identity.js');
    });

    it('catches the old raw reader anywhere in src/ or tests/', () => {
      tmp = mkdtempSync(join(tmpdir(), 'backups-census-'));
      plant('src/lib/config.js', `export function ${OLD_READER}(envName) {}\n`);
      plant('tests/unit/restore/x.test.ts', `vi.mock('config.js', () => ({ ${OLD_READER} }));\n`);
      plant('src/lib/other.js', 'loadS3Config(envName);\n');
      plant(CENSUS, `// hunts ${OLD_READER}\n`);
      expect(oldReaderMentions(tmp)).toEqual(['src/lib/config.js', 'tests/unit/restore/x.test.ts']);
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
