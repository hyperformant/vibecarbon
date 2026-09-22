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
 * cyan flag/value names, dim descriptions, gray example comments.
 * Sections are skipped silently when their data is empty (no flags?
 * no FLAGS section).
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
 * Colour a help example so `vibecarbon <command>` matches the cyan command
 * names in the lists above it, while args and flags stay plain. Lines that
 * aren't a vibecarbon invocation (`cd my-app`) come back untouched.
 *
 * @param {string} command
 * @returns {string}
 */
export function formatExampleCommand(command) {
  const lead = command.match(/^\s*/)[0];
  const trail = command.match(/\s*$/)[0];
  const body = command.slice(lead.length, command.length - trail.length);
  const match = body.match(/^vibecarbon(?:\s+(\S+))?(.*)$/);
  if (!match) return command;
  const [, name, rest] = match;
  const coloured = name
    ? `${c.info('vibecarbon')} ${c.info(name)}${rest}`
    : `${c.info('vibecarbon')}${rest}`;
  return `${lead}${coloured}${trail}`;
}

/**
 * @typedef {object} ExampleGroup
 * @property {string} [description] - comment line shown above the commands
 * @property {string[]} commands - one or more invocations shown in order
 */

/**
 * Lines for an EXAMPLES section: gray comment, coloured commands, blank line
 * after each group. Shared by the global help and every command's help so
 * the two can't drift.
 *
 * @param {ExampleGroup[]} groups
 * @returns {string[]}
 */
/**
 * Colour the body of a `p.note()` that lists commands — the "Next steps"
 * boxes after create/add/remove and the cluster-ready note after deploy —
 * with the same vocabulary the help EXAMPLES use: `vibecarbon <command>` in
 * cyan, `#` comments muted, everything else (args, flags, plain shell like
 * `cd my-app`) left alone so our commands stay visually distinct from the
 * user's own.
 *
 * Handles the two shapes those notes use that a bare formatExampleCommand
 * does not: a chain (`vibecarbon down && vibecarbon up`, each invocation
 * coloured) and a trailing inline comment (`vibecarbon shell e1  # ...`).
 *
 * @param {string[]} lines - note body, one entry per line
 * @returns {string} the body joined with newlines, ready for p.note()
 */
export function formatCommandNote(lines) {
  return lines
    .map((line) => {
      if (!line.trim()) return line;
      const indent = line.match(/^\s*/)[0];
      const body = line.slice(indent.length);
      if (body.startsWith('#')) return `${indent}${c.muted(body)}`;
      // Trailing inline comment: the `#` must follow whitespace, so a `#`
      // inside a value (a URL fragment, say) is left as part of the command.
      const split = body.match(/^(.*?\S)(\s+)(#\s.*)$/);
      const commands = split ? split[1] : body;
      // Keep the original gap verbatim: these notes pad it so the `#`
      // comments line up in a column, and normalising it breaks that.
      const comment = split ? `${split[2]}${c.muted(split[3])}` : '';
      const coloured = commands
        .split(/(\s*&&\s*)/)
        .map((part) => (/^\s*&&\s*$/.test(part) ? part : formatExampleCommand(part)))
        .join('');
      return `${indent}${coloured}${comment}`;
    })
    .join('\n');
}

export function formatExamples(groups) {
  const lines = [];
  for (const group of groups) {
    if (group.description) lines.push(`  ${c.muted(`# ${group.description}`)}`);
    for (const command of group.commands) lines.push(`  ${formatExampleCommand(command)}`);
    lines.push('');
  }
  return lines;
}

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
    lines.push(
      ...formatExamples(
        examples.map((ex) => ({ description: ex.description, commands: [ex.command] })),
      ),
    );
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
