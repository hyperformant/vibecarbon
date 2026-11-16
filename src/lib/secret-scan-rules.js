/**
 * The secret-scan rule set: what counts as a secret, how a match is
 * confirmed, what the allowlist suppresses, and which files are never opened.
 *
 * Two scanners run on it and must agree: the CLI's deploy gate
 * (src/lib/secret-scan.js) and the pre-commit scanner every generated project
 * carries (scripts/secret-scan.mjs).
 *
 * This file is copied byte-for-byte to carbon/scripts/lib/secret-scan-rules.js
 * (template projects cannot import the CLI);
 * tests/unit/security/secret-scan-rules-census.test.ts enforces the lockstep
 * and that neither scanner defines a rule of its own. Edit
 * src/lib/secret-scan-rules.js, then copy it over the template's. Keep it
 * dependency-free: no imports at all, language built-ins and the `Buffer`
 * global only.
 *
 * The patterns are intentionally biased toward LOW false-positive rates:
 *  - Each rule includes both a primary regex and (where useful) a context
 *    regex that the surrounding 256 chars must also match. This prevents
 *    a stray 40-char alphanumeric in a docs file from tripping the
 *    "Hetzner token" rule.
 *  - JWT detection is gated on the *decoded* payload claim: a JWT is only
 *    flagged if its base64url-decoded payload carries a privileged `role`.
 *  - Allowlist support: `.vibecarbonignore` at the repo root holds literal
 *    substrings or `regex:<pattern>` lines that suppress matches.
 */

/**
 * @typedef {object} SecretRule
 * @property {string} id - stable identifier (used in allowlist + reports)
 * @property {string} description - human-readable name shown to operators
 * @property {RegExp} pattern - primary detection regex
 * @property {RegExp} [context] - optional context regex (must also match
 *   the surrounding ±128 chars). Use to dampen false positives on rules
 *   that match generic shapes (e.g. 40-char alphanum strings).
 * @property {(match: string, fullMatch: RegExpExecArray) => boolean} [predicate]
 *   - optional extra filter. Receives the matched substring; return false
 *   to discard.
 */

