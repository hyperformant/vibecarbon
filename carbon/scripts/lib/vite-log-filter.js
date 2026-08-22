// Matches ANSI SGR escape sequences (colour/style codes). In a TTY, Vite wraps
// the banner labels in colour codes — and crucially places the reset *between*
// the word and its colon (e.g. `bold("Local") + ":"` → "Local\x1b[22m:"), so the
// raw line never contains the literal substring "Local:". We strip the escapes
// before matching. Built from String.fromCharCode(27) rather than a control-char
// regex literal, which Biome forbids.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * True when a Vite log line is the dev-server URL banner that our own dev.js
 * banner already prints (so vite.config.ts's customLogger can drop it). Keeps
 * the "ready in Xms" header, HMR/reload info, warnings, and errors.
 *
 * @param {unknown} msg
 * @returns {boolean}
 */
export function isViteUrlBannerLine(msg) {
  if (typeof msg !== 'string') return false;
  // Strip colour codes so matches work the same in a TTY (coloured) and when
  // piped/CI (plain). Vite splits labels and their colons into separate escape
  // wrappers, so substring checks must run against the de-coloured text.
  const plain = msg.replace(ANSI_RE, '');
  const hasUrl = plain.includes('http://') || plain.includes('https://');
  // Vite's startup banner: "➜  Local:  <url>" / "➜  Network: <url>".
  if (hasUrl && (plain.includes('Local:') || plain.includes('Network:'))) return true;
  // The interactive shortcuts hint printed right after the URLs.
  if (plain.includes('press h + enter')) return true;
  return false;
}
