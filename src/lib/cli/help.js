/**
 * Shared help-text renderer for vibecarbon commands.
 *
 * Each command exports a `CommandSpec` (see `parse-flags.js` for the
 * type) and this renderer produces the human help body from it. One
 * authoritative source for usage info means flags can't drift between
 * the parser and the help output the way they did when each command
 * hand-rolled both — a common failure mode in the old code where a
 * flag would be parsed but missing from `--help`, or vice-versa.
 *
 * The output style mirrors the existing tone: bold section headers,
 * cyan flag/value names, dim descriptions. Sections are skipped
 * silently when their data is empty (no flags? no FLAGS section).
 *
 * Vibecarbon is single-dash-only — flag names render as `-name`,
 * never `--name`. See memory:feedback_cli_single_dash_flags.
 */

import { c } from '../colors.js';

/**
 * @typedef {object} HelpExample
 * @property {string} command - the literal invocation (without
 *   the leading `$ ` shell prompt).
 * @property {string} [description] - one-line context shown above
 *   the command in dim text.
 *
 * @typedef {import('./parse-flags.js').CommandSpec & {
 *   examples?: HelpExample[],
 *   description?: string,
 * }} HelpSpec
 */

/**
 * Render a command's help body. Returns a string ending in a newline,
 * suitable for `console.log()` or `process.stdout.write()`.
 *
 * @param {HelpSpec} spec
 * @returns {string}
 */
export function renderHelp(spec) {
  const lines = [];

  // Title line: "Vibecarbon Backup - Create or manage backups"
  const title = `${c.bold('Vibecarbon')} ${c.bold(capitalize(spec.name))}`;
  if (spec.summary) {
    lines.push(`${title} - ${spec.summary}`);
  } else {
    lines.push(title);
  }
  lines.push('');

  if (spec.description) {
    lines.push(spec.description);
    lines.push('');
  }

  // USAGE section.
  lines.push(c.bold('USAGE'));
  lines.push(`  ${formatUsage(spec)}`);
  lines.push('');

  // ARGUMENTS section (only if there are positionals).
  const positionals = spec.positional ?? [];
  if (positionals.length > 0) {
    lines.push(c.bold('ARGUMENTS'));
    for (const p of positionals) {
      const name = p.optional ? `[${p.name}]` : `<${p.name}>`;
      const desc = p.description ?? '';
      lines.push(`  ${c.info(name.padEnd(16))} ${c.dim(desc)}`);
    }
    lines.push('');
  }

  // FLAGS section.
  const flags = spec.flags ?? [];
  if (flags.length > 0) {
    lines.push(c.bold('FLAGS'));
    for (const f of flags) {
      const display = f.value ? `-${f.name} ${f.value}` : `-${f.name}`;
      const desc = f.description ?? '';
      const enumNote = f.enum ? `${desc ? ' ' : ''}(${f.enum.join('|')})` : '';
      lines.push(`  ${c.info(display.padEnd(20))} ${c.dim(desc + enumNote)}`);
    }
    lines.push('');
  }

  // EXAMPLES section.
  const examples = spec.examples ?? [];
  if (examples.length > 0) {
    lines.push(c.bold('EXAMPLES'));
    for (const ex of examples) {
      if (ex.description) {
        lines.push(`  ${c.dim(`# ${ex.description}`)}`);
      }
      lines.push(`  ${ex.command}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Build the one-line usage signature.
 * @param {HelpSpec} spec
 */
function formatUsage(spec) {
  const parts = ['vibecarbon', spec.name];
  for (const p of spec.positional ?? []) {
    if (p.variadic) {
      parts.push(p.optional ? `[${p.name}...]` : `<${p.name}...>`);
    } else {
      parts.push(p.optional ? `[${p.name}]` : `<${p.name}>`);
    }
  }
  if ((spec.flags ?? []).length > 0) {
    parts.push('[flags]');
  }
  return parts.join(' ');
}

/**
 * @param {string} s
 * @returns {string}
 */
function capitalize(s) {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
