/**
 * Input validators shared across create, cli, restore, backup, configure.
 *
 * Every validator returns `undefined` on success and a human-readable error
 * string on failure. This matches @clack/prompts' `validate` contract and
 * lets the same function work for both interactive prompts and non-interactive
 * CLI argument validation.
 */

import { basename } from 'node:path';

const RESERVED_PROJECT_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '__tests__']);

const PROJECT_NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate a project name. Must be a bare basename, lowercase DNS-safe,
 * not reserved, max 63 characters.
 * Returns undefined on success, error string on failure.
 */
export function validateProjectName(name) {
  if (!name) return 'Project name is required';
  if (name !== basename(name) || name.startsWith('.')) {
    return 'Project name must be a basename (no slashes, no ../, no dot-names)';
  }
  if (name.length > 63) return 'Project name must be 63 characters or fewer';
  if (RESERVED_PROJECT_NAMES.has(name.toLowerCase())) {
    return `"${name}" is a reserved name`;
  }
  if (!PROJECT_NAME_RE.test(name)) {
    return 'Project name must be lowercase, start with a letter, and contain only letters, digits, and hyphens';
  }
  return undefined;
}

const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Validate an admin email address.
 * Returns undefined on success, error string on failure.
 */
export function validateAdminEmail(email) {
  if (!email) return 'Email is required';
  if (!EMAIL_RE.test(email)) {
    return 'Email must be a simple address (letters, digits, . _ + -, single @)';
  }
  return undefined;
}

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
// Block chars that break single-quote escaping or cause expansion if quoting is
// accidentally skipped. Other shell-special chars (| ; & etc.) are safe inside
// shEscape's single-quoted output, so they're intentionally not blocked here.
const SHELL_METACHARS_RE = /['"`$\\]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — rejecting control chars
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Validate an admin password. Must be printable ASCII, no shell metacharacters.
 * Returns undefined on success, error string on failure.
 */
export function validateAdminPassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (CONTROL_CHARS_RE.test(password)) return 'Password must not contain control characters';
  if (SHELL_METACHARS_RE.test(password)) {
    return `Password must not contain ', ", backtick, $, or \\`;
  }
  if (!PRINTABLE_ASCII_RE.test(password)) return 'Password must be printable ASCII only';
  return undefined;
}

// The display name is substituted raw into several sinks at create time — a
// single-quoted JS string literal (Logo.tsx), JSON (site.webmanifest), HTML
// text (index.html), and a dotenv value — so the charset must be inert in all
// of them: no quotes, backslashes, braces, angle brackets, `&`, or non-ASCII.
const DISPLAY_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?$/;

/**
 * Validate a human-facing project display name. Letters, digits, spaces, and
 * . _ - only; must start with a letter or digit, must not end with a space,
 * max 64 characters.
 * Returns undefined on success, error string on failure.
 */
export function validateDisplayName(name) {
  if (!name) return 'Display name is required';
  if (name.length > 64) return 'Display name must be 64 characters or fewer';
  if (!DISPLAY_NAME_RE.test(name)) {
    return 'Display name may only contain letters, digits, spaces, and . _ - (must start with a letter or digit, no trailing space)';
  }
  return undefined;
}

const DOMAIN_LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Validate a domain name. Must be a valid DNS hostname, max 253 characters.
 * Returns undefined on success, error string on failure.
 */
export function validateDomain(domain) {
  if (!domain) return 'Domain is required';
  if (domain.length > 253) return 'Domain must be 253 characters or fewer';
  if (domain.startsWith('.') || domain.endsWith('.')) {
    return 'Domain must not start or end with a dot';
  }
  const labels = domain.split('.');
  if (labels.length < 2) return 'Domain must contain at least one dot';
  for (const label of labels) {
    if (!DOMAIN_LABEL_RE.test(label)) return `"${label}" is not a valid domain label`;
  }
  return undefined;
}

const BACKUP_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(tar\.gz|sql\.gz|tar|sql)$/;

/**
 * Validate a backup filename. Must be a safe basename with a recognised extension.
 * Returns undefined on success, error string on failure.
 */
export function validateBackupFilename(name) {
  if (!name) return 'Backup filename is required';
  if (name !== basename(name)) return 'Backup filename must be a basename (no paths)';
  if (!BACKUP_FILENAME_RE.test(name)) {
    return 'Backup filename must match <safe-name>.(tar|sql)[.gz]';
  }
  return undefined;
}
