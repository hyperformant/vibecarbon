/**
 * Single-dash spec-driven flag parser.
 *
 * Vibecarbon's CLI uses single-dash flags only (`-h`, `-env prod`,
 * `-mode k8s`). Double-dash long flags (`--help`) are rejected — see
 * memory:feedback_cli_single_dash_flags. Each command exports a spec
 * declaring its flags + positionals; this parser walks argv against
 * that spec and returns `{ values, positional, errors }`.
 *
 * Why a shared parser:
 *   - Each command file used to hand-roll a `parseArgs(args)` loop.
 *     The result was inconsistent error handling, drift between long
 *     and short forms, and silent acceptance of typos.
 *   - With a shared parser driven by an explicit spec, every command
 *     gets the same diagnostics, and help-text generation has a single
 *     authoritative source (this spec, consumed by `cli/help.js`).
 *
 * @typedef {object} FlagSpec
 * @property {string} name - canonical flag name (used as `-${name}` in argv).
 * @property {boolean} [boolean] - true for presence-only flags (`-l`, `-y`).
 *   Boolean and value are mutually exclusive; pick one.
 * @property {string} [value] - placeholder shown in help (e.g. `<name>`).
 *   When set, the parser consumes the next argv element as the value.
 * @property {string[]} [enum] - constrain a value flag to an allowed set.
 *   The parser emits an error if the supplied value isn't in this list.
 * @property {string} [description] - human-readable description for help.
 *
 * @typedef {object} PositionalSpec
 * @property {string} name - identifier (used as the key in the result).
 * @property {boolean} [optional=false] - if false, missing this positional
 *   produces an error.
 * @property {boolean} [variadic=false] - if true, all remaining positionals
 *   are collected into an array under this name.
 * @property {string} [description] - human-readable description for help.
 *
 * @typedef {object} CommandSpec
 * @property {string} name - the command (e.g. `backup`).
 * @property {string} [summary] - one-line description for help.
 * @property {FlagSpec[]} [flags]
 * @property {PositionalSpec[]} [positional]
 *
 * @typedef {object} ParseResult
 * @property {Record<string, string|boolean|null>} values - flag values
 *   keyed by canonical name. Boolean flags default to false; value flags
 *   default to null.
 * @property {Record<string, string|string[]|undefined>} positional -
 *   positional values keyed by their declared name. Variadic positionals
 *   produce an array.
 * @property {string[]} errors - human-readable diagnostics. Empty when
 *   parsing succeeded; the caller decides whether to print and exit.
 */

import { c } from '../colors.js';
import { VERSION } from '../version.js';
import { renderHelp } from './help.js';

/**
 * Parse argv against a spec and handle the three universal outcomes every
 * command used to copy-paste (~12 lines × 20 files):
 *   - parse errors → print each as `✗ …`, print the `-h` hint, exit(1)
 *   - `-h`         → print renderHelp(spec), mark handled
 *   - `-v`         → print `vibecarbon v<VERSION>`, mark handled
 *
 * Callers do:
 *   const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
 *   if (handled) return;
 *
 * `handled` (instead of exiting here) lets main() return normally so
 * cli.js's perf timer still closes and unit tests can call run(['-h'])
 * without the process dying.
 *
 * @param {string[]} argv - process.argv slice (without node + script).
 * @param {CommandSpec} spec
 * @returns {{ values: ParseResult['values'], positional: ParseResult['positional'], handled: boolean }}
 */
export function parseFlagsOrExit(argv, spec) {
  const { values, positional, errors } = parseFlags(argv, spec);
  // -h/-v win over parse errors: `vibecarbon console -h` used to die on
  // "missing required argument: node" and then hint at the exact command
  // that just failed. Asking for help must never require valid arguments.
  if (values.h) {
    process.stdout.write(renderHelp(spec));
    return { values, positional, handled: true };
  }
  if (values.v) {
    console.log(`vibecarbon v${VERSION}`);
    return { values, positional, handled: true };
  }
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`${c.error('✗')} ${e}\n`);
    }
    process.stderr.write(`Run ${c.info(`vibecarbon ${spec.name} -h`)} for usage.\n`);
    process.exit(1);
  }
  return { values, positional, handled: false };
}

/**
 * @param {string[]} argv - process.argv slice (without node + script).
 * @param {CommandSpec} spec
 * @returns {ParseResult}
 */
export function parseFlags(argv, spec) {
  /** @type {Record<string, string|boolean|null>} */
  const values = {};
  /** @type {Record<string, string|string[]|undefined>} */
  const positional = {};
  /** @type {string[]} */
  const errors = [];

  const flagSpecs = spec.flags ?? [];
  const positionalSpecs = spec.positional ?? [];

  for (const f of flagSpecs) {
    if (f.boolean && f.value !== undefined) {
      throw new Error(`flag spec "${f.name}" has both \`boolean\` and \`value\`; pick one`);
    }
    values[f.name] = f.boolean ? false : null;
  }

  /** @type {string[]} */
  const collectedPositionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('-')) {
      collectedPositionals.push(arg);
      continue;
    }

    // Reject the empty `-` (probably a typo) and double-dash forms
    // (`--help`, `--env=prod`). Both fall into the "unknown flag" path
    // — vibecarbon is pre-release and intentionally has no migration
    // shim for the dropped POSIX-long convention.
    if (arg === '-' || arg.startsWith('--')) {
      errors.push(`unknown flag: ${arg}`);
      continue;
    }

    const name = arg.slice(1);
    const flagSpec = flagSpecs.find((f) => f.name === name);

    if (!flagSpec) {
      errors.push(`unknown flag: ${arg}`);
      continue;
    }

    if (flagSpec.boolean) {
      values[name] = true;
      continue;
    }

    // Value flag — consume the next argv element. Reject if the next
    // element is missing or itself a flag (the latter usually means the
    // operator forgot the value: `vibecarbon backup -env -y` is almost
    // certainly a mistake, not "use literal `-y` as the env name").
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      errors.push(`flag -${name} requires a value`);
      continue;
    }
    if (flagSpec.enum && !flagSpec.enum.includes(next)) {
      errors.push(`-${name} must be one of: ${flagSpec.enum.join(', ')} (got: ${next})`);
      // Still consume next so we don't double-report it as a stray positional.
      i++;
      continue;
    }
    values[name] = next;
    i++;
  }

  // Distribute collected positionals across positional specs in order.
  // A variadic spec consumes all remaining positionals, so it must be
  // the last entry; we guard against mid-list variadics in the schema.
  let cursor = 0;
  for (let p = 0; p < positionalSpecs.length; p++) {
    const ps = positionalSpecs[p];
    if (ps.variadic) {
      if (p !== positionalSpecs.length - 1) {
        throw new Error(`positional "${ps.name}" is variadic but not the last entry in spec`);
      }
      positional[ps.name] = collectedPositionals.slice(cursor);
      cursor = collectedPositionals.length;
      break;
    }
    if (cursor < collectedPositionals.length) {
      positional[ps.name] = collectedPositionals[cursor];
      cursor++;
    } else {
      positional[ps.name] = undefined;
      if (!ps.optional) {
        errors.push(`missing required argument: ${ps.name}`);
      }
    }
  }

  // Excess positionals (operator passed more than the spec declares).
  if (cursor < collectedPositionals.length) {
    const extra = collectedPositionals.slice(cursor);
    errors.push(`unexpected argument${extra.length === 1 ? '' : 's'}: ${extra.join(' ')}`);
  }

  return { values, positional, errors };
}