/** @type {SecretRule[]} */
export const SECRET_RULES = [
  {
    id: 'aws-access-key',
    description: 'AWS access key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-key',
    description: 'AWS secret access key',
    pattern:
      /(?:aws[_-]?secret[_-]?access[_-]?key|secretAccessKey)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  {
    id: 'github-pat',
    description: 'GitHub personal access token',
    pattern: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret key',
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
  },
  {
    id: 'stripe-test-key',
    description: 'Stripe test secret key (still sensitive, can drain test ledger)',
    pattern: /\bsk_test_[A-Za-z0-9]{24,}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g,
  },
  {
    id: 'google-service-account-json',
    description: 'Google Cloud service account JSON',
    pattern: /"type"\s*:\s*"service_account"/g,
    context: /"private_key"\s*:\s*"-----BEGIN[ A-Z]+PRIVATE KEY-----/,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'private-key-block',
    description: 'PEM-encoded private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'hetzner-token',
    description: 'Hetzner Cloud API token',
    // Hetzner tokens are 64 alphanumeric chars. Gate on a nearby
    // `hetzner` / `hcloud` identifier so we don't flag every 64-char
    // string in test fixtures or hashes.
    pattern: /['"]([A-Za-z0-9]{64})['"]/g,
    context: /(?:hetzner|hcloud|HCLOUD_TOKEN|HETZNER_API_TOKEN)/i,
  },
  {
    id: 'digitalocean-token',
    description: 'DigitalOcean API token (PAT / OAuth / refresh)',
    // dop_v1_ (personal access token), doo_v1_ (OAuth access token), and
    // dor_v1_ (OAuth refresh token) are all prefix-anchored and followed
    // by 64 hex chars — no context gate needed, the prefix alone is
    // distinctive enough to be a low false-positive signal.
    pattern: /\bdo[por]_v1_[a-f0-9]{64}\b/g,
  },
  {
    id: 'linode-token',
    description: 'Linode API token',
    // Linode PATs are 64 alphanumeric chars with no distinctive prefix —
    // same shape as a Hetzner token. Gate on a nearby `linode` identifier
    // so we don't flag every 64-char string in test fixtures or hashes.
    pattern: /['"]([A-Za-z0-9]{64})['"]/g,
    context: /(?:linode|LINODE_TOKEN|LINODE_API_TOKEN)/i,
  },
  {
    id: 'vultr-token',
    description: 'Vultr API key',
    // Vultr API keys are 36 UPPERCASE alphanumeric chars with no
    // distinctive prefix (live-probed 2026-08-08). Uppercase-only is
    // narrower than the hetzner/linode 64-char alnum shape — lowercase
    // hex hashes and slugs can't match — but 36 chars of [A-Z0-9] is
    // still not distinctive on its own, so gate on a nearby `vultr`
    // identifier the same way. A canonical UUID is also 36 chars but its
    // hyphens break the run, so it can never trip this.
    pattern: /\b([A-Z0-9]{36})\b/g,
    context: /(?:vultr|VULTR_API_KEY|VULTR_API_TOKEN)/i,
  },
  {
    id: 'scaleway-access-key',
    description: 'Scaleway access key',
    // Scaleway access keys are exactly `SCW` + 17 uppercase alphanumerics
    // (SDK validator ^SCW[A-Z0-9]{17}$, validation/is.go). The prefix is
    // distinctive enough that no context gate is needed — same class as
    // the dop_v1_/AKIA prefix rules above. NOTE: unlike most rules here
    // the access key is only HALF a credential (the UUID secret key signs
    // requests), but it identifies the account and never belongs in a
    // repo, so it's flagged on its own.
    pattern: /\bSCW[A-Z0-9]{17}\b/g,
  },
  {
    id: 'scaleway-secret-key',
    description: 'Scaleway secret key',
    // The secret key is a bare UUID — the least distinctive shape in this
    // file. A proximity context gate (the hetzner/linode pattern) is NOT
    // enough here: SCALEWAY_DEFAULT_PROJECT_ID is ALSO a UUID and lives on
    // the adjacent line of any Scaleway .env block, so gating a bare-UUID
    // match on nearby "scaleway" text would flag the project id — which is
    // an identifier, not a credential (the audit is explicit that
    // conflating the two is how redaction lists get ignored). The
    // assignment itself is therefore the context: this fires only when a
    // UUID is assigned to a secret-key-named variable (the aws-secret-key
    // rule's shape). Var-name spellings: our operator-facing
    // SCALEWAY_SECRET_KEY plus the plugin-native `scw_secret_key`
    // (defensive — a config that used the raw plugin name).
    pattern:
      /(?:SCALEWAY_SECRET(?:_KEY)?|scw[_-]?secret[_-]?key)\s*[:=]\s*['"]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})['"]?/gi,
  },
  {
    id: 'cloudflare-api-token',
    description: 'Cloudflare scoped API token',
    pattern: /\b[A-Za-z0-9_-]{40}\b/g,
    context: /(?:cloudflare|cf[_-]?api[_-]?token|CLOUDFLARE_API_TOKEN)/i,
    predicate: (m) => {
      // Exclude hex (commit shas, hashes).
      if (/^[a-f0-9]+$/i.test(m)) return false;
      // Real Cloudflare API tokens are high-entropy random base62/64;
      // P(all-lowercase) ≈ 10^-12 for a true 40-char token. All-lowercase
      // 40-char strings with hyphen separators are the signature of
      // hyphenated identifiers — kubernetes resource names, project
      // identifiers, and the `${projectName}-${env}-${role}` server names
      // vibecarbon writes to .vibecarbon.json (which collided with the
      // `dnsProvider: 'cloudflare'` context match and false-flagged
      // compose-ha warm-deploy in 2026-05-19 matrix run bq5c4h9l5).
      return /[A-Z]/.test(m);
    },
  },
  {
    id: 'privileged-role-jwt',
    description: 'JWT with a privileged role claim (service_role or admin)',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    predicate: (m) => {
      const payload = decodeJwtPayload(m);
      if (!payload) return false;
      // Only fire on truly privileged role claims. `anon` keys are
      // intentionally public.
      if (payload.role === 'service_role') return true;
      if (payload.role === 'admin') return true;
      return false;
    },
  },
  {
    id: 'generic-secret-assignment',
    description: 'High-entropy value assigned to a secret-named variable',
    // Only fires when the surrounding identifier is suggestive AND the
    // value has high entropy. This is the noisiest rule; the allowlist
    // is the escape hatch.
    pattern:
      /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)\s*[:=]\s*['"]([^'"\s]{20,})['"]/gi,
    predicate: (_m, captured) => {
      const value = captured?.[1];
      if (!value) return false;
      // Variable interpolations are not values. Both $VAR (shell, GH
      // Actions) and ${expr} (Bash, JS template literals) refer to a
      // value defined elsewhere — flagging them just trains operators
      // to ignore the scanner.
      if (/^\$/.test(value)) return false;
      if (/^(?:REPLACE|TODO|CHANGE|YOUR|EXAMPLE|PLACEHOLDER|FIXME)/i.test(value)) return false;
      if (/^(?:local|dev|test|sample|fake|demo)[-_]/i.test(value)) return false;
      return shannonEntropy(value) >= 3.5;
    },
  },
];

/**
 * Decode a JWT's base64url-encoded payload to a JS object.
 * @param {string} jwt
 * @returns {Record<string, unknown> | null}
 */
function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Shannon entropy (bits per symbol) over an ASCII-ish string. Random
 * hex lives ~4.0, random base64 ~5.0; English prose hovers around
 * 3.0-3.5.
 * @param {string} s
 * @returns {number}
 */
function shannonEntropy(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * @typedef {object} SecretFinding
 * @property {string} ruleId - which SecretRule fired
 * @property {string} description - human-readable name
 * @property {string} match - the matched substring (truncated)
 * @property {number} index - byte offset within the scanned content
 * @property {number} line - 1-indexed line number
 * @property {number} column - 1-indexed column number
 */

/**
 * Scan a string buffer (typically a single file's contents) for secret
 * patterns.
 *
 * @param {string} content
 * @param {{allowlist?: string[]}} [options]
 * @returns {SecretFinding[]}
 */
export function scanContent(content, options = {}) {
  const { allowlist = [] } = options;
  if (!content || typeof content !== 'string') return [];
  /** @type {SecretFinding[]} */
  const findings = [];

  for (const rule of SECRET_RULES) {
    // Reset .lastIndex on the global regex between rules so multi-rule
    // scans of the same content don't skip into mid-stream state.
    rule.pattern.lastIndex = 0;
    /** @type {RegExpExecArray | null} */
    let m = rule.pattern.exec(content);
    while (m !== null) {
      const [whole] = m;
      const { index } = m;

      if (rule.context) {
        const start = Math.max(0, index - 128);
        const end = Math.min(content.length, index + whole.length + 128);
        if (!rule.context.test(content.slice(start, end))) {
          m = rule.pattern.exec(content);
          continue;
        }
      }

      if (rule.predicate && !rule.predicate(whole, m)) {
        m = rule.pattern.exec(content);
        continue;
      }

      if (matchesAllowlist(whole, allowlist)) {
        m = rule.pattern.exec(content);
        continue;
      }

      const { line, column } = locateOffset(content, index);
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        match: whole.length > 64 ? `${whole.slice(0, 32)}…${whole.slice(-16)}` : whole,
        index,
        line,
        column,
      });

      m = rule.pattern.exec(content);
    }
  }

  return findings;
}

/**
 * @param {string} value
 * @param {string[]} allowlist
 * @returns {boolean}
 */
function matchesAllowlist(value, allowlist) {
  for (const entry of allowlist) {
    if (!entry || entry.startsWith('#')) continue;
    if (entry.startsWith('regex:')) {
      try {
        const re = new RegExp(entry.slice('regex:'.length));
        if (re.test(value)) return true;
      } catch {
        // ignore malformed regex entries
      }
    } else if (value.includes(entry)) {
      return true;
    }
  }
  return false;
}

/**
 * Convert a byte offset within `content` to (line, column).
 * @param {string} content
 * @param {number} offset
 */
function locateOffset(content, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Parse the text of a `.vibecarbonignore` file into allowlist entries:
 * one per line, blank lines and `#` comments dropped.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseAllowlist(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// File extensions we won't even open. Binary blobs that secrets shouldn't
// appear inside; opening them costs IO + risks regex misfires on bytes
// that happen to look like ASCII secrets.
const SKIP_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.so',
  '.dll',
  '.dylib',
  '.bin',
  '.wasm',
]);

// Lockfiles: machine-written, large, and full of integrity hashes.
const SKIP_BASENAMES = new Set(['package-lock.json', 'pnpm-lock.yaml']);

// Skip any individual file > 1 MiB. Real source files stay well under
// this; minified bundles can be large and noisy without containing
// real secrets.
export const MAX_FILE_BYTES = 1_048_576;

/**
 * Whether a file is skipped on its name alone (a binary extension or a
 * lockfile), before it is opened.
 *
 * @param {string} path - any path to the file; only the basename is read
 * @returns {boolean}
 */
export function skipsPath(path) {
  const base = String(path).split(/[\\/]/).pop() || '';
  if (SKIP_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot > 0 && SKIP_EXTS.has(base.slice(dot).toLowerCase());
}
