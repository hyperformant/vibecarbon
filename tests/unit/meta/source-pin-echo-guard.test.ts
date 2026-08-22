import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CENSUS — no unit test may pin a provider-facing VALUE by echoing the
 * product's own source text.
 *
 * THE DEFECT THIS EXISTS FOR. `scaleway-compose.js` shipped
 * `volumeType: 'sbsVolume'` — Pulumi camelCases property NAMES
 * (`volume_type` -> `volumeType`) but passes enum VALUES through untouched, so
 * the correct literal was `sbs_volume`. Every Scaleway provision failed at the
 * API. The unit test was GREEN throughout, because it asserted:
 *
 *     expect(programSource).toContain("volumeType: 'sbsVolume'")
 *
 * That assertion reads the file under test and checks the file says what the
 * file says. It is a tautology with respect to the source: it cannot fail
 * unless someone edits the source, and when they do it fails whether the edit
 * was a fix or a regression. It converted a typo into a defended invariant.
 * Fixed in f7d6a854; this guard is the family sweep for the SHAPE.
 *
 * THE RULE. A pin on the product's own source may assert STRUCTURE — that a
 * call exists, that a flag is present at every call site, that a forbidden
 * spelling is absent (`not.toContain` is fine: it encodes a rule the source can
 * violate). It may not assert a bare `key: 'value'` pair, because the
 * correctness of such a value is decided by an EXTERNAL contract — the
 * provider's accepted set — which the assertion never consults.
 *
 * THE FIX when this fails: give the pin an independent opinion. Extract the
 * value with a regex and assert MEMBERSHIP in the provider's documented
 * accepted set before asserting the specific value, e.g.
 *
 *     const ACCEPTED = ['l_ssd', 'b_ssd', 'unified', 'scratch', 'sbs_volume'];
 *     const value = /volumeType:\s*'([^']+)'/.exec(programSource)?.[1] ?? '';
 *     expect(ACCEPTED, `volumeType '${value}' is not accepted`).toContain(value);
 *     expect(value).toBe('sbs_volume');
 *
 * Now the test has a source of truth other than the code, so it can disagree
 * with it.
 *
 * OUT OF SCOPE, deliberately: assertions on output the code GENERATED from
 * real inputs (a rendered bundle, a built manifest). Those already can disagree
 * — change the rendering logic and they fail — so they are behavioral tests
 * that happen to read a file, not source echoes. The discriminator below is
 * therefore the SUBJECT (does the variable hold a file from `src/`?), never the
 * literal.
 */

const UNIT_TEST_ROOT = 'tests/unit';

/**
 * Pins that predate this guard and are accepted as-is. Every entry needs a
 * reason. Empty is the goal — an entry here is debt, not a settlement.
 */
const ALLOWED: Array<{ file: string; literal: string; why: string }> = [];

function walkTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTests(p, out);
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** `key: 'value'` / `key: "value"` — a config VALUE an external contract owns. */
const VALUE_PIN = /^[A-Za-z_][\w]*\s*:\s*['"][^'"]+['"]$/;

/** Does this expression reference a path under the product's `src/` tree? */
function mentionsSrc(expr: string): boolean {
  return /['"`]src['"`]|['"`][^'"`]*src\//.test(expr);
}

/**
 * Variables in `text` that hold the text of a file under `src/`.
 * Resolves one level of indirection (`const P = join(..,'src',..)` then
 * `readFileSync(P)`), which is how these tests are actually written.
 */
function sourceTextVars(text: string): Set<string> {
  const pathConsts = new Set<string>();
  const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*(?:\n[^;\n]*){0,4}?);/g;
  for (let c = constRe.exec(text); c !== null; c = constRe.exec(text)) {
    if (!c[2].includes('readFileSync') && mentionsSrc(c[2])) pathConsts.add(c[1]);
  }

  const vars = new Set<string>();
  const readRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*readFileSync\(\s*([\s\S]{0,200}?)\)/g;
  for (let r = readRe.exec(text); r !== null; r = readRe.exec(text)) {
    const args = r[2];
    const firstArg = args.split(',')[0].trim();
    if (mentionsSrc(args) || pathConsts.has(firstArg)) vars.add(r[1]);
  }
  return vars;
}

type Violation = { file: string; line: number; variable: string; literal: string };

function findEchoPins(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkTests(UNIT_TEST_ROOT)) {
    const text = readFileSync(file, 'utf-8');
    for (const variable of sourceTextVars(text)) {
      // POSITIVE toContain only. `not.toContain` encodes a rule the source can
      // break, so it is a legitimate pin and is excluded by this pattern.
      const useRe = new RegExp(
        `expect\\(\\s*${variable}\\s*\\)\\s*\\.toContain\\(\\s*(['"\`])([\\s\\S]*?)\\1\\s*\\)`,
        'g',
      );
      for (let u = useRe.exec(text); u !== null; u = useRe.exec(text)) {
        const literal = u[2].trim();
        if (!VALUE_PIN.test(literal)) continue;
        if (ALLOWED.some((a) => file.endsWith(a.file) && a.literal === literal)) continue;
        violations.push({
          file,
          line: text.slice(0, u.index).split('\n').length,
          variable,
          literal,
        });
      }
    }
  }
  return violations;
}

describe('source pins may not echo provider-facing values', () => {
  it('finds no `key: value` pin asserted against the product’s own source', () => {
    const violations = findEchoPins();
    const report = violations
      .map((v) => `  ${v.file}:${v.line}  expect(${v.variable}).toContain("${v.literal}")`)
      .join('\n');

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Source pins that only echo the source (see this file's header for the fix):\n${report}\n\n` +
            'Assert membership in the provider’s ACCEPTED SET first, then the specific value.',
    ).toEqual([]);
  });

  it('detects the shape it exists to catch', () => {
    // Self-test: the guard is a regex over test sources, so a silent break
    // would look exactly like "no violations". Feed it the REAL pre-fix
    // scaleway-compose pin (f7d6a854^) and require a hit.
    const preFix = [
      "const PROGRAM_PATH = join(process.cwd(), 'src/lib/iac/programs/scaleway-compose.js');",
      "const programSource = readFileSync(PROGRAM_PATH, 'utf-8');",
      'expect(programSource).toContain("volumeType: \'sbsVolume\'");',
    ].join('\n');

    const vars = sourceTextVars(preFix);
    expect(vars.has('programSource')).toBe(true);
    expect(VALUE_PIN.test("volumeType: 'sbsVolume'")).toBe(true);
  });

  it('does not flag structural or absence pins', () => {
    expect(VALUE_PIN.test('new scaleway.instance.Server(')).toBe(false);
    expect(VALUE_PIN.test('deleteOnTermination: true')).toBe(false); // boolean, no external vocabulary
    expect(VALUE_PIN.test('runcmd:')).toBe(false);
  });

  it('every allowlist entry carries a reason', () => {
    for (const entry of ALLOWED) {
      expect(entry.why.length, `${entry.file} allowlist entry needs a reason`).toBeGreaterThan(20);
    }
  });
});
