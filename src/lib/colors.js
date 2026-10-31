/**
 * Shared ANSI color codes and formatting utilities for CLI output
 */

// ANSI escape codes
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  brightRed: '\x1b[91m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// Color formatting helpers
export const c = {
  error: (s) => `${colors.red}${s}${colors.reset}`,
  success: (s) => `${colors.green}${s}${colors.reset}`,
  warning: (s) => `${colors.yellow}${s}${colors.reset}`,
  info: (s) => `${colors.cyan}${s}${colors.reset}`,
  bold: (s) => `${colors.bold}${s}${colors.reset}`,
  dim: (s) => `${colors.dim}${s}${colors.reset}`,
  // Bright-black gray for prose that should recede without vanishing —
  // help-example comments. `dim` alone is indistinguishable from white on
  // some terminal themes.
  muted: (s) => `${colors.gray}${s}${colors.reset}`,
  // Bright red + bold — for prominent destruction-warning headlines
  // (destroy preview banner, "WARNING: data will be lost" footer). More
  // vibrant than `c.error` (which stays as the muted bullet color).
  danger: (s) => `${colors.bold}${colors.brightRed}${s}${colors.reset}`,
  // Composite styles
  boldCyan: (s) => `${colors.bold}${colors.cyan}${s}${colors.reset}`,
  boldYellow: (s) => `${colors.bold}${colors.yellow}${s}${colors.reset}`,
  boldCyanUnderline: (s) => `${colors.bold}${colors.cyan}\x1b[4m${s}${colors.reset}`,
};

/** `major.minor.patch` (missing parts are 0) as one comparable number. */
function versionNumber(v) {
  const [a = 0, b = 0, c = 0] = String(v || '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  return a * 1e6 + b * 1e3 + c;
}

/**
 * Whether `stream` is a terminal that renders OSC 8 hyperlinks.
 *
 * Off unless the evidence says on, after the supports-hyperlinks heuristics:
 * - FORCE_HYPERLINK decides outright ('0' or 'false' off, anything else on).
 * - NO_COLOR (non-empty) or FORCE_COLOR=0/false: off, the same switches
 *   clack's own styling (node:util styleText) honors.
 * - Not a TTY (piped, redirected, captured), VIBECARBON_PLAIN, a CI signal
 *   or TERM=dumb: off, as shouldAnimateSpinner (src/lib/cli/progress.js)
 *   decides for the spinner.
 * - On only for a terminal known to render OSC 8: Windows Terminal, VTE
 *   0.50+ (GNOME Terminal, Tilix, ...), iTerm2 3.1+, VS Code 1.72+, WezTerm,
 *   ghostty, kitty, Alacritty, Konsole 20.12+.
 *
 * @param {{ stream?: { isTTY?: boolean }, env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 * @returns {boolean}
 */
export function supportsHyperlinks({
  stream = process.stdout,
  env = process.env,
  platform = process.platform,
} = {}) {
  const forced = env.FORCE_HYPERLINK;
  if (forced !== undefined && forced !== '') return forced !== '0' && forced !== 'false';
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false') return false;
  if (!stream?.isTTY) return false;
  if (env.VIBECARBON_PLAIN || env.TERM === 'dumb') return false;
  if (env.CI || env.CONTINUOUS_INTEGRATION || env.GITHUB_ACTIONS) return false;
  if (env.WT_SESSION) return true;
  if (platform === 'win32') return false;
  if (env.VTE_VERSION) return Number.parseInt(env.VTE_VERSION, 10) >= 5000;
  switch (env.TERM_PROGRAM) {
    case 'iTerm.app':
      return versionNumber(env.TERM_PROGRAM_VERSION) >= versionNumber('3.1');
    case 'vscode':
      return versionNumber(env.TERM_PROGRAM_VERSION) >= versionNumber('1.72');
    case 'WezTerm':
    case 'ghostty':
      return true;
  }
  if (env.TERM === 'xterm-kitty' || env.TERM === 'alacritty') return true;
  if (env.KONSOLE_VERSION) return Number.parseInt(env.KONSOLE_VERSION, 10) >= 201200;
  return false;
}

/**
 * A URL the operator reads or clicks. Every printed URL goes through this
 * (tests/unit/lib/printed-url-link-census.test.ts).
 *
 * On a terminal that renders them it is an OSC 8 hyperlink. clack wraps note
 * and log text at the terminal width and would otherwise split a long URL
 * across two box lines, borders between the halves, so neither half opens;
 * an OSC 8 span is one word to its wrapper and opens its full target even
 * when the line soft-wraps on screen. Everywhere else (piped, NO_COLOR, CI,
 * an unknown terminal) it is the plain text, so logs and copies stay clean.
 *
 * Style the result as before: `c.boldCyanUnderline(link(url))`.
 *
 * @param {string} url
 * @param {string} [label=url] - visible text; a plain rendering keeps the URL beside it
 * @param {Parameters<typeof supportsHyperlinks>[0]} [opts] - `stream` defaults to stdout; pass process.stderr for console.error
 * @returns {string}
 */
export function link(url, label = url, opts = {}) {
  if (supportsHyperlinks(opts)) return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  return label === url ? url : `${label} (${url})`;
}

// Branded banner for CLI commands
export function printBanner() {
  const bgCyan = '\x1b[46m';
  const border = 2;
  const inner = 44;
  const width = inner + border * 2;
  const full = `${bgCyan}${' '.repeat(width)}${colors.reset}`;
  const side = `${bgCyan}${' '.repeat(border)}${colors.reset}`;
  const empty = `${side}${' '.repeat(inner)}${side}`;
  const text = '        v  i  b  e  c  a  r  b  o  n        ';
  console.log();
  console.log(full);
  console.log(empty);
  console.log(`${side}${colors.bold}${colors.cyan}${text}${colors.reset}${side}`);
  console.log(empty);
  console.log(full);
  console.log();
}
