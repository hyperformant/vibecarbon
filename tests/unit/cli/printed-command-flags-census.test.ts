/**
 * Census: every `vibecarbon <cmd> -flag` an operator is told to type names a
 * flag that command's SPEC really has.
 *
 * Class: "printed command names a flag the CLI does not have". Instance that
 * bought this: the k8s-ha deploy summary printed `vibecarbon failover
 * --target standby`, but failover has no -target and no double-dash flags, so
 * the one command an operator copies mid-incident was rejected by the parser.
 *
 * The walk reads every string in src/**\/*.js (comment-only lines skipped),
 * finds `vibecarbon <cmd>` followed by dash tokens, loads <cmd>'s SPEC from
 * the command registry and asserts each flag exists. `--flag` fails outright:
 * this CLI is single-dash only. Tokens after `vibecarbon` that are not a
 * registered command (e.g. `vibecarbon get pods`) are skipped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAllSpecs } from '../../../src/lib/cli/command-registry.js';

type Spec = { flags?: { name: string }[] };
const specs = new Map<string, Set<string>>();
for (const { entry, spec } of await loadAllSpecs()) {
  specs.set(entry.name, new Set(((spec as Spec).flags ?? []).map((f) => f.name)));
}

function walkJs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkJs(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

interface PrintedFlag {
  file: string;
  line: number;
  command: string;
  flag: string;
}

/** Every dash token that follows `vibecarbon <registered-command>` on a line. */
function printedFlags(file: string, source: string): PrintedFlag[] {
  const hits: PrintedFlag[] = [];
  source.split('\n').forEach((text, i) => {
    if (/^\s*(\*|\/\/)/.test(text)) return;
    for (const m of text.matchAll(/vibecarbon ([a-z][a-z-]*)((?: +[^\s`'"\\)]+)*)/g)) {
      if (!specs.has(m[1])) continue;
      for (const tok of m[2].split(/\s+/)) {
        const f = tok.match(/^(--?)([a-zA-Z][\w-]*)/);
        if (f) hits.push({ file, line: i + 1, command: m[1], flag: f[1] + f[2] });
      }
    }
  });
  return hits;
}

describe('printed commands name real flags', () => {
  const files = walkJs('src');

  it('walks the source tree and finds printed commands (guards against walking nothing)', () => {
    const all = files.flatMap((f) => printedFlags(f, readFileSync(f, 'utf8')));
    expect(all.length).toBeGreaterThan(30);
  });

  for (const file of files) {
    const hits = printedFlags(file, readFileSync(file, 'utf8'));
    if (hits.length === 0) continue;
    it(`${file}: every printed flag exists in its command's SPEC and is single-dash`, () => {
      for (const h of hits) {
        const where = `${h.file}:${h.line} \`vibecarbon ${h.command} ${h.flag}\``;
        expect(h.flag.startsWith('--'), `${where} uses a double-dash flag`).toBe(false);
        expect(specs.get(h.command)?.has(h.flag.slice(1)), `${where} is not in the SPEC`).toBe(
          true,
        );
      }
    });
  }
});
