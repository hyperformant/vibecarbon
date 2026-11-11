/**
 * Census: only a delete that `destroy -purge` confirmed writes
 * `appBucketPurged`.
 *
 * The app key fence skips a destroyed record's app bucket for good once the
 * record carries `appBucketPurged`. So the mark must mean "this CLI deleted
 * it", never "a lookup did not find it": a region missing from the lookup, or
 * a NoSuchBucket for a bucket that exists, would end that bucket's fence. A
 * bucket the fence finds in no region gets `appBucketNotFound` instead, which
 * never takes it out of the fence.
 *
 *   (a) every write of `appBucketPurged` under src/ (an assignment, an object
 *       key with a value, or a shorthand key) is one of the two in
 *       src/destroy.js: the flag set in deleteAppBucketEffect and the record
 *       key it becomes;
 *   (b) the flag is set only inside deleteAppBucketEffect's `result.deleted`
 *       branch: not for an emptied shell, not for a bucket not found;
 *   (c) the record key is written only from that flag.
 * The tree is walked rather than a list of sites, so a new writer is caught.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DESTROY = 'src/destroy.js';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Block comments and whole-line comments blanked, offsets kept. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

const WRITES = [
  // results.appBucketPurged = true (not ==, ===, or =>)
  /\bappBucketPurged\s*=(?![=>])/g,
  // { appBucketPurged: true }, but not a destructuring rename to `_name`
  /\bappBucketPurged\s*:(?!\s*_)/g,
  // { ...x, appBucketPurged }
  /[{,]\s*appBucketPurged\s*[,}]/g,
];

function writesIn(file: string) {
  const text = code(readFileSync(file, 'utf-8'));
  const hits: { file: string; at: number; text: string }[] = [];
  for (const re of WRITES) {
    for (const m of text.matchAll(re)) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const lineEnd = text.indexOf('\n', m.index);
      hits.push({
        file: relative(ROOT, file),
        at: m.index ?? 0,
        text: text.slice(lineStart, lineEnd).trim(),
      });
    }
  }
  return hits;
}

/** [start, end) of `async function <name>(` up to the next top-level function. */
function functionSlice(source: string, name: string): [number, number] {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n(?:async )?function |\nexport /);
  return [start, next === -1 ? source.length : start + 1 + next];
}

describe('appBucketPurged writer census', () => {
  const all = walk(join(ROOT, 'src')).flatMap(writesIn);

  it('(a) only destroy.js writes it, in exactly two places', () => {
    expect(all.map((h) => `${h.file}: ${h.text}`)).toEqual([
      `${DESTROY}: results.appBucketPurged = true;`,
      `${DESTROY}: ...(results.appBucketPurged && { appBucketPurged: true }),`,
    ]);
  });

  it("(b) the flag is set only in deleteAppBucketEffect's confirmed-delete branch", () => {
    const source = code(readFileSync(join(ROOT, DESTROY), 'utf-8'));
    const [start, end] = functionSlice(source, 'deleteAppBucketEffect');
    const body = source.slice(start, end);
    const deleted = body.indexOf('if (result.deleted) {');
    const shell = body.indexOf('} else if (result.shellDeferred) {');
    expect(deleted, 'the deleted branch').toBeGreaterThan(-1);
    expect(shell, 'the shell branch after it').toBeGreaterThan(deleted);
    const flag = all.find((h) => h.text.startsWith('results.appBucketPurged ='));
    expect(flag, 'the flag write').toBeDefined();
    const at = (flag?.at ?? -1) - start;
    expect(at).toBeGreaterThan(deleted);
    expect(at).toBeLessThan(shell);
  });

  it('(c) the record key comes only from that flag', () => {
    const record = all.find((h) => h.text.includes('{ appBucketPurged: true }'));
    expect(record?.text).toBe('...(results.appBucketPurged && { appBucketPurged: true }),');
  });
});
