/**
 * Census: a command a message tells the operator to run is never glued to
 * punctuation. Copied with a double-click or a drag, `rerun vibecarbon
 * restore.` runs `restore.`, and `ssh root@ip '... start app'.` hands the
 * shell a stray `.` after the quote. Either the command ends the sentence with
 * nothing after it, or it sits on its own indented line (the multi-line
 * messages in restore and restoreCompose).
 *
 * Two shapes are flagged in every src/ string (comment lines skipped):
 *   1. `vibecarbon <command>` plus its flags and placeholders, then . , ; or :
 *   2. a shell single-quoted argument closing, then . , ; or :, then the end
 *      of the JS string.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../../../src/cli.js';

const ROOT = join(__dirname, '../../..');
const files = execFileSync('git', ['ls-files', 'src/*.js', 'src/**/*.js'], {
  cwd: ROOT,
  encoding: 'utf-8',
})
  .split('\n')
  .filter(Boolean);

const commands = KNOWN_COMMANDS.filter((c: string) => /^[a-z][a-z-]*$/.test(c)).join('|');
const ARG = String.raw`(?:-[a-z][a-z-]*|<[a-z-]+>|\$\{[^}]+\})`;
const VIBECARBON_THEN_PUNCT = new RegExp(
  String.raw`\bvibecarbon (?:${commands})(?: ${ARG})*[.,;:](?=[\s'"\x60)]|$)`,
);
const QUOTED_THEN_PUNCT = /'[.,;:]["`]/;

/** Lines that only look like it: not a command an operator copies. */
const ALLOW = [
  // Comments written into the git hooks create installs, not a message.
  /# Pre-(commit|push) hook installed by vibecarbon create\./,
  // A label in the shell banner, not a command.
  /echo " {2}vibecarbon shell: env=/,
  // Code, not text: a JS string ending in a quoted shell word.
  /No server IP found for environment '\$\{envName\}'\./,
  /stack '\$\{environment\}-\$\{role\}'\./,
  /for env '\$\{environment\}'\./,
];

function offenders(text: string, file: string) {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (ALLOW.some((a) => a.test(line))) return;
    if (VIBECARBON_THEN_PUNCT.test(line) || QUOTED_THEN_PUNCT.test(line)) {
      out.push(`${file}:${i + 1}: ${t.slice(0, 140)}`);
    }
  });
  return out;
}

describe('copyable commands are never followed by punctuation', () => {
  it('reads the CLI command list', () => {
    expect(KNOWN_COMMANDS).toContain('restore');
    expect(files.length).toBeGreaterThan(50);
  });

  it('no message in src/ glues punctuation to a command', () => {
    const found = files.flatMap((f) => offenders(readFileSync(join(ROOT, f), 'utf-8'), f));
    expect(found).toEqual([]);
  });

  it('catches the shapes it is for', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a JS placeholder
    const env = '${environment}';
    for (const bad of [
      "'then rerun vibecarbon restore.',",
      `\`run vibecarbon deploy ${env}.\``,
      `\`then rerun vibecarbon deploy: ${env}\``,
      "'No license here. Pass the key: vibecarbon deactivate <key>.',",
      `"&& docker compose start app'.",`,
    ]) {
      expect(offenders(bad, 'x.js'), bad).toHaveLength(1);
    }
    for (const ok of [
      "'  vibecarbon restore',",
      `\`run vibecarbon deploy ${env} first, which points it\``,
      "'a dedicated API token per vibecarbon project.',",
    ]) {
      expect(offenders(ok, 'x.js'), ok).toEqual([]);
    }
  });
});
