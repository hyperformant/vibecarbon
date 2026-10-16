/**
 * Escape every regular-expression metacharacter in `s`, backslash included,
 * so a literal (a version, an image name, a path, a flag) can sit inside a
 * `new RegExp(...)` and match only itself. Escaping just `.` or `-` leaves
 * the rest live (CodeQL js/incomplete-sanitization).
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
