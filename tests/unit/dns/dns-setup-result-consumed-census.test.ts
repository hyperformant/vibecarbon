/**
 * Every caller of a DNS backend's setupSimple / setupHA consumes the result
 * (HA-correctness Task 4, R5).
 *
 * Those functions never throw: a refused record write returns
 * `{ success: false, error }`. Four deploy paths used to `await` the call and
 * print "DNS A record set" regardless. This walks all of src/ for callers
 * (including aliases such as `{ setupSimple: updateDnsIp }`) and requires each
 * call's value to be assigned, returned or wrapped in requireDnsSetup, in a
 * file that actually inspects the outcome. createDNSRecord is not in the walk:
 * it throws on a refusal (dns-mutation-status-census), so a bare await is safe.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });
}

/** Local names bound to setupSimple / setupHA by destructuring or import. */
function aliasesOf(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\b(setupSimple|setupHA)\s*:\s*(\w+)/g)) names.add(m[2]);
  for (const m of source.matchAll(/\{[^{}]*\}\s*=\s*(?:await\s+)?getDnsProvider/g)) {
    for (const n of m[0].matchAll(/\b(setupSimple|setupHA)\b(?!\s*:)/g)) names.add(n[1]);
  }
  return [...names];
}

/** Calls whose value is dropped: the statement before the call binds nothing. */
function unconsumed(source: string): string[] {
  const bad: string[] = [];
  for (const name of aliasesOf(source)) {
    for (const m of source.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'g'))) {
      const before = source.slice(0, m.index);
      const boundary = Math.max(
        before.lastIndexOf(';\n'),
        before.lastIndexOf('{\n'),
        before.lastIndexOf('}\n'),
      );
      const statement = before.slice(boundary + 1);
      // The destructuring that introduces the alias is not a call.
      if (/^\s*(?:const|let)\s*\{/.test(statement) && !statement.includes('=>')) continue;
      if (!/(=(?!>)|\breturn\b|requireDnsSetup\()/.test(statement)) bad.push(name);
    }
  }
  return bad;
}

const inspects = (source: string) => /requireDnsSetup\(|\.success\b/.test(source);

describe('DNS setup results are consumed', () => {
  const callers = walk(SRC)
    .filter((f) => !/-dns\.js$/.test(f))
    .map((f) => ({ file: relative(SRC, f), source: readFileSync(f, 'utf8') }))
    .filter(({ source }) => aliasesOf(source).length > 0);

  it('finds the deploy-path callers (the walk is not vacuous)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  for (const { file, source } of callers) {
    it(`${file}: every call keeps its result and the file inspects it`, () => {
      expect(unconsumed(source)).toEqual([]);
      expect(inspects(source)).toBe(true);
    });
  }

  it('the walk catches a dropped result (self-test)', () => {
    const broken = [
      'const { setupSimple: updateDnsIp } = await getDnsProvider(p);',
      'await updateDnsIp(token, zone, domain, ip);',
      "dnsSpinner.stop('DNS A record set');",
    ].join('\n');
    expect(unconsumed(broken)).toEqual(['updateDnsIp']);
  });
});
