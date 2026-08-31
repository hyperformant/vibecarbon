/**
 * Error sanitizer for crash telemetry. The privacy contract lives here:
 * nothing identifying leaves the machine. Redaction order matters —
 * paths first (so usernames vanish), then IPs, then secret-shaped runs.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/lib/telemetry/sanitize.js -> package root is three dirs up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const MESSAGE_MAX = 500;
const FRAMES_MAX = 20;

/**
 * Redact user-identifying and secret-shaped substrings.
 *
 * @param {string} text
 * @param {string} homeDir
 * @returns {string}
 */
export function sanitizeText(text, homeDir) {
  let out = String(text);
  // 1. Home directory (and thus the username) → ~
  if (homeDir) out = out.split(homeDir).join('~');
  // 2. IP addresses → [ip]
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  out = out.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F:]{1,4}\b/g, '[ip]');
  // 3. token= / key=-shaped values (word chars after an = following token/key/secret/password)
  out = out.replace(/\b([\w-]*(?:token|key|secret|password)[\w-]*=)\S+/gi, '$1[redacted]');
  // 4. Long hex/base64-looking runs (20+ chars with at least one digit)
  out = out.replace(/\b(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{20,}\b/g, '[redacted]');
  return out;
}

/**
 * Sanitize an Error into the wire-safe crash payload fields.
 *
 * @param {Error} error
 * @param {{ homeDir?: string, packageRoot?: string }} [opts] injectable for tests
 * @returns {{ error_name: string, message: string, stack: string, fingerprint: string }}
 */
export function sanitizeError(error, { homeDir = homedir(), packageRoot = PACKAGE_ROOT } = {}) {
  try {
    const name = String(error?.name || 'Error').slice(0, 200);
    const message = sanitizeText(String(error?.message ?? ''), homeDir).slice(0, MESSAGE_MAX);

    const rawLines = String(error?.stack ?? '').split('\n');
    const frames = [];
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('at ')) continue;
      if (!trimmed.includes(packageRoot)) continue; // only our own code
      if (trimmed.includes('node_modules')) continue;
      // Rewrite absolute package paths to package-relative.
      frames.push(trimmed.split(`${packageRoot}/`).join(''));
      if (frames.length >= FRAMES_MAX) break;
    }
    const stack = frames.length > 0 ? frames.join('\n') : '(no stack)';

    // Fingerprint: name + frame identities with line:col stripped, so a
    // shifted line number still groups with the same crash.
    const normalized = frames.map((f) => f.replace(/:\d+:\d+\)?$/, ''));
    const fingerprint = createHash('sha256')
      .update(`${name}\n${normalized.join('\n')}`)
      .digest('hex')
      .slice(0, 16);

    return { error_name: name, message, stack, fingerprint };
  } catch {
    return {
      error_name: 'Error',
      message: '(sanitizer failed)',
      stack: '(no stack)',
      fingerprint: '0'.repeat(16),
    };
  }
}
