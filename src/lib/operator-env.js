/**
 * Normalizes and validates operator-facing config values (the credentials
 * `configure` writes to `.env.local`/`.env` and the values other commands
 * read straight from `process.env`), against the shape metadata carried by
 * each `CONFIG_KEYS` entry in `config-registry.js`.
 *
 * The problem two failure modes this exists to catch: an operator pastes a
 * value with a trailing newline or surrounding quotes from a vendor console,
 * or a value simply doesn't match the shape the vendor documents (wrong
 * length, wrong prefix, out-of-range port, …). `normalizeOperatorValue`
 * repairs the former silently (recording what it fixed); `validateOperatorValue`
 * reports the latter as a message that names the variable and the expected
 * shape but NEVER echoes the value itself — these are credentials, and even
 * a rejected one shouldn't end up in a log or terminal scrollback.
 *
 * Dependency-free by design (imports only `config-registry.js` and node
 * builtins) so deploy code and `configure` can both import this without
 * pulling in prompt/UI libraries.
 */

import { isIPv4, isIPv6 } from 'node:net';
import { EMAIL_REGEX, entriesForScopes, registryEntry } from './config-registry.js';

const HOSTNAME_REGEX =
  /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * One `cidr-list` element: an IPv4 or IPv6 address with an optional `/mask`
 * (0-32 for v4, 0-128 for v6). Nobody documents a format for the allowlist
 * this feeds (ALLOWED_SSH_IPS), and the firewall-rule parser it reaches
 * always accepted bare addresses and IPv6 — so the only things rejected are
 * ones that are not addresses at all (review 2026-09-19: an IPv4-CIDR-only
 * regex here turned away `203.0.113.5` and `2001:db8::1/128`).
 * @param {string} part
 */
function isAddressOrCidr(part) {
  const slash = part.indexOf('/');
  const addr = slash === -1 ? part : part.slice(0, slash);
  const mask = slash === -1 ? null : part.slice(slash + 1);
  const maxMask = isIPv4(addr) ? 32 : isIPv6(addr) ? 128 : -1;
  if (maxMask === -1) return false;
  if (mask === null) return true;
  return /^\d{1,3}$/.test(mask) && Number(mask) <= maxMask;
}

/**
 * Fallback checks for `kind`s that describe a format but, on a given
 * registry entry, carry no `shape` of their own (e.g. `SMTP_HOST` is
 * `kind: 'hostname'` with no regex — the registry deliberately doesn't pin
 * a format it can't back up with a vendor spec, but "is this a hostname" is
 * still worth checking). Only consulted when `entry.shape` is absent —
 * anything with a `shape` is validated from that shape alone.
 */
