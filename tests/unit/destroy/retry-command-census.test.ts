/**
 * Census: every line destroy prints that tells you to run the destroy again
 * names the command through retryDestroyCommand (src/lib/destroy/
 * retry-command.js), which carries -purge exactly when this destroy had it.
 *
 * A -purge destroy that keeps the environment's entry keeps its buckets for
 * the rerun. A rerun without -purge moves the entry and keeps the buckets,
 * and then no destroy can reach them. So in the destroy sources (src/destroy.js
 * and src/lib/destroy/), string and template text never spells
 * `vibecarbon destroy` itself, and never says "re-run the destroy" or
 * "destroy again" without naming the command. Comments may.
 *
 * Nor does it say "delete with -purge". After a plain destroy that moves the
 * entry, `destroy <env> -purge` stops at "Environment not found", so a line
 * that names -purge as the way to delete something names the command, and
 * only while the entry is kept (keptAppBucketNext, keptStateBucketNext).
 *
 * Allowed by hand: retry-command.js, which is the one spelling; and the
 * `-h` examples in destroy.js's SPEC, which are help, not a rerun.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { retryDestroyCommand } from '../../../src/lib/destroy/retry-command.js';
import { lex, STRING } from '../helpers/js-call-scan.js';

const ROOT = join(__dirname, '../../..');
const ONE_SPELLING = 'src/lib/destroy/retry-command.js';

function destroySources(): string[] {
  const dir = join(ROOT, 'src/lib/destroy');
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : [],
    );
  return [join(ROOT, 'src/destroy.js'), ...walk(dir)].map((f) => relative(ROOT, f));
}

/** A rerun spelled by hand, or asked for without naming the command. */
const HAND_SPELLED = /vibecarbon destroy/g;
const UNNAMED_RERUN = /\bre-?run (?:the )?destroy\b|\bdestroy again\b|\brun destroy\b/gi;
/**
 * A later -purge named without its command, which may no longer find the
 * environment. In a template the backtick around it is escaped in the source.
 */
const WITH_PURGE = /\bwith (?:\\?`)?-purge\b/gi;
/** A `-h` example in a command SPEC: help text, not a rerun. */
const SPEC_EXAMPLE = /^\s*(?:\{\s*)?command: '/;

/** Each offending match in string text, as `file:line: line`. */
function handSpelledReruns(rel: string, text: string): string[] {
  if (rel === ONE_SPELLING) return [];
  const { mask, errors } = lex(text);
  if (errors.length > 0) return errors.map((e) => `${rel}: cannot lex: ${e}`);
  const lines = text.split('\n');
  const out: string[] = [];
  for (const pattern of [HAND_SPELLED, UNNAMED_RERUN, WITH_PURGE]) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (mask[at] !== STRING) continue;
      const line = text.slice(0, at).split('\n').length;
      if (pattern === HAND_SPELLED && SPEC_EXAMPLE.test(lines[line - 1])) continue;
      out.push(`${rel}:${line}: ${lines[line - 1].trim()}`);
    }
  }
  return out;
}

describe('destroy names every rerun through retryDestroyCommand', () => {
  it('no destroy source spells the rerun by hand', () => {
    const files = destroySources();
    expect(files).toContain('src/destroy.js');
    expect(files).toContain('src/lib/destroy/server-sweep.js');
    expect(files).toContain('src/lib/destroy/s3-credential-check.js');
    const offenders = files.flatMap((rel) =>
      handSpelledReruns(rel, readFileSync(join(ROOT, rel), 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });

  it('bites: a hand-spelled rerun in a string or a template is flagged', () => {
    const rel = 'src/destroy.js';
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the census reads, not a template
      handSpelledReruns(rel, 'const h = `Run \\`vibecarbon destroy ${env}\\` again.`;\n'),
    ).toHaveLength(1);
    expect(handSpelledReruns(rel, "const h = 'then run vibecarbon destroy prod';\n")).toHaveLength(
      1,
    );
    expect(handSpelledReruns(rel, "const h = 'or re-run the destroy once it settles';\n")).toEqual([
      `${rel}:1: const h = 'or re-run the destroy once it settles';`,
    ]);
    expect(handSpelledReruns(rel, "const h = 'Run destroy again later';\n")).toHaveLength(1);
  });

  it('bites: a later -purge named without its command is flagged', () => {
    const rel = 'src/destroy.js';
    expect(
      handSpelledReruns(
        rel,
        "const h = 'S3 bucket kept with its uploads: b (delete with -purge)';\n",
      ),
    ).toHaveLength(1);
    expect(
      handSpelledReruns(rel, "const h = 'Bucket: b (kept; deleted with -purge)';\n"),
    ).toHaveLength(1);
    expect(handSpelledReruns(rel, 'const h = `rerun it with \\`-purge\\` later`;\n')).toHaveLength(
      1,
    );
    expect(
      handSpelledReruns(rel, '// a later destroy with -purge deletes it\nconst a = 1;\n'),
    ).toEqual([]);
    expect(
      handSpelledReruns(rel, "const h = 'Bucket: b (kept; -purge would delete it)';\n"),
    ).toEqual([]);
  });

  it('passes a comment, the helper, a SPEC example and the one spelling', () => {
    const rel = 'src/destroy.js';
    expect(
      handSpelledReruns(rel, '// run `vibecarbon destroy <env>` again\nconst a = 1;\n'),
    ).toEqual([]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the census reads, not a template
      handSpelledReruns(rel, 'const h = `Run \\`${retryDestroyCommand(env, args)}\\` again.`;\n'),
    ).toEqual([]);
    expect(
      handSpelledReruns(
        rel,
        "const SPEC = {\n  examples: [\n    { command: 'vibecarbon destroy prod -y' },\n  ],\n};\n",
      ),
    ).toEqual([]);
    expect(
      handSpelledReruns('src/lib/destroy/retry-command.js', "const c = 'vibecarbon destroy';\n"),
    ).toEqual([]);
  });
});

describe('retryDestroyCommand', () => {
  it('carries -purge exactly when this destroy had it', () => {
    expect(retryDestroyCommand('staging', { purgeBackups: true })).toBe(
      'vibecarbon destroy staging -purge',
    );
    expect(retryDestroyCommand('staging', { purgeBackups: false })).toBe(
      'vibecarbon destroy staging',
    );
    expect(retryDestroyCommand('staging', undefined)).toBe('vibecarbon destroy staging');
  });

  it("adds the line's own flags after -purge", () => {
    expect(retryDestroyCommand('prod', {}, ['-force'])).toBe('vibecarbon destroy prod -force');
    expect(retryDestroyCommand('prod', { purgeBackups: true }, ['-force'])).toBe(
      'vibecarbon destroy prod -purge -force',
    );
  });
});
