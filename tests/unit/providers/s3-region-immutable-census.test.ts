/**
 * Census: an object-storage client never changes region after construction.
 *
 * createBucket used to move its instance (`this.region`, `this.endpoint`,
 * `this._client = null`) to wherever an existing bucket of that name lived.
 * The deploy shares one instance across the app, backups and state buckets,
 * so the backups bucket's answer moved the app bucket's recorded region: a
 * second environment in fsn1, after the first in nbg1, recorded its fsn1
 * uploads bucket as nbg1 and its uploads broke. A bucket in another region is
 * now reached through `forRegion()`, and each create reports its own region.
 *
 *   (a) in s3-base.js, `this.region =`, `this.endpoint =` and
 *       `this._client = null` each occur exactly once, inside the
 *       constructor body;
 *   (b) no file under src/ reads `s3Provider.region` or `s3Provider.endpoint`
 *       (a bucket's region comes from its own create result);
 *   (c) no file under src/ other than s3-base.js resets a `._client`.
 * These walk the tree rather than list sites, so a new site is caught.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const S3_BASE = 'src/lib/providers/s3-base.js';

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

/** [start, end) of the `constructor(` body of the S3CompatibleProvider class. */
function constructorBody(source: string): [number, number] {
  const classAt = source.indexOf('export class S3CompatibleProvider');
  expect(classAt, 'S3CompatibleProvider class').toBeGreaterThan(-1);
  const ctorAt = source.indexOf('constructor(', classAt);
  expect(ctorAt, 'its constructor').toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf(')', ctorAt));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error('unbalanced constructor body');
}

describe('S3 client region immutability census', () => {
  it('(a) region, endpoint and the client are set once, in the constructor', () => {
    const source = readFileSync(join(ROOT, S3_BASE), 'utf-8');
    const [start, end] = constructorBody(source);
    const patterns: Array<[string, RegExp]> = [
      ['this.region =', /this\.region\s*=(?!=)/g],
      ['this.endpoint =', /this\.endpoint\s*=(?!=)/g],
      ['this._client = null', /this\._client\s*=\s*null/g],
    ];
    for (const [label, re] of patterns) {
      const hits = [...source.matchAll(re)].map((m) => m.index as number);
      expect(hits.length, `${label} must occur exactly once in ${S3_BASE}`).toBe(1);
      expect(
        hits[0] >= start && hits[0] < end,
        `${label} must sit in the constructor body, not after construction`,
      ).toBe(true);
    }
  });

  it('(b) nothing under src/ reads s3Provider.region or s3Provider.endpoint', () => {
    expect(srcFiles.length).toBeGreaterThan(50);
    const offenders = srcFiles
      .filter((f) => /\bs3Provider\.(region|endpoint)\b/.test(readFileSync(f, 'utf-8')))
      .map(rel);
    expect(
      offenders,
      `take a bucket's region from its own createBucket result: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('(c) only s3-base.js resets an S3 client', () => {
    const offenders = srcFiles
      .filter((f) => /\._client\s*=\s*null/.test(readFileSync(f, 'utf-8')))
      .map(rel)
      .filter((f) => f !== S3_BASE);
    expect(offenders, `an S3 client is reset only by its own constructor`).toEqual([]);
  });
});