const KIND_FALLBACKS = {
  port: {
    describe: '1-65535',
    test: (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535,
  },
  email: { describe: 'an email address', test: (v) => EMAIL_REGEX.test(v) },
  hostname: { describe: 'a hostname', test: (v) => HOSTNAME_REGEX.test(v) },
  url: {
    describe: 'a URL',
    test: (v) => {
      try {
        // eslint-disable-next-line no-new
        new URL(v);
        return true;
      } catch {
        return false;
      }
    },
  },
  'cidr-list': {
    describe: 'comma-separated IPv4/IPv6 addresses or CIDRs like 203.0.113.0/24',
    test: (v) => v.split(',').every((part) => isAddressOrCidr(part.trim())),
  },
  pem: {
    describe: 'a PEM block (or its base64 encoding)',
    test: (v) => v.includes('-----BEGIN') && v.includes('-----END'),
  },
};

/** True when `str` starts and ends with the same quote character. */
function isQuoteWrapped(str) {
  if (str.length < 2) return false;
  const first = str[0];
  const last = str[str.length - 1];
  return (first === '"' || first === "'") && first === last;
}

/**
 * Normalize a raw env-var string against its registry entry: trims
 * whitespace, strips one pair of matching surrounding quotes, strips a
 * `Bearer ` prefix (token kind only), and — for `kind: 'pem'` — expands
 * literal `\n` escapes or decodes a base64-wrapped PEM. Reimplements the PEM
 * normalization in `scripts/generate-license.js` (`normalizePem`, which
 * carries the matching cross-reference back here); kept duplicated rather
 * than imported so this lib stays dependency-free of the scripts directory.
 * The two are intentionally NOT unified yet (review 2026-09-19, M13) — a
 * change to either's accepted encodings must be mirrored in the other.
 * @param {string | null | undefined} raw
 * @param {import('./config-registry.js').ConfigKey} entry
 * @returns {{ value: string, fixed: string[] }}
 */
export function normalizeOperatorValue(raw, entry) {
  if (raw == null) return { value: '', fixed: [] };

  const fixed = [];
  let value = raw;

  const trimmed = value.trim();
  if (trimmed !== value) fixed.push('trimmed whitespace');
  value = trimmed;

  if (isQuoteWrapped(value)) {
    value = value.slice(1, -1);
    fixed.push('stripped surrounding quotes');
  }

  if (entry.kind === 'token' && value.startsWith('Bearer ')) {
    value = value.slice('Bearer '.length);
    fixed.push('removed "Bearer " prefix');
  }

  if (entry.kind === 'pem') {
    if (!value.includes('\n') && value.includes('\\n')) {
      value = value.replace(/\\n/g, '\n');
      fixed.push('expanded \\n escapes');
    }
    if (!value.startsWith('-----BEGIN')) {
      const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
      // Only trust the decode if it actually looks like a PEM block — base64
      // decoding a non-base64, non-PEM string still "succeeds" (Node ignores
      // invalid characters) and would otherwise silently replace the value
      // with garbage. Leave the original untouched when it doesn't pan out;
      // validateOperatorValue's pem fallback below is what reports the
      // problem.
      if (decoded.startsWith('-----BEGIN')) {
        value = decoded;
        fixed.push('decoded base64');
      }
    }
  }

  return { value, fixed };
}

/**
 * Validate an already-normalized (or raw, for a live preview) value against
 * its registry entry's shape. Returns `null` when it's fine, or a problem
 * string naming the variable, the expected shape, and the observed length —
 * never the value itself. When the RAW input looks like a classic paste
 * mistake (trailing newline, surrounding quotes), a hint is appended.
 *
 * `opts.raw` is the un-normalized string the caller started from. Every
 * caller validates the NORMALIZED value (so a quote-wrapped but otherwise
 * valid paste is accepted, not nagged about), which means the hint can only
 * fire if the raw string is threaded through separately — without it the
 * quotes/newline have already been stripped by the time this runs and the
 * hint was unreachable (review 2026-09-19, M10). Defaults to `value`, so a
 * caller validating a raw string directly still gets the hint.
 * @param {string} value
 * @param {import('./config-registry.js').ConfigKey} entry
 * @param {{ raw?: string }} [opts]
 * @returns {string | null}
 */
export function validateOperatorValue(value, entry, { raw: rawInput } = {}) {
  const raw = value ?? '';
  const pasted = rawInput ?? raw;

  if (raw === '') {
    return entry.optional ? null : `${entry.key} is not set`;
  }

  const shape = entry.shape;
  let ok = true;
  let describe;

  if (shape?.regex) {
    describe = shape.describe;
    ok = shape.regex.test(raw);
  } else if (shape?.values) {
    describe = shape.describe;
    ok = shape.values.includes(raw);
  } else if (shape?.minLen !== undefined) {
    describe = shape.describe;
    ok = raw.length >= shape.minLen && (shape.maxLen === undefined || raw.length <= shape.maxLen);
  } else {
    const fallback = KIND_FALLBACKS[entry.kind];
    if (fallback) {
      describe = fallback.describe;
      ok = fallback.test(raw);
    }
  }

  if (ok) return null;

  let problem = `${entry.key} looks wrong: expected ${describe}, got ${raw.length} characters`;
  if (pasted.endsWith('\n')) {
    problem += ' — a trailing newline?';
  } else if (isQuoteWrapped(pasted.trim())) {
    problem += ' — surrounding quotes?';
  }
  return problem;
}

/**
 * Read `key` from `env`, normalize it against its registry entry (if any),
 * and validate the result. A key with no registry entry passes through
 * completely untouched — no normalization, no problem. An empty/missing
 * value normalizes to `null`, never `''`.
 * @param {string} key
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 * @returns {{ value: string | null, problem: string | null, fixed: string[] }}
 */
export function readOperatorVar(key, { env = process.env } = {}) {
  const entry = registryEntry(key);
  const raw = env[key];

  if (!entry) {
    return { value: raw ?? null, problem: null, fixed: [] };
  }

  const { value, fixed } = normalizeOperatorValue(raw, entry);
  const problem = validateOperatorValue(value, entry, { raw: raw ?? '' });
  return { value: value === '' ? null : value, problem, fixed };
}

/**
 * Walk every registry entry whose `scope` is one of `scopes` (in registry
 * order), plus any individually-named `keys` not already covered by those
 * scopes, and collect the read problems.
 *
 * `presence` distinguishes two callers with different tolerances for an
 * ABSENT (not merely malformed) value: a gate running before an interactive
 * prompt would otherwise fill the value in (`presence: false`) must let a
 * missing credential through — that's what the prompt is FOR — while a gate
 * that is the last stop before real provisioning (`presence: true`, the
 * default) must not. Either way, a value that IS present but malformed is
 * always a problem — `presence` only ever suppresses the "X is not set"
 * case (detected via `readOperatorVar`'s `value === null`, which is exactly
 * "raw was empty/absent", never a shape failure — a shape failure always
 * has a non-empty `value`).
 *
 * `keys` exists for a value whose OWN scope would be too broad for a given
 * caller to ask for — e.g. a cross-cloud native-DNS pick reads a sibling
 * compute provider's token (`resolveDnsToken`'s same-token rule falling
 * through to the row's `tokenEnv`) without that deploy using anything else
 * scoped to that provider, so checking `provider:<thatId>` wholesale would
 * wrongly demand ITS S3/object-storage keys too. A key already covered by
 * `scopes` is not checked twice.
 *
 * @param {Iterable<string>} scopes
 * @param {{ env?: Record<string, string | undefined>, presence?: boolean, keys?: string[] }} [opts]
 * @returns {{ problems: string[], checked: string[] }}
 */
export function checkOperatorConfig(
  scopes,
  { env = process.env, presence = true, keys = [] } = {},
) {
  const entries = [...entriesForScopes(scopes)];
  const covered = new Set(entries.map((e) => e.key));
  for (const key of keys) {
    if (covered.has(key)) continue;
    const extra = registryEntry(key);
    if (extra) {
      entries.push(extra);
      covered.add(key);
    }
  }

  const problems = [];
  const checked = [];

  for (const entry of entries) {
    checked.push(entry.key);
    const { value, problem } = readOperatorVar(entry.key, { env });
    if (!problem) continue;
    if (!presence && value === null) continue; // absent, not malformed — tolerated
    problems.push(problem);
  }

  return { problems, checked };
}
