/**
 * Every GetObjectCommand result must consume or destroy its Body. An unread
 * response stream pins its socket and holds the event loop open, so on
 * providers that keep idle connections (Linode) the CLI never exits.
 * Source-shape walk: each file that builds a GetObjectCommand must also
 * consume `.Body` in the same function.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');
const CONSUMERS =
  /transformTo(String|ByteArray|WebStream)|\.pipe\(|\.destroy\??\.?\(|bodyText\(|for await/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.js') ? [f] : [];
  });
}

/** Text of the enclosing function: from the nearest preceding function header to the next one. */
function enclosing(src: string, idx: number): string {
  const header = /(^|\n)\s*(export\s+)?(async\s+)?(function\b|[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{)/g;
  const starts: number[] = [];
  for (let m = header.exec(src); m; m = header.exec(src)) starts.push(m.index);
  const start = Math.max(0, ...starts.filter((s) => s <= idx));
  const end = Math.min(src.length, ...starts.filter((s) => s > idx), src.length);
  return src.slice(start, end);
}

describe('GetObjectCommand body census', () => {
  it('every new GetObjectCommand( sits in a function that consumes .Body', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new GetObjectCommand\(/g)) {
        seen++;
        if (!CONSUMERS.test(enclosing(src, m.index ?? 0))) offenders.push(f.replace(SRC, 'src'));
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
