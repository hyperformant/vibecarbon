#!/usr/bin/env node
/**
 * License Key Generator for Vibecarbon
 *
 * Generates cryptographically signed license keys using Ed25519.
 * Licenses never expire.
 *
 * Key format: vc-<tier>-<customer_id>-<signature>
 *   tier: f (Fullerene) — the only issuable self-serve tier. Agency
 *     customers are issued a Fullerene-tier key too; their client-and-
 *     enterprise deployment rights and custom terms are granted separately
 *     via a signed agreement, not encoded in the key.
 *   customer_id: 8-character hex identifier
 *   signature: Ed25519 hex-encoded signature
 *
 * Usage:
 *   VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js --tier fullerene --email user@acme.com
 *
 * Environment:
 *   VIBECARBON_LICENSE_PRIVATE_KEY - Ed25519 private key in PEM format (required)
 *
 * Options:
 *   --tier <tier>        License tier: fullerene (default: fullerene)
 *   --customer <id>      8-character hex customer ID (required unless --email)
 *   --email <email>      Customer email (generates ID from hash, alternative to --customer)
 *   --help               Show this help message
 */

import { sign, createPrivateKey, createHash } from 'node:crypto';

function showHelp() {
  console.log(`
Vibecarbon License Generator

Usage:
  VIBECARBON_LICENSE_PRIVATE_KEY="..." node scripts/generate-license.js [options]

Options:
  --tier <tier>        License tier: fullerene (default: fullerene)
  --customer <id>      8-character hex customer ID
  --email <email>      Customer email (generates ID from hash, alternative to --customer)
  --help               Show this help message

Examples:
  # Generate a Fullerene license using email
  node scripts/generate-license.js --tier fullerene --email user@acme.com

  # Generate a Fullerene license with explicit customer ID
  node scripts/generate-license.js --tier fullerene --customer a7f2b9c1

Environment:
  VIBECARBON_LICENSE_PRIVATE_KEY must be set to the Ed25519 private key in PEM format.
`);
}

function parseArgs(args) {
  const parsed = {
    tier: 'fullerene',
    customer: null,
    email: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--tier' || arg === '-t') {
      parsed.tier = nextArg;
      i++;
    } else if (arg === '--customer' || arg === '-c') {
      parsed.customer = nextArg;
      i++;
    } else if (arg === '--email') {
      parsed.email = nextArg;
      i++;
    }
  }

  return parsed;
}

/**
 * Generate a deterministic 8-character hex customer ID from an email address
 * Uses SHA-256 hash, takes first 8 characters of hex encoding
 */
function emailToCustomerId(email) {
  const normalized = email.toLowerCase().trim();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.slice(0, 8);
}

// Tier character mapping
const TIER_CHARS = { fullerene: 'f' };

function generateLicenseKey(privateKeyPem, tier, customerId) {
  const tierChar = TIER_CHARS[tier];
  if (!tierChar) {
    throw new Error(`Invalid tier: ${tier}`);
  }

  // Validate customer ID (8 hex characters)
  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    throw new Error('Customer ID must be exactly 8 lowercase hex characters');
  }

  // Create the message to sign: <tierChar>-<customerId>
  const message = `${tierChar}-${customerId}`;

  // Sign the message with Ed25519
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(message), privateKey);

  // Encode signature as lowercase hex
  const signatureHex = signature.toString('hex');

  // Construct the license key: vc-<tierChar>-<customerId>-<signatureHex>
  return `vc-${tierChar}-${customerId}-${signatureHex}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Check for private key
  const privateKeyPem = process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
  if (!privateKeyPem) {
    console.error('Error: VIBECARBON_LICENSE_PRIVATE_KEY environment variable is required');
    console.error('');
    console.error('Set it to your Ed25519 private key in PEM format:');
    console.error('  export VIBECARBON_LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----...');
    process.exit(1);
  }

  // Resolve customer ID from --customer or --email
  let customerId = args.customer;
  let customerEmail = args.email;

  if (!customerId && !customerEmail) {
    console.error('Error: --customer or --email is required');
    console.error('');
    console.error('Provide a customer ID or email:');
    console.error('  --customer a7f2b9c1');
    console.error('  --email user@acme.com');
    process.exit(1);
  }

  if (customerEmail) {
    customerId = emailToCustomerId(customerEmail);
  }

  // Validate tier
  const validTiers = ['fullerene'];
  if (!validTiers.includes(args.tier)) {
    console.error(`Error: Invalid tier "${args.tier}"`);
    console.error('');
    console.error('Valid tiers: fullerene');
    process.exit(1);
  }

  try {
    const licenseKey = generateLicenseKey(privateKeyPem, args.tier, customerId);

    console.log('');
    console.log('License Key Generated Successfully');
    console.log('==================================');
    console.log('');
    console.log(`Tier:       ${args.tier.charAt(0).toUpperCase() + args.tier.slice(1)}`);
    if (customerEmail) {
      console.log(`Email:      ${customerEmail}`);
    }
    console.log(`Customer:   ${customerId}`);
    console.log(`Expires:    Never`);
    console.log('');
    console.log('License Key:');
    console.log(licenseKey);
    console.log('');
    console.log('Activation:');
    console.log(`  vibecarbon activate ${licenseKey}`);
    console.log('');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
