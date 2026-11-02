/**
 * JSON mode: stdout carries ONLY the JSON document.
 *
 * A `-json` consumer pipes stdout into `jq`, so one stray line ahead of the
 * document ("✓ Using Spaces credentials from ...", a clack gutter, a spinner
 * frame) breaks it. Any code a JSON command calls can print such a line, so
 * the guarantee lives here, once, at the CLI entry, rather than at each call
 * site.
 *
 * Mechanism: `enterJsonMode()` keeps the real stdout write and replaces
 * `process.stdout.write` with a forwarder to stderr. Clack (`p.log`, `p.note`,
 * `p.spinner`, `p.intro`) and `console.log`/`console.info` all end in
 * `process.stdout.write`, looked up at call time, so one swap reroutes all of
 * them, including code added later. clack's own `output` option is per-call
 * (every prompt/log takes its own), so it cannot be set globally. The
 * document itself is written with `writeJson()`, the only path to real stdout.
 *
 * Known limit: a child process spawned with `stdio: 'inherit'` writes to fd 1
 * directly and bypasses this. JSON commands must capture child output.
 */

let realWrite = null;

/**
 * Whether argv asks for JSON output from a command with this spec.
 *
 * @param {{ flags?: Array<{ name: string }> } | undefined} spec
 * @param {string[]} argv
 * @returns {boolean}
 */
export function wantsJson(spec, argv) {
  return (spec?.flags ?? []).some((f) => f.name === 'json') && argv.includes('-json');
}

/** Reroute everything written to stdout to stderr, except `writeJson`. Idempotent. */
export function enterJsonMode() {
  if (realWrite) return;
  realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) =>
    process.stderr.write(chunk, encoding, callback);
}

/** Leave JSON mode (tests). */
export function exitJsonMode() {
  if (!realWrite) return;
  process.stdout.write = realWrite;
  realWrite = null;
}

/**
 * Write the JSON document to the real stdout, whether or not JSON mode is on.
 *
 * @param {unknown} value
 */
export function writeJson(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (realWrite) realWrite(text);
  else process.stdout.write(text);
}
