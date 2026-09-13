#!/usr/bin/env node
/**
 * License Key Generator for Vibecarbon
 *
 * Mints cryptographically signed license keys using Ed25519, in both
 * formats validator.js understands:
 *
 *   v2 (default): a per-project subscription key.
 *     vc2-<t>-<customerId>-<projectId32>-<yyyymmdd>-<signature>
 *     t: g (Graphene) | f (Fullerene)
 *   v1 (-legacy): the old lifetime, global key. Always Fullerene.
 *     vc-f-<customerId>-<signature>
 *
 * signedMessage/parseLicenseKey/validateLicenseKey are imported from
 * validator.js rather than reimplemented here, so minting and verifying can
 * never drift apart. Every minted key is round-tripped through
 * validateLicenseKey (against the public key derived from the same private
 * key) before it is ever printed; a key that fails that check is never
 * shown.
 *
 * Usage (single-dash flags; a double-dash spelling of each is also
 * accepted, since older docs/scripts still call this with --tier etc.):
 *
 *   VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js \
 *     -project 11111111-2222-3333-4444-555555555555 -months 1 -email user@acme.com
 *
 *   VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js -legacy -email user@acme.com
 *
 * Environment:
 *   VIBECARBON_LICENSE_PRIVATE_KEY - Ed25519 private key in PEM format (required)
 *
 * Options:
 *   -legacy                 Mint a v1 (legacy, lifetime) key instead of v2.
 *                            Implies -tier fullerene; -project and the
 *                            paid-through options are not used.
 *   -tier <tier>            v2 tier: graphene | fullerene (default: graphene)
 *   -customer <id>          8-character hex customer ID
 *   -email <email>          Customer email (generates ID from hash, alternative to -customer)
 *   -project <uuid>         Project UUID this key is scoped to (required for v2)
 *   -paid-through <date>    Paid-through date, YYYY-MM-DD (v2; one of -paid-through/-months required)
 *   -months <n>             Paid-through n calendar months from today UTC (v2; alternative to -paid-through)
 *   -help                   Show this help message
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { parseLicenseKey, signedMessage, validateLicenseKey } from '../src/lib/licensing/validator.js';

const V2_TIER_CHARS = { graphene: 'g', fullerene: 'f' };

function showHelp() {
  console.log(`
Vibecarbon License Generator

Usage:
  VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js [options]

Options:
  -legacy                 Mint a v1 (legacy, lifetime) key instead of v2.
                           Implies -tier fullerene; -project and the
                           paid-through options are not used.
  -tier <tier>             v2 tier: graphene | fullerene (default: graphene)
  -customer <id>           8-character hex customer ID
  -email <email>           Customer email (generates ID from hash, alternative to -customer)
  -project <uuid>          Project UUID this key is scoped to (required for v2)
  -paid-through <date>     Paid-through date, YYYY-MM-DD (v2; one of -paid-through/-months required)
  -months <n>              Paid-through n calendar months from today UTC (v2; alternative to -paid-through)
  -help                    Show this help message

Examples:
  # v2 Graphene key, paid through a fixed date
  node scripts/generate-license.js -project <uuid> -paid-through 2027-01-31 -email user@acme.com

  # v2 Fullerene key, paid through one calendar month from today
  node scripts/generate-license.js -tier fullerene -project <uuid> -months 1 -customer a7f2b9c1

  # Legacy (v1) lifetime key
  node scripts/generate-license.js -legacy -email user@acme.com

Environment:
  VIBECARBON_LICENSE_PRIVATE_KEY must be set to the Ed25519 private key in PEM format.
`);
}

/**
 * Parse argv. Accepts both `-flag` and `--flag` spellings for every named
 * option (see the module doc comment for why).
 * @param {string[]} args
 */
