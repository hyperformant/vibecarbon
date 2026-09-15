#!/usr/bin/env node
/**
 * License Key Generator for Vibecarbon
 *
 * Mints cryptographically signed license keys using Ed25519, in both
 * formats validator.js understands:
 *
 *   v2 (default): a per-project, per-customer key. Carries no tier and no
 *     date: those live on vibecarbon.com and reach the CLI as a signed
 *     verdict token (signVerdictToken below mints one for tests/diagnosis).
 *     vc2-<customerId>-<projectId32>-<signature>
 *   v1 (-legacy): the old lifetime, global key. Always Fullerene.
 *     vc-f-<customerId>-<signature>
 *
 * signedMessage/validateLicenseKey are imported from validator.js rather
 * than reimplemented here, so minting and verifying can never drift apart.
 * Every minted key is round-tripped through
 * validateLicenseKey (against the public key derived from the same private
 * key) before it is ever printed; a key that fails that check is never
 * shown.
 *
 * Usage (single-dash flags; a double-dash spelling of each is also
 * accepted, since older docs/scripts still call this with --project etc.):
 *
 *   VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js \
 *     -project 11111111-2222-3333-4444-555555555555 -email user@acme.com
 *
 *   VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js -legacy -email user@acme.com
 *
 * Environment:
 *   VIBECARBON_LICENSE_PRIVATE_KEY - Ed25519 private key in PEM format (required)
 *
 * Options:
 *   -legacy                 Mint a v1 (legacy, lifetime) key instead of v2.
 *                            -project is not used.
 *   -customer <id>           8-character hex customer ID
 *   -email <email>           Customer email (generates ID from hash, alternative to -customer)
 *   -project <uuid>          Project UUID this key is scoped to (required for v2)
 *   -help                    Show this help message
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  signedMessage,
  validateLicenseKey,
  VERDICT_STATUSES,
  VERDICT_TIERS,
} from '../src/lib/licensing/validator.js';

/** 'YYYY-MM-DD', the only date shape signVerdictToken accepts. */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function showHelp() {
  console.log(`
Vibecarbon License Generator

Usage:
  VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js [options]

Options:
  -legacy                 Mint a v1 (legacy, lifetime) key instead of v2.
                           -project is not used.
  -customer <id>           8-character hex customer ID
  -email <email>           Customer email (generates ID from hash, alternative to -customer)
  -project <uuid>          Project UUID this key is scoped to (required for v2)
  -help                    Show this help message

Examples:
  # v2 key, scoped to a project
  node scripts/generate-license.js -project <uuid> -email user@acme.com

  # Legacy (v1) lifetime key
  node scripts/generate-license.js -legacy -email user@acme.com

Environment:
  VIBECARBON_LICENSE_PRIVATE_KEY must be set to the Ed25519 private key in PEM format.
`);
}

/**
 * Parse argv. Accepts both `-flag` and `--flag` spellings for every named
 * option (see the module doc comment for why). Any other flag-shaped
 * argument (leading `-`) is rejected: this is what turns a retired flag
 * like `-tier` or `-paid-through` into a loud error instead of being
 * silently ignored.
 * @param {string[]} args
 */
