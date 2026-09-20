#!/usr/bin/env node
/**
 * License Key Generator for Vibecarbon
 *
 * Mints a key the published CLI accepts: vc-<licenseId>-<signature>, Ed25519
 * over the bare licenseId. The key names no project; vibecarbon.com binds it
 * at `vibecarbon activate`. In production the licenseId is minted by
 * fulfilment and stored on the subscription row; this script exists for the
 * test harness and for support.
 *
 * Usage:
 *   VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js [--license-id <16hex>]
 *
 * Also exports signVerdictToken(), used by the test licence-API stub.
 */

import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { signedMessage, validateLicenseKey, VERDICT_STATUSES, VERDICT_TIERS } from '../src/lib/licensing/validator.js';

/** 'YYYY-MM-DD', the only date shape signVerdictToken accepts. */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const LICENSE_ID_RE = /^[0-9a-f]{16}$/;

function showHelp() {
  console.log(`
Vibecarbon License Generator

Usage:
  VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js [--license-id <16hex>]

Options:
  --license-id <16hex>    Mint this specific license ID instead of a random one.
  -h, --help              Show this help message

Environment:
  VIBECARBON_LICENSE_PRIVATE_KEY must be set to the Ed25519 private key, PEM or base64-encoded PEM.
`);
}

/**
 * Accept the signing key exactly as vibecarbon-web's LICENSE_SIGNING_PRIVATE_KEY
 * does: raw PEM passes through unchanged; anything else is treated as
 * base64-encoded PEM and decoded. This is the single choke point every call
 * to createPrivateKey in this file goes through, so an operator pasting
 * either form out of vibecarbon-web gets a working key.
 *
 * Twin: src/lib/operator-env.js `normalizeOperatorValue` (kind 'pem')
 * reimplements this for the CLI's registry-driven reads and additionally
 * expands literal `\n` escapes; it stays a copy so that lib remains
 * dependency-free of scripts/. Deliberately not unified (review 2026-09-19,
 * M13) — mirror any change to the accepted encodings there.
 * @param {string} value
 * @returns {string} PEM
 */
export function normalizePem(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

/**
 * Parse argv. Any other flag-shaped argument is rejected: this is what turns
 * a retired flag into a loud error instead of being silently ignored.
 * @param {string[]} args
 */
export function parseArgs(args) {
  const opts = { help: false, licenseId: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--license-id' || a === '-license-id') opts.licenseId = args[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

export function randomLicenseId() {
  return randomBytes(8).toString('hex');
}

/** Derive the Ed25519 public key (PEM, spki) for a private key (PEM, pkcs8). */
export function derivePublicKeyPem(privateKeyPem) {
  const privateKey = createPrivateKey(normalizePem(privateKeyPem));
  const publicKey = createPublicKey(privateKey);
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Mint a key: vc-<licenseId>-<signature>, Ed25519 over the bare licenseId.
 * @param {string} privateKeyPem
 * @param {{ licenseId: string }} opts
 */
export function mintKey(privateKeyPem, { licenseId }) {
  if (!LICENSE_ID_RE.test(licenseId ?? '')) {
    throw new Error(`licenseId must be 16 lowercase hex, got ${licenseId}`);
  }
  const message = signedMessage({ format: 'key', licenseId });
  const signature = sign(null, Buffer.from(message), createPrivateKey(normalizePem(privateKeyPem)));
  return `vc-${licenseId}-${signature.toString('hex')}`;
}

/**
 * Sign a verdict token the way vibecarbon.com does. Used by unit tests and
 * for manual diagnosis; production verdicts are minted by the web app.
 * @param {{ projectId: string, status: string, tier: string, periodEnd: string, issued: string }} fields  dates YYYY-MM-DD
 */
export function signVerdictToken(privateKeyPem, { projectId, status, tier, periodEnd, issued }) {
  if (!VERDICT_STATUSES.has(status)) {
    throw new Error(
      `signVerdictToken: invalid status ${JSON.stringify(status)}; must be one of ${[...VERDICT_STATUSES].join(', ')}`,
    );
  }
  if (!VERDICT_TIERS.has(tier)) {
    throw new Error(
      `signVerdictToken: invalid tier ${JSON.stringify(tier)}; must be one of ${[...VERDICT_TIERS].join(', ')}`,
    );
  }
  if (!YMD_RE.test(periodEnd)) {
    throw new Error(`signVerdictToken: periodEnd must be 'YYYY-MM-DD', got ${JSON.stringify(periodEnd)}`);
  }
  if (!YMD_RE.test(issued)) {
    throw new Error(`signVerdictToken: issued must be 'YYYY-MM-DD', got ${JSON.stringify(issued)}`);
  }
  const parsed = { format: 'verdict', projectId: projectId.toLowerCase(), status, tier, periodEnd, issued };
  const message = signedMessage(parsed);
  const signature = sign(null, Buffer.from(message), createPrivateKey(normalizePem(privateKeyPem)));
  const pid32 = parsed.projectId.replace(/-/g, '');
  return `vcv-${pid32}-${status}-${tier}-${periodEnd.replace(/-/g, '')}-${issued.replace(/-/g, '')}-${signature.toString('hex')}`;
}

/**
 * Run the generator end to end (parse -> mint -> round-trip validate ->
 * print). Split out from `main()` so tests can call it directly against an
 * ephemeral keypair instead of spawning a process.
 * @param {string[]} args
 * @param {{ privateKeyPem?: string, log?: (s: string) => void }} [options]
 */
export function run(args, { privateKeyPem, log = console.log } = {}) {
  const opts = parseArgs(args);

  if (opts.help) {
    showHelp();
    return { printed: false };
  }

  const pem = privateKeyPem ?? process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
  if (!pem) {
    throw new Error(
      'VIBECARBON_LICENSE_PRIVATE_KEY environment variable is required (Ed25519 private key, PEM or base64-encoded PEM)',
    );
  }

  const licenseId = opts.licenseId ?? randomLicenseId();
  const key = mintKey(pem, { licenseId });

  // Round-trip through the same parser/verifier a customer's CLI runs, so a
  // key that would not actually activate is never handed out.
  const validation = validateLicenseKey(key, { publicKeyPem: derivePublicKeyPem(pem) });
  if (!validation.valid) {
    throw new Error(`Refusing to print a key that fails validation: ${validation.error}`);
  }

  log('');
  log('License Key Generated Successfully');
  log('===================================');
  log('');
  log(`License ID: ${validation.licenseId}`);
  log('');
  log('License Key:');
  log(key);
  log('');
  log('Activation (inside the project):');
  log(`  vibecarbon activate ${key}`);
  log('');

  return { printed: true, key, validation };
}

function main() {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Only run the CLI behavior when invoked directly (`node
// scripts/generate-license.js`), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
