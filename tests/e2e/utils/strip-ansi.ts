/**
 * Strip ANSI colour codes (SGR sequences, `ESC [ … m`) from CLI output.
 *
 * The CLI colours its output through clack and picocolors, and every e2e
 * consumer that matches on text or cuts a tail for an error message has to
 * take the colour out first. This is the one spelling of that.
 *
 * Colour only, on purpose. Two lifecycle steps strip more (any CSI sequence,
 * and the cursor show/hide pair) because they read spinner output; they keep
 * their own, wider patterns where they are used.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
const ANSI_COLOUR_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_COLOUR_RE, '');
}