export function parseArgs(args) {
  const parsed = {
    legacy: false,
    customer: null,
    email: null,
    project: null,
    help: false,
  };

  /** True when `arg` is `-name` or `--name`. */
  const is = (arg, name) => arg === `-${name}` || arg === `--${name}`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (is(arg, 'help') || arg === '-h') {
      parsed.help = true;
    } else if (is(arg, 'legacy')) {
      parsed.legacy = true;
    } else if (is(arg, 'customer')) {
      parsed.customer = nextArg;
      i++;
    } else if (is(arg, 'email')) {
      parsed.email = nextArg;
      i++;
    } else if (is(arg, 'project')) {
      parsed.project = nextArg;
      i++;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return parsed;
}

/**
 * Generate a deterministic 8-character hex customer ID from an email address
 * Uses SHA-256 hash, takes first 8 characters of hex encoding
 */
export function emailToCustomerId(email) {
  const normalized = email.toLowerCase().trim();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.slice(0, 8);
}

/** Derive the Ed25519 public key (PEM, spki) for a private key (PEM, pkcs8). */
export function derivePublicKeyPem(privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Mint a v1 (legacy) key: vc-f-<customerId>-<signature>.
 * @param {string} privateKeyPem
 * @param {{ customerId: string }} opts
 */
export function mintV1Key(privateKeyPem, { customerId }) {
  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    throw new Error('Customer ID must be exactly 8 lowercase hex characters');
  }
  const tierChar = 'f';
  const message = signedMessage({ format: 'v1', tierChar, customerId });
  const signature = sign(null, Buffer.from(message), createPrivateKey(privateKeyPem));
  return `vc-${tierChar}-${customerId}-${signature.toString('hex')}`;
}

/**
 * Mint a v2 key: vc2-<customerId>-<projectId32>-<signature>. No tier, no
 * date: both live on vibecarbon.com and arrive as a signed verdict.
 */
export function mintV2Key(privateKeyPem, { customerId, projectId }) {
  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    throw new Error('Customer ID must be exactly 8 lowercase hex characters');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId || '')) {
    throw new Error('-project must be a UUID (8-4-4-4-12 hex)');
  }
  const normalizedProjectId = projectId.toLowerCase();
  const message = signedMessage({ format: 'v2', customerId, projectId: normalizedProjectId });
  const signature = sign(null, Buffer.from(message), createPrivateKey(privateKeyPem));
  return `vc2-${customerId}-${normalizedProjectId.replace(/-/g, '')}-${signature.toString('hex')}`;
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
  const signature = sign(null, Buffer.from(message), createPrivateKey(privateKeyPem));
  const pid32 = parsed.projectId.replace(/-/g, '');
  return `vcv-${pid32}-${status}-${tier}-${periodEnd.replace(/-/g, '')}-${issued.replace(/-/g, '')}-${signature.toString('hex')}`;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Run the generator end to end (parse -> resolve customer -> mint ->
 * round-trip validate -> print). Split out from `main()` so tests can call
 * it directly against an ephemeral keypair instead of spawning a process.
 * @param {string[]} args
 * @param {{ privateKeyPem?: string, log?: (s: string) => void }} [options]
 */
export function run(args, { privateKeyPem, log = console.log } = {}) {
  const opts = parseArgs(args);

  if (opts.help) {
    showHelp();
    return { printed: false };
  }

  const resolvedPrivateKeyPem = privateKeyPem ?? process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
  if (!resolvedPrivateKeyPem) {
    throw new Error(
      'VIBECARBON_LICENSE_PRIVATE_KEY environment variable is required (Ed25519 private key, PEM format)',
    );
  }

  let customerId = opts.customer;
  const customerEmail = opts.email;
  if (!customerId && !customerEmail) {
    throw new Error('-customer <id> or -email <email> is required');
  }
  if (customerEmail) {
    customerId = emailToCustomerId(customerEmail);
  }

  const key = opts.legacy
    ? mintV1Key(resolvedPrivateKeyPem, { customerId })
    : mintV2Key(resolvedPrivateKeyPem, { customerId, projectId: opts.project });

  // Round-trip through the same parser/verifier a customer's CLI runs, so a
  // key that would not actually activate is never handed out.
  const publicKeyPem = derivePublicKeyPem(resolvedPrivateKeyPem);
  const validation = validateLicenseKey(key, { publicKeyPem });
  if (!validation.valid) {
    throw new Error(`Refusing to print a key that fails validation: ${validation.error}`);
  }

  log('');
  log('License Key Generated Successfully');
  log('===================================');
  log('');
  if (customerEmail) {
    log(`Email:      ${customerEmail}`);
  }
  log(`Customer:   ${validation.customerId}`);
  if (validation.format === 'v2') {
    log('Format:     v2');
    log(`Project:    ${validation.projectId}`);
  } else {
    log(`Tier:       ${capitalize(validation.tier)}`);
    log('Expires:    Never');
  }
  log('');
  log('License Key:');
  log(key);
  log('');
  log('Activation:');
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
