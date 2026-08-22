/**
 * Shared env-value masking and summary formatting.
 *
 * Centralizes the logic for displaying environment variables while masking
 * secrets. Designed to work with any secret-classification strategy via
 * a configurable predicate function.
 */

import { c } from './colors.js';

/**
 * Mask a secret value, showing only the first 4 characters (or **** for short secrets).
 *
 * @param {string} key - Environment variable name.
 * @param {string} value - Environment variable value.
 * @param {function} isSecretFn - Function(key) → boolean indicating if key is secret.
 * @returns {string} - Original value if not secret; masked value if secret.
 */
export function maskEnvValue(key, value, isSecretFn) {
  if (!isSecretFn(key)) return value;
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 4)}${'•'.repeat(8)}`;
}

/**
 * Render currently-set env vars as `KEY = value` lines, skipping unset values.
 *
 * Detection is env-based so it works whether the user ran `vibecarbon configure`
 * or edited .env.local by hand.
 *
 * @param {Record<string, string>} env - Environment snapshot (e.g., from loadEnvVariables).
 * @param {string[]} keys - Env var names to include in output.
 * @param {function} isSecretFn - Function(key) → boolean indicating if key is secret.
 * @returns {string[]} - Formatted lines, empty array if no keys are set.
 */
export function envSummaryLines(env, keys, isSecretFn) {
  const lines = [];
  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    lines.push(`${c.dim(key)} = ${maskEnvValue(key, value, isSecretFn)}`);
  }
  return lines;
}