export function parseArgs(args) {
  const parsed = {
    legacy: false,
    tier: 'graphene',
    customer: null,
    email: null,
    project: null,
    paidThrough: null,
    months: null,
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
    } else if (is(arg, 'tier')) {
      parsed.tier = nextArg;
      i++;
    } else if (is(arg, 'customer')) {
      parsed.customer = nextArg;
      i++;
    } else if (is(arg, 'email')) {
      parsed.email = nextArg;
      i++;
    } else if (is(arg, 'project')) {
      parsed.project = nextArg;
      i++;
    } else if (is(arg, 'paid-through')) {
      parsed.paidThrough = nextArg;
      i++;
    } else if (is(arg, 'months')) {
      parsed.months = nextArg;
      i++;
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

/**
 * `months` calendar months ahead of `now`, in UTC, clamped to the last day
 * of the target month when it's shorter (Jan 31 + 1 month = Feb 28/29).
 * @param {number} months
 * @param {Date} [now]
 * @returns {string} `'YYYY-MM-DD'`
 */
export function monthsAheadUTC(months, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const targetMonth = month + months;
  // Date.UTC(y, m + 1, 0) is the last day of month m (0-indexed) — the
  // standard trick for "how many days are in this month", and it stays
  // correct across the year rollover Date.UTC already normalizes for us.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(Date.UTC(year, targetMonth, clampedDay)).toISOString().slice(0, 10);
}

/**
 * Resolve the paid-through date for a v2 key from `-paid-through` or
 * `-months` (exactly one required; no default).
 * @param {{ paidThrough: string|null, months: string|null }} opts
 * @param {Date} [now]
 * @returns {string} `'YYYY-MM-DD'`
 */
export function resolvePaidThrough({ paidThrough, months }, now = new Date()) {
  if (paidThrough && months) {
    throw new Error('Pass only one of -paid-through or -months, not both');
  }
  if (paidThrough) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidThrough)) {
      throw new Error('-paid-through must be YYYY-MM-DD');
    }
    return paidThrough;
  }
  if (months != null) {
    const n = Number(months);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('-months must be a non-negative integer');
    }
    return monthsAheadUTC(n, now);
  }
  throw new Error('-paid-through <date> or -months <n> is required for a v2 key');
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
 * Mint a v2 key: vc2-<t>-<customerId>-<projectId32>-<yyyymmdd>-<signature>.
 * @param {string} privateKeyPem
 * @param {{ tier: string, customerId: string, projectId: string, paidThrough: string }} opts
 */
export function mintV2Key(privateKeyPem, { tier, customerId, projectId, paidThrough }) {
  const tierChar = V2_TIER_CHARS[tier];
  if (!tierChar) {
    throw new Error(`Invalid tier: ${tier}. Valid v2 tiers: graphene, fullerene`);
  }
  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    throw new Error('Customer ID must be exactly 8 lowercase hex characters');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId || '')) {
    throw new Error('-project must be a UUID (8-4-4-4-12 hex)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidThrough)) {
    throw new Error('paidThrough must be YYYY-MM-DD');
  }

  const normalizedProjectId = projectId.toLowerCase();
  const projectId32 = normalizedProjectId.replace(/-/g, '');
  const yyyymmdd = paidThrough.replace(/-/g, '');
  const message = signedMessage({
    format: 'v2',
    tierChar,
    customerId,
    projectId: normalizedProjectId,
    paidThrough,
  });
  const signature = sign(null, Buffer.from(message), createPrivateKey(privateKeyPem));
  return `vc2-${tierChar}-${customerId}-${projectId32}-${yyyymmdd}-${signature.toString('hex')}`;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Run the generator end to end (parse -> resolve customer -> mint ->
 * round-trip validate -> print). Split out from `main()` so tests can call
 * it directly against an ephemeral keypair instead of spawning a process.
 * @param {string[]} args
 * @param {{ privateKeyPem?: string, log?: (s: string) => void, now?: Date }} [options]
 */
export function run(args, { privateKeyPem, log = console.log, now } = {}) {
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

  const tier = opts.legacy ? 'fullerene' : opts.tier;

  let key;
  if (opts.legacy) {
    key = mintV1Key(resolvedPrivateKeyPem, { customerId });
  } else {
    const paidThrough = resolvePaidThrough(opts, now);
    key = mintV2Key(resolvedPrivateKeyPem, { tier, customerId, projectId: opts.project, paidThrough });
  }

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
  log(`Tier:       ${capitalize(validation.tier)}`);
  if (customerEmail) {
    log(`Email:      ${customerEmail}`);
  }
  log(`Customer:   ${validation.customerId}`);
  if (validation.format === 'v2') {
    log(`Project:    ${validation.projectId}`);
    log(`Paid through: ${validation.paidThrough}`);
  } else {
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

// Re-exported for a test that wants to inspect the minted key directly
// without a second import of validator.js.
export { parseLicenseKey };

// Only run the CLI behavior when invoked directly (`node
// scripts/generate-license.js`), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
