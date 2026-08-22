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
};

// Color formatting helpers
export const c = {
  error: (s) => `${colors.red}${s}${colors.reset}`,
  success: (s) => `${colors.green}${s}${colors.reset}`,
  warning: (s) => `${colors.yellow}${s}${colors.reset}`,
  info: (s) => `${colors.cyan}${s}${colors.reset}`,
  bold: (s) => `${colors.bold}${s}${colors.reset}`,
  dim: (s) => `${colors.dim}${s}${colors.reset}`,
  // Bright red + bold — for prominent destruction-warning headlines
  // (destroy preview banner, "WARNING: data will be lost" footer). More
  // vibrant than `c.error` (which stays as the muted bullet color).
  danger: (s) => `${colors.bold}${colors.brightRed}${s}${colors.reset}`,
  // Composite styles
  boldCyan: (s) => `${colors.bold}${colors.cyan}${s}${colors.reset}`,
  boldYellow: (s) => `${colors.bold}${colors.yellow}${s}${colors.reset}`,
  boldCyanUnderline: (s) => `${colors.bold}${colors.cyan}\x1b[4m${s}${colors.reset}`,
};

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
