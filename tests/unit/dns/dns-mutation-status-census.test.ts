/**
 * DNS mutation status census (HA-correctness Task 4, R5).
 *
 * Cloudflare's createDNSRecord used to return `response.json()` without ever
 * looking at the status, so a 401/403 printed "DNS updated" and a failover
 * carried on as if the flip had landed. The rule, for every `src/lib/*-dns.js`
 * backend: a function that sends a mutating request (POST, PUT, PATCH, DELETE)
 * must check `.ok` itself, or hand the Response to a same-file helper that
 * does, or hand the raw Response straight back to callers that all check it. This walks the source, so a new backend or a new mutating
 * function is covered the day it lands.
 *
 * It also pins the verification half: every backend exports `readARecord`,
 * the read-back that failover compares with the promoted IP.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = join(__dirname, '../../../src/lib');
const BACKENDS = readdirSync(LIB).filter((f) => f.endsWith('-dns.js'));

interface Fn {
  name: string;
  body: string;
}

/** Top-level `function` declarations: each body runs to the next declaration. */
function functionsOf(source: string): Fn[] {
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  const heads = [...source.matchAll(re)];
  return heads.map((m, i) => ({
    name: m[1],
    body: source.slice(m.index, heads[i + 1]?.index ?? source.length),
  }));
}

const MUTATING = /method:\s*'(?:POST|PUT|PATCH|DELETE)'/;
const FETCHES = /\bfetch(?:WithRetry)?\(/;

/** Mutating functions that neither check `.ok` nor are covered by checking callers. */
function unchecked(source: string): string[] {
  const fns = functionsOf(source);
  const bad: string[] = [];
  for (const fn of fns) {
    if (!FETCHES.test(fn.body) || !MUTATING.test(fn.body)) continue;
    if (/\.ok\b/.test(fn.body)) continue;
    // Delegation: the Response is handed to a same-file helper that checks it.
    const delegates = fns.some(
      (h) =>
        h !== fn &&
        /\.ok\b/.test(h.body) &&
        new RegExp(`\\b${h.name}\\(\\s*\\w*[rR]esponse\\b`).test(fn.body),
    );
    if (delegates) continue;
    const returnsRaw = /return\s+fetch(?:WithRetry)?\(/.test(fn.body);
    const callers = fns.filter((o) => o !== fn && new RegExp(`\\b${fn.name}\\(`).test(o.body));
    if (returnsRaw && callers.length > 0 && callers.every((o) => /\.ok\b/.test(o.body))) continue;
    bad.push(fn.name);
  }
  return bad;
}

describe('DNS backends check the status of every mutating request', () => {
  it('finds the backends (the walk is not vacuous)', () => {
    expect(BACKENDS.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of BACKENDS) {
    const source = readFileSync(join(LIB, file), 'utf8');

    it(`${file}: every mutating function checks .ok or delegates to callers that do`, () => {
      expect(unchecked(source)).toEqual([]);
    });

    it(`${file}: exports readARecord`, () => {
      expect(source).toMatch(/export\s+async\s+function\s+readARecord\s*\(/);
    });
  }

  it('the walk catches an unchecked mutation (self-test)', () => {
    const broken = [
      'export async function createThing(token) {',
      "  const response = await fetchWithRetry(url, { method: 'POST', body: '{}' });",
      '  return response.json();',
      '}',
    ].join('\n');
    expect(unchecked(broken)).toEqual(['createThing']);
  });
});
