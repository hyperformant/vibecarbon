# License Bind-at-Activate — CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CLI accepts one project-less key (`vc-<licenseId16>-<sig>`), binds it to the current project through `POST /api/v1/license/bind` at `vibecarbon activate`, asks for an emailed release at `vibecarbon deactivate`, sends `projectId` on every deploy-time `/check`, and carries no trace of the v1 lifetime or v2 project-bound keys.

**Architecture:** `src/lib/licensing/validator.js` knows the key and verdict string layouts and nothing else. `src/lib/licensing/bind.js` is a pure network client for `/bind` and `/release` (same shape as `check.js`: injectable `fetchImpl`, `env.VIBECARBON_API_BASE`, never throws). `src/lib/licensing/index.js` owns the one storage file (`<project>/.vibecarbon.license`) and orchestrates activate/deactivate/deploy-gate. The test harness runs a local stub of the licence API that signs real verdicts with the signing key, so integration and e2e never touch vibecarbon.com and need no pre-minted key.

**Tech Stack:** Node 22 ESM JavaScript (`src/`), Vitest (TypeScript tests, `unit` / `integration` projects), `@clack/prompts`, Biome, pnpm. `node:http` for the stub.

**Spec:** `docs/superpowers/specs/2026-09-15-license-bind-at-activate-design.md` (this repo). The web half is `~/repos/vibecarbon-web/docs/superpowers/plans/2026-09-15-license-bind-at-activate-web.md`; **its Phase 1 must be deployed before this plan's integration tests are meaningful against a real server, but every test here runs against the stub, so this plan can be executed as soon as the API contract is fixed.**

## Global Constraints

- **Clean sweep.** When done, `grep -rn "vc2\|vc-f\|legacy\|lifetime\|VIBECARBON_TEST_LICENSE_KEY\|listStoredLicenses\|~/.vibecarbon/license\b" src scripts tests docs README.md .github` returns only the census test that asserts this (Task 9).
- Key: `vc-<licenseId16>-<sigHex128>`; signed message is the bare `licenseId`. Verdict token unchanged in layout; `VERDICT_STATUSES` gains `unbound` and `wrong_project`.
- `src/lib/licensing/*.js` may read exactly one env var, `VIBECARBON_API_BASE` (enforced by `tests/unit/licensing/no-dev-bypass.test.ts`; `bind.js` must comply). No clock reads outside the existing allowlist in that test.
- API contract (from the web plan): `POST /bind { key, projectId, cliVersion }` → `200 { projectId, tier, status, periodEnd }` | `409 { error: 'bound_to_other_project' }` | `409 { error: 'project_already_licensed', switchPlan, message }` | `403 { error: 'subscription_inactive' }` | `401 { error: 'unknown_key' | 'bad_signature' }`. `POST /release { key }` → `200 { sent: true }`. `POST /check { key, projectId, cliVersion }` → `{ token, status, tier, projectId, periodEnd, cancelAtPeriodEnd }`.
- Storage: exactly one file, `<projectDir>/.vibecarbon.license`, JSON `{ key, activatedAt, source }`. No `~/.vibecarbon/license`. The verdict cache at `~/.vibecarbon/license-checks/<projectId>.json` is unchanged.
- Commands: `pnpm test:unit`, `pnpm test:integration`, `pnpm lint`. Single file: `pnpm vitest run --project unit tests/unit/licensing/validator.test.ts`.
- Commit after each task; every message ends with `Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y`. The pre-commit hook runs lint + unit; pre-push runs integration too (needs `VIBECARBON_LICENSE_PRIVATE_KEY` in `tests/.env.e2e` after Task 7 — set it from vibecarbon-web's `.env` `LICENSE_SIGNING_PRIVATE_KEY`, base64-decoded to PEM).
- Work in `~/repos/vibecarbon-public-license-bind` on branch `feat/license-bind-at-activate`.

---

## File map

| File | Responsibility after this plan |
|---|---|
| `src/lib/licensing/validator.js` | Parse/verify key + verdict token. Public key embedded. |
| `src/lib/licensing/bind.js` (new) | `bindLicense`, `requestRelease` network clients |
| `src/lib/licensing/check.js` | `/check` client, now sends `projectId` |
| `src/lib/licensing/index.js` | One storage file; `getLicense`, `activateLicense`, `deactivateLicense`, `removeLicenseFile`, `requireDeployEntitlement`, `requireLicense` |
| `src/lib/licensing/entitlement.js` | Decision table + `unbound` / `wrong_project` rows |
| `src/lib/licensing/upsell.js` | Copy for every refusal, no `?project=` |
| `src/activate.js` | `activate [key]`, `deactivate [key] [-rm] [-y]` |
| `scripts/generate-license.js` | `mintKey`, `signVerdictToken`, `--license-id` |
| `tests/e2e/utils/license-stub.js` (new) | In-process licence API stub for integration + e2e |
| `tests/integration/_harness/run-cli.ts` | Fake HOME only; no key |
| `tests/e2e/utils/e2e-env.js` | Starts the stub; child env gets `VIBECARBON_API_BASE` |
| `.github/workflows/test.yml`, `e2e-us-perf.yml` | `VIBECARBON_LICENSE_PRIVATE_KEY` secret replaces `VIBECARBON_TEST_LICENSE_KEY` |
| `docs/specs/billing-modes.md`, `README.md`, `docs/tests.md` | One flow |
| `tests/unit/licensing/no-legacy-traces.test.ts` (new) | The census |

---

### Task 1: Validator — one key format, two new verdict statuses

**Files:**
- Modify: `src/lib/licensing/validator.js`
- Test: `tests/unit/licensing/validator.test.ts` (rewrite), `tests/unit/licensing/signature-verification.test.ts` (update)

**Interfaces:**
- Produces:
  - `parseLicenseKey(key) → { valid: true, format: 'key', licenseId, signature, originalKey } | { valid: false, error }`
  - `validateLicenseKey(key, { publicKeyPem? }) → { valid: true, verified: true, licenseId } | { valid: false, error }`
  - `signedMessage(parsed)`: `'key'` → `parsed.licenseId`; `'verdict'` → unchanged
  - `VERDICT_STATUSES = new Set(['active','past_due','canceled','unbound','wrong_project','none'])`
  - `parseVerdictToken`, `verifyVerdictToken`, `verifySignature` unchanged in signature.
  - Removed: `parseV1`, `parseV2`, `V1_TIER_MAP`, `reHyphenateProjectId` stays (verdicts use it).

- [ ] **Step 1: Rewrite `tests/unit/licensing/validator.test.ts`**

```ts
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseLicenseKey,
  parseVerdictToken,
  signedMessage,
  validateLicenseKey,
  VERDICT_STATUSES,
  verifyVerdictToken,
} from '../../../src/lib/licensing/validator.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const LICENSE_ID = '0123456789abcdef';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function mint(licenseId = LICENSE_ID, key = privateKey): string {
  const sig = sign(null, Buffer.from(licenseId), key).toString('hex');
  return `vc-${licenseId}-${sig}`;
}

describe('parseLicenseKey', () => {
  it('parses vc-<16 hex>-<128 hex>, lowercased and trimmed', () => {
    const parsed = parseLicenseKey(`  ${mint().toUpperCase()} `);
    expect(parsed).toMatchObject({ valid: true, format: 'key', licenseId: LICENSE_ID });
    expect((parsed as { signature: string }).signature).toHaveLength(128);
  });

  it('rejects the retired formats by name', () => {
    expect(parseLicenseKey(`vc-f-deadbeef-${'a'.repeat(128)}`)).toEqual({
      valid: false,
      error: 'Invalid license key format',
    });
    expect(parseLicenseKey(`vc2-deadbeef-${'0'.repeat(32)}-${'a'.repeat(128)}`)).toEqual({
      valid: false,
      error: 'Invalid license key prefix',
    });
  });

  it('rejects wrong lengths, bad prefix, empty', () => {
    expect(parseLicenseKey('').valid).toBe(false);
    expect(parseLicenseKey(`vc-${LICENSE_ID}-${'a'.repeat(127)}`).error).toBe('Invalid signature');
    expect(parseLicenseKey(`vc-${LICENSE_ID.slice(1)}-${'a'.repeat(128)}`).error).toBe(
      'Invalid license ID format',
    );
    expect(parseLicenseKey(`xx-${LICENSE_ID}-${'a'.repeat(128)}`).error).toBe(
      'Invalid license key prefix',
    );
  });
});

describe('signedMessage', () => {
  it('signs the bare licenseId for a key', () => {
    expect(signedMessage({ format: 'key', licenseId: LICENSE_ID })).toBe(LICENSE_ID);
  });
  it('still signs v-… for a verdict', () => {
    expect(
      signedMessage({
        format: 'verdict',
        projectId: PROJECT_ID,
        status: 'active',
        tier: 'graphene',
        periodEnd: '2026-12-31',
        issued: '2026-09-15',
      }),
    ).toBe(`v-${PROJECT_ID.replace(/-/g, '')}-active-graphene-20261231-20260915`);
  });
});

describe('validateLicenseKey', () => {
  it('accepts a key signed by the injected pair and returns only licenseId', () => {
    expect(validateLicenseKey(mint(), { publicKeyPem: PUBLIC_PEM })).toEqual({
      valid: true,
      verified: true,
      licenseId: LICENSE_ID,
    });
  });
  it('rejects a key signed by another pair or with a tampered licenseId', () => {
    const { privateKey: other } = generateKeyPairSync('ed25519');
    expect(validateLicenseKey(mint(LICENSE_ID, other), { publicKeyPem: PUBLIC_PEM }).valid).toBe(false);
    const tampered = mint().replace(LICENSE_ID, 'fedcba9876543210');
    expect(validateLicenseKey(tampered, { publicKeyPem: PUBLIC_PEM }).valid).toBe(false);
  });
  it('never returns valid for the embedded production key with a test signature', () => {
    expect(validateLicenseKey(mint()).valid).toBe(false);
  });
});

describe('verdict tokens', () => {
  it('accepts the two new statuses', () => {
    expect(VERDICT_STATUSES.has('unbound')).toBe(true);
    expect(VERDICT_STATUSES.has('wrong_project')).toBe(true);
    const pid32 = PROJECT_ID.replace(/-/g, '');
    const parsed = parseVerdictToken(`vcv-${pid32}-unbound-none-20260915-20260915-${'a'.repeat(128)}`);
    expect(parsed).toMatchObject({ valid: true, status: 'unbound', tier: 'none', projectId: PROJECT_ID });
  });
  it('verifies a token signed over v-… with the injected pair', () => {
    const pid32 = PROJECT_ID.replace(/-/g, '');
    const msg = `v-${pid32}-wrong_project-none-20260915-20260915`;
    const sig = sign(null, Buffer.from(msg), privateKey).toString('hex');
    expect(verifyVerdictToken(`vcv-${pid32}-wrong_project-none-20260915-20260915-${sig}`, { publicKeyPem: PUBLIC_PEM })).toMatchObject({
      valid: true,
      status: 'wrong_project',
      projectId: PROJECT_ID,
    });
  });
});
```

In `signature-verification.test.ts`, replace every `vc-f-…`/`vc2-…` fixture with `mint()` above and every `tier`/`customerId`/`projectId` assertion on a key with `licenseId`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/licensing/validator.test.ts tests/unit/licensing/signature-verification.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `validator.js`**

Replace the header comment and everything from `const SIG_RE` through `parseLicenseKey` with:

```js
/**
 * License key validator for Vibecarbon
 *
 * One key format and one verdict format share one Ed25519 keypair:
 *
 *   key (per-project subscription; project binding lives on vibecarbon.com):
 *     vc-<license_id_16hex>-<signature>
 *     signed message: <license_id_16hex>
 *     Carries no tier, date, email, or project. `vibecarbon activate` binds
 *     it to the current project through the API; the deploy gate asks the
 *     API whether the binding matches and gets a signed verdict back.
 *
 *   verdict token (server -> CLI, cached per machine):
 *     vcv-<project_id_32hex>-<status>-<tier>-<yyyymmdd periodEnd>-<yyyymmdd issued>-<signature>
 *     signed message: v-<project_id_32hex>-<status>-<tier>-<periodEnd>-<issued>
 *     status: active | past_due | canceled | unbound | wrong_project | none
 *     tier: graphene | fullerene | none
 *
 * - project_id_32hex: the project's UUID with hyphens stripped, lowercase,
 *   re-hyphenated to 8-4-4-4-12 on parse.
 * - signature: Ed25519, lowercase hex, always 128 chars.
 * - The `v-` prefix in the verdict message keeps a key signature and a
 *   verdict signature from ever being replayed as one another.
 *
 * Keys are case-insensitive on input (lowercased before parsing) and
 * whitespace-trimmed. Entitlement (tier/status/periodEnd) comes only from a
 * verified verdict token, never from the key or the wall clock alone.
 */
```

```js
export const VERDICT_STATUSES = new Set([
  'active',
  'past_due',
  'canceled',
  'unbound',
  'wrong_project',
  'none',
]);
export const VERDICT_TIERS = new Set(['graphene', 'fullerene', 'none']);
const SIG_RE = /^[a-f0-9]{128}$/;
const LICENSE_ID_RE = /^[a-f0-9]{16}$/;

/**
 * Parse a license key: vc-<licenseId>-<signature>, exactly 3 parts.
 * Pure shape check; verifySignature() is what makes it trustworthy.
 * @param {string} key
 * @returns {object} `{ valid: true, format: 'key', licenseId, signature, originalKey } | { valid: false, error }`
 */
export function parseLicenseKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'License key is required' };
  }
  const trimmedKey = key.trim().toLowerCase();
  const parts = trimmedKey.split('-');
  if (parts[0] !== 'vc') {
    return { valid: false, error: 'Invalid license key prefix' };
  }
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid license key format' };
  }
  const [, licenseId, signature] = parts;
  if (!LICENSE_ID_RE.test(licenseId)) {
    return { valid: false, error: 'Invalid license ID format' };
  }
  if (!signature || !SIG_RE.test(signature)) {
    return { valid: false, error: 'Invalid signature' };
  }
  return { valid: true, format: 'key', licenseId, signature, originalKey: key.trim() };
}
```

`signedMessage`:

```js
export function signedMessage(parsed) {
  if (parsed.format === 'verdict') {
    const projectId32 = parsed.projectId.replace(/-/g, '');
    return `v-${projectId32}-${parsed.status}-${parsed.tier}-${parsed.periodEnd.replace(/-/g, '')}-${parsed.issued.replace(/-/g, '')}`;
  }
  return parsed.licenseId;
}
```

`validateLicenseKey` returns `{ valid: true, verified: signatureResult.verified, licenseId: parsed.licenseId }`. Delete `parseV1`, `parseV2`, `V1_TIER_MAP`. Keep `parseVerdictToken`, `verifySignature`, `verifyVerdictToken`, `reHyphenateProjectId`, `parseYmd`, `isRealCalendarDate`.

- [ ] **Step 4: Run**

Run: `pnpm vitest run --project unit tests/unit/licensing/validator.test.ts tests/unit/licensing/signature-verification.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/licensing/validator.js tests/unit/licensing/validator.test.ts tests/unit/licensing/signature-verification.test.ts
git commit -m "feat(licensing): one key format, vc-<licenseId>-<sig>; unbound and wrong_project verdicts

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 2: `scripts/generate-license.js` mints the new key

**Files:**
- Modify: `scripts/generate-license.js`
- Test: `tests/unit/licensing/generate-license.test.ts` (rewrite)

**Interfaces:**
- Produces: `mintKey(privateKeyPem, { licenseId }) → string`, `randomLicenseId() → string`, `signVerdictToken(privateKeyPem, { projectId, status, tier, periodEnd, issued })` (unchanged), `derivePublicKeyPem` (unchanged), `parseArgs(args) → { help, licenseId }`, `run(args, { privateKeyPem, log })` → `{ printed, key, validation }`.
- Removed: `mintV1Key`, `mintV2Key`, `emailToCustomerId`, `-legacy`, `-email`, `-customer`, `-project`.

- [ ] **Step 1: Rewrite the test**

```ts
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintKey, parseArgs, randomLicenseId, run, signVerdictToken } from '../../../scripts/generate-license.js';
import { validateLicenseKey, verifyVerdictToken } from '../../../src/lib/licensing/validator.js';
import { derivePublicKeyPem } from '../../../scripts/generate-license.js';

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = derivePublicKeyPem(PEM);

describe('generate-license', () => {
  it('randomLicenseId is 16 hex', () => {
    expect(randomLicenseId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('mintKey produces a key the CLI validator accepts', () => {
    const key = mintKey(PEM, { licenseId: '0123456789abcdef' });
    expect(key).toMatch(/^vc-0123456789abcdef-[0-9a-f]{128}$/);
    expect(validateLicenseKey(key, { publicKeyPem: PUB })).toEqual({ valid: true, verified: true, licenseId: '0123456789abcdef' });
  });

  it('mintKey refuses a bad licenseId', () => {
    expect(() => mintKey(PEM, { licenseId: 'nope' })).toThrow(/licenseId/);
  });

  it('parseArgs reads --license-id / -license-id and -h', () => {
    expect(parseArgs(['--license-id', '0123456789abcdef'])).toEqual({ help: false, licenseId: '0123456789abcdef' });
    expect(parseArgs(['-license-id', '0123456789abcdef'])).toEqual({ help: false, licenseId: '0123456789abcdef' });
    expect(parseArgs(['-h']).help).toBe(true);
    expect(() => parseArgs(['-legacy'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['-email', 'x@y'])).toThrow(/Unknown option/);
  });

  it('run mints a random id when none is given and prints the activate line', () => {
    const lines: string[] = [];
    const out = run([], { privateKeyPem: PEM, log: (l: string) => lines.push(l) });
    expect(out.printed).toBe(true);
    expect(out.key).toMatch(/^vc-[0-9a-f]{16}-[0-9a-f]{128}$/);
    expect(lines.join('\n')).toContain(`vibecarbon activate ${out.key}`);
    expect(lines.join('\n')).toContain(`License ID: ${out.validation.licenseId}`);
  });

  it('run requires the private key', () => {
    const saved = process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
    delete process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
    expect(() => run([])).toThrow(/VIBECARBON_LICENSE_PRIVATE_KEY/);
    if (saved) process.env.VIBECARBON_LICENSE_PRIVATE_KEY = saved;
  });

  it('signVerdictToken still signs unbound / wrong_project verdicts', () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    const t = signVerdictToken(PEM, { projectId: pid, status: 'unbound', tier: 'none', periodEnd: '2026-09-15', issued: '2026-09-15' });
    expect(verifyVerdictToken(t, { publicKeyPem: PUB })).toMatchObject({ valid: true, status: 'unbound', projectId: pid });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/licensing/generate-license.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the script**

Header/usage:

```js
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
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { signedMessage, validateLicenseKey } from '../src/lib/licensing/validator.js';

const LICENSE_ID_RE = /^[0-9a-f]{16}$/;

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

export function derivePublicKeyPem(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

export function mintKey(privateKeyPem, { licenseId }) {
  if (!LICENSE_ID_RE.test(licenseId ?? '')) throw new Error(`licenseId must be 16 lowercase hex, got ${licenseId}`);
  const message = signedMessage({ format: 'key', licenseId });
  const sig = sign(null, Buffer.from(message), createPrivateKey(privateKeyPem)).toString('hex');
  return `vc-${licenseId}-${sig}`;
}
```

Keep `signVerdictToken` as is. `run()`:

```js
export function run(args, { privateKeyPem, log = console.log } = {}) {
  const opts = parseArgs(args);
  if (opts.help) {
    showHelp();
    return { printed: false };
  }
  const pem = privateKeyPem ?? process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
  if (!pem) {
    throw new Error('VIBECARBON_LICENSE_PRIVATE_KEY environment variable is required (Ed25519 private key, PEM format)');
  }
  const licenseId = opts.licenseId ?? randomLicenseId();
  const key = mintKey(pem, { licenseId });
  const validation = validateLicenseKey(key, { publicKeyPem: derivePublicKeyPem(pem) });
  if (!validation.valid) throw new Error(`Refusing to print a key that fails validation: ${validation.error}`);
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
```

Update `showHelp()` to the new usage. Delete `mintV1Key`, `mintV2Key`, `emailToCustomerId`, `capitalize` (if unused), and the `createHash` import if unused.

- [ ] **Step 4: Run**

Run: `pnpm vitest run --project unit tests/unit/licensing/generate-license.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-license.js tests/unit/licensing/generate-license.test.ts
git commit -m "feat(scripts): generate-license mints the project-less key

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 3: `bind.js` — `/bind` and `/release` clients

**Files:**
- Create: `src/lib/licensing/bind.js`
- Test: `tests/unit/licensing/bind.test.ts` (create)

**Interfaces:**
- Produces:
  - `bindLicense({ key, projectId, env = process.env, fetchImpl = fetch, timeoutMs = 10000 }) → Promise<{ ok: true, projectId, tier, status, periodEnd } | { ok: false, reason: 'bound_to_other_project' | 'project_already_licensed' | 'subscription_inactive' | 'unknown_key' | 'unreachable' | 'rejected', message?: string, switchPlan?: boolean, detail?: string }>`
  - `requestRelease({ key, env, fetchImpl, timeoutMs }) → Promise<{ ok: true } | { ok: false, reason: 'unknown_key' | 'unreachable' | 'rejected', detail?: string }>`
- Never throws. Reads only `env.VIBECARBON_API_BASE`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { bindLicense, requestRelease } from '../../../src/lib/licensing/bind.js';

const KEY = `vc-0123456789abcdef-${'a'.repeat(128)}`;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const env = { VIBECARBON_API_BASE: 'http://stub.test' };

function fetchReturning(status: number, body: unknown, ok = status < 400) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('bindLicense', () => {
  it('POSTs key, projectId, cliVersion to /api/v1/license/bind and returns the binding', async () => {
    const fetchImpl = fetchReturning(200, { projectId: PROJECT_ID, tier: 'graphene', status: 'active', periodEnd: '2026-10-15T00:00:00.000Z' });
    const r = await bindLicense({ key: KEY, projectId: PROJECT_ID.toUpperCase(), env, fetchImpl });
    expect(r).toEqual({ ok: true, projectId: PROJECT_ID, tier: 'graphene', status: 'active', periodEnd: '2026-10-15T00:00:00.000Z' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://stub.test/api/v1/license/bind');
    const sent = JSON.parse(String(init.body));
    expect(sent.key).toBe(KEY);
    expect(sent.projectId).toBe(PROJECT_ID);
    expect(typeof sent.cliVersion).toBe('string');
  });

  it('maps the three 4xx refusals', async () => {
    expect(await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(409, { error: 'bound_to_other_project' }) })).toEqual({ ok: false, reason: 'bound_to_other_project' });
    expect(await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(409, { error: 'project_already_licensed', switchPlan: true, message: 'm' }) })).toEqual({ ok: false, reason: 'project_already_licensed', switchPlan: true, message: 'm' });
    expect(await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(403, { error: 'subscription_inactive' }) })).toEqual({ ok: false, reason: 'subscription_inactive' });
    expect(await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(401, { error: 'unknown_key' }) })).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('treats 429/5xx and network errors as unreachable, other JSON errors as rejected', async () => {
    expect((await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(503, { error: 'x' }) })).reason).toBe('unreachable');
    expect((await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(429, {}) })).reason).toBe('unreachable');
    const failing = vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); }) as unknown as typeof fetch;
    const r = await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: failing });
    expect(r).toEqual({ ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' });
    expect((await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: fetchReturning(400, { error: 'invalid_request' }) })).reason).toBe('rejected');
  });

  it('defaults the host to vibecarbon.com', async () => {
    const fetchImpl = fetchReturning(200, { projectId: PROJECT_ID, tier: 'graphene', status: 'active', periodEnd: 'x' });
    await bindLicense({ key: KEY, projectId: PROJECT_ID, env: {}, fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://vibecarbon.com/api/v1/license/bind');
  });
});

describe('requestRelease', () => {
  it('POSTs the key to /release and returns ok on sent:true', async () => {
    const fetchImpl = fetchReturning(200, { sent: true });
    expect(await requestRelease({ key: KEY, env, fetchImpl })).toEqual({ ok: true });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://stub.test/api/v1/license/release');
  });
  it('maps unknown_key, unreachable, rejected', async () => {
    expect(await requestRelease({ key: KEY, env, fetchImpl: fetchReturning(401, { error: 'unknown_key' }) })).toEqual({ ok: false, reason: 'unknown_key' });
    expect((await requestRelease({ key: KEY, env, fetchImpl: fetchReturning(500, {}) })).reason).toBe('unreachable');
    expect((await requestRelease({ key: KEY, env, fetchImpl: fetchReturning(400, { error: 'invalid_key' }) })).reason).toBe('rejected');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/licensing/bind.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `bind.js`**

```js
/**
 * Bind / release clients for vibecarbon.com. Modeled on check.js: injectable
 * fetchImpl, hard timeout, env.VIBECARBON_API_BASE is the only env read and
 * only changes the host. Never throws.
 *
 * `/bind` binds an unbound key to the current project (idempotent for the
 * same project). `/release` never releases anything itself: the server
 * emails the buyer a single-use link, and the reply is only `sent: true`.
 * The key is committed to the repository, so possession of it must never be
 * enough to move the subscription.
 */
import { VERSION } from '../version.js';

const KNOWN_BIND_REFUSALS = new Set([
  'bound_to_other_project',
  'project_already_licensed',
  'subscription_inactive',
  'unknown_key',
]);

async function post(path, body, { env = process.env, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, cliVersion: VERSION }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      kind: 'unreachable',
      detail: err?.name === 'TimeoutError' ? 'timeout' : err?.code || err?.name || 'network',
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return { kind: 'unreachable', detail: `HTTP ${res.status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    if (typeof parsed?.error === 'string') return { kind: 'error', status: res.status, body: parsed };
    return { kind: 'unreachable', detail: `HTTP ${res.status}` };
  }
  return { kind: 'ok', body: parsed ?? {} };
}

/**
 * @returns {Promise<{ ok: true, projectId: string, tier: string, status: string, periodEnd: string } |
 *   { ok: false, reason: string, message?: string, switchPlan?: boolean, detail?: string }>}
 */
export async function bindLicense({ key, projectId, env, fetchImpl, timeoutMs }) {
  const pid = projectId.toLowerCase();
  const r = await post('/api/v1/license/bind', { key, projectId: pid }, { env, fetchImpl, timeoutMs });
  if (r.kind === 'unreachable') return { ok: false, reason: 'unreachable', detail: r.detail };
  if (r.kind === 'error') {
    if (KNOWN_BIND_REFUSALS.has(r.body.error)) {
      const out = { ok: false, reason: r.body.error };
      if (typeof r.body.message === 'string') out.message = r.body.message;
      if (typeof r.body.switchPlan === 'boolean') out.switchPlan = r.body.switchPlan;
      return out;
    }
    return { ok: false, reason: 'rejected', detail: r.body.error };
  }
  const b = r.body;
  if (typeof b.projectId !== 'string' || b.projectId.toLowerCase() !== pid) {
    return { ok: false, reason: 'rejected', detail: 'bind response named a different project' };
  }
  return { ok: true, projectId: pid, tier: String(b.tier), status: String(b.status), periodEnd: String(b.periodEnd) };
}

/** @returns {Promise<{ ok: true } | { ok: false, reason: string, detail?: string }>} */
export async function requestRelease({ key, env, fetchImpl, timeoutMs }) {
  const r = await post('/api/v1/license/release', { key }, { env, fetchImpl, timeoutMs });
  if (r.kind === 'unreachable') return { ok: false, reason: 'unreachable', detail: r.detail };
  if (r.kind === 'error') {
    if (r.body.error === 'unknown_key') return { ok: false, reason: 'unknown_key' };
    return { ok: false, reason: 'rejected', detail: r.body.error };
  }
  return r.body.sent === true ? { ok: true } : { ok: false, reason: 'rejected', detail: 'no sent flag' };
}
```

- [ ] **Step 4: Run, including the env census**

Run: `pnpm vitest run --project unit tests/unit/licensing/bind.test.ts tests/unit/licensing/no-dev-bypass.test.ts`
Expected: PASS (bind.js reads only `VIBECARBON_API_BASE`; no clock).

- [ ] **Step 5: Commit**

```bash
git add src/lib/licensing/bind.js tests/unit/licensing/bind.test.ts
git commit -m "feat(licensing): bind and release clients

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 4: `check.js` sends `projectId`; entitlement gains `unbound` / `wrong_project`; upsell copy

**Files:**
- Modify: `src/lib/licensing/check.js:99-108`, `src/lib/licensing/entitlement.js:97-108`, `src/lib/licensing/upsell.js:47-52, 89-160`
- Test: `tests/unit/licensing/check.test.ts`, `tests/unit/licensing/entitlement.test.ts`, `tests/unit/licensing/upsell.test.ts`

**Interfaces:**
- `checkLicense` body becomes `{ key, projectId, cliVersion }`.
- `evaluateDeployEntitlement`: `license` is `{ active, key, licenseId } | null` (no `isLifetime`, `projectId`, `storedProjectId`). New refusals `reason: 'unbound'` and `reason: 'wrong-project'` (hyphen, matching the existing reason spelling) from verdict statuses `unbound` / `wrong_project`. `'no-license'` only when `!license?.active`, `source === 'rejected'`, or verdict `none`.
- `buildDeployUpsell` renders `unbound` and `wrong-project`; `subscribeUrl(requiredTier)` has no project param.

- [ ] **Step 1: Update tests**

`check.test.ts`: in the "posts key" case assert the body is `{ key, projectId: '<lowercased>', cliVersion }`. Everything else unchanged.

`entitlement.test.ts`: delete every case that passes `isLifetime: true`, `license.projectId`, or `storedProjectId`. The active license fixture becomes `{ active: true, key: 'vc-…', licenseId: '0123456789abcdef' }`. Add:

```ts
it('unbound verdict blocks with reason unbound, no grace', () => {
  const r = evaluateDeployEntitlement({ license: ACTIVE, deployTier: 'k8s', projectId: PID, now: '2026-09-15',
    check: { source: 'live', verdict: { projectId: PID, status: 'unbound', tier: 'none', periodEnd: '2026-09-15', issued: '2026-09-15' } } });
  expect(r).toMatchObject({ ok: false, reason: 'unbound', requiredTier: 'graphene' });
});
it('wrong_project verdict blocks with reason wrong-project, no grace', () => {
  const r = evaluateDeployEntitlement({ license: ACTIVE, deployTier: 'k8s-ha', projectId: PID, now: '2026-09-15',
    check: { source: 'cache', verdict: { projectId: PID, status: 'wrong_project', tier: 'none', periodEnd: '2026-09-15', issued: '2026-09-15' } } });
  expect(r).toMatchObject({ ok: false, reason: 'wrong-project', requiredTier: 'fullerene' });
});
```

`upsell.test.ts`: add cases that `buildDeployUpsell({ verdict: { reason: 'unbound', requiredTier: 'graphene' }, deployTier: 'k8s', projectId: PID })` contains `'not bound to a project yet'` and `'vibecarbon activate <key>'`; `reason: 'wrong-project'` contains `'bound to a different project'`, `'vibecarbon deactivate'`, and `'https://vibecarbon.com/license'`; and that no line anywhere contains `?project=`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/licensing/check.test.ts tests/unit/licensing/entitlement.test.ts tests/unit/licensing/upsell.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`check.js` line ~106: `body: JSON.stringify({ key, projectId: pid, cliVersion: VERSION }),`.

`entitlement.js` — replace lines 100–108 (`if (!license?.active)` … `if (license.projectId !== projectId)`) with:

```js
  if (!license?.active) {
    return { ok: false, requiredTier, reason: 'no-license', license: license ?? null, verdict: null };
  }

  const verdict = check?.verdict ?? null;
  if (check?.source === 'rejected' || (verdict && verdict.projectId !== projectId)) {
    return { ok: false, requiredTier, reason: 'no-license', license, verdict: null };
  }
  if (!verdict) {
    return { ok: true, requiredTier, warning: { kind: 'unverified', detail: check?.unreachable ?? 'unknown' } };
  }
  // Binding problems are never softened by grace: grace exists for billing
  // hiccups, and an unbound or mis-bound key is not a billing state.
  if (verdict.status === 'unbound') {
    return { ok: false, requiredTier, reason: 'unbound', license, verdict };
  }
  if (verdict.status === 'wrong_project') {
    return { ok: false, requiredTier, reason: 'wrong-project', license, verdict };
  }
  if (verdict.status === 'none') {
    return { ok: false, requiredTier, reason: 'no-license', license, verdict };
  }
```

(delete the duplicated `const verdict…`/`if (!verdict)`/`none` lines that follow, so each appears once). Update the JSDoc `license` type.

`upsell.js`: `subscribeUrl(requiredTier)` → `` `${PRICING_URL}?tier=${requiredTier}` `` and update both call sites. In `buildDeployUpsell` add before `default`:

```js
    case 'unbound':
      return [
        'License not bound',
        '',
        'This key is not bound to a project yet.',
        ...(proj ? [proj] : []),
        '',
        'Run this inside the project:',
        '  vibecarbon activate <key>',
        TERMS_LINE,
      ];
    case 'wrong-project':
      return [
        'License bound elsewhere',
        '',
        'This key is bound to a different project. Each project has its own subscription.',
        ...(proj ? [proj] : []),
        '',
        'Release it there first (vibecarbon deactivate in that project, or from',
        `${LICENSE_URL}), then run vibecarbon activate <key> here.`,
        TERMS_LINE,
      ];
```

and delete the `wrong-project` branch inside `default` (the `storedProjectId` lines).

- [ ] **Step 4: Run**

Run: `pnpm vitest run --project unit tests/unit/licensing/`
Expected: check/entitlement/upsell PASS; storage/activate tests fail (Task 5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/licensing/check.js src/lib/licensing/entitlement.js src/lib/licensing/upsell.js tests/unit/licensing/check.test.ts tests/unit/licensing/entitlement.test.ts tests/unit/licensing/upsell.test.ts
git commit -m "feat(licensing): /check sends projectId; unbound and wrong-project refusals

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 5: Storage and orchestration in `index.js`

**Files:**
- Modify: `src/lib/licensing/index.js` (rewrite lines 1–503; keep `todayUtc`, `CHECK_STOP`, `requireDeployEntitlement`, `requireLicense` with edits)
- Test: `tests/unit/licensing/storage.test.ts` (rewrite), `tests/unit/licensing/deploy-gate-seam.test.ts` (update fixtures), `tests/unit/licensing/activate-replace-confirm.test.ts` + `activate-v2-routing.test.ts` + `activate-v2-ux.test.ts` (delete; Task 6 replaces them)

**Interfaces:**
- Produces:
  - `licensePath(projectDir) → string`
  - `getLicense({ projectDir, publicKeyPem }) → { active: true, tier: null, key, licenseId, activatedAt, storedAt } | { active: false, tier: 'graphite', …TIERS.graphite, key: undefined, licenseId: null, storedAt: null, message }`
  - `hasStoredLicense({ projectDir }) → boolean`
  - `activateLicense(key, { projectDir, publicKeyPem, env, fetchImpl, source }) → Promise<{ success: true, projectId, tier, status, periodEnd, path } | { success: false, error, reason? }>`
  - `deactivateLicense({ projectDir, key?, env, fetchImpl }) → Promise<{ success: true, sent: true } | { success: false, error, reason }>` — never deletes the file
  - `removeLicenseFile({ projectDir }) → { success, removed: string[] }`
  - `requireDeployEntitlement` unchanged in signature; calls `checkLicense` whenever `license.active`.

- [ ] **Step 1: Rewrite `storage.test.ts`**

```ts
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  hasStoredLicense,
  licensePath,
  removeLicenseFile,
} from '../../../src/lib/licensing/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const LICENSE_ID = '0123456789abcdef';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `vc-${LICENSE_ID}-${sign(null, Buffer.from(LICENSE_ID), privateKey).toString('hex')}`;
const env = { VIBECARBON_API_BASE: 'http://stub.test' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-license-'));
  writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ version: '1', projectName: 'p', projectId: PROJECT_ID }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BIND_OK = { projectId: PROJECT_ID, tier: 'graphene', status: 'active', periodEnd: '2026-10-15T00:00:00.000Z' };
// bind.js reads the body with res.text() and JSON.parses it, so the mock must return real JSON there.
const okBind = vi.fn(async () => ({ ok: true, status: 200, json: async () => BIND_OK, text: async () => JSON.stringify(BIND_OK) })) as unknown as typeof fetch;

describe('getLicense', () => {
  it('is inactive with no file', () => {
    expect(getLicense({ projectDir: dir, publicKeyPem: PUB })).toMatchObject({ active: false, tier: 'graphite', licenseId: null });
  });
  it('is active for a verifying key and exposes key + licenseId, never a tier', () => {
    writeFileSync(licensePath(dir), JSON.stringify({ key: KEY, activatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' }));
    const l = getLicense({ projectDir: dir, publicKeyPem: PUB });
    expect(l).toMatchObject({ active: true, tier: null, key: KEY, licenseId: LICENSE_ID, storedAt: licensePath(dir) });
  });
  it('ignores a file whose key does not verify, and a corrupt file', () => {
    writeFileSync(licensePath(dir), JSON.stringify({ key: KEY.replace(LICENSE_ID, 'fedcba9876543210') }));
    expect(getLicense({ projectDir: dir, publicKeyPem: PUB }).active).toBe(false);
    writeFileSync(licensePath(dir), '{not json');
    expect(getLicense({ projectDir: dir, publicKeyPem: PUB }).active).toBe(false);
  });
  it('never reads ~/.vibecarbon/license', () => {
    const home = mkdtempSync(join(tmpdir(), 'vc-home-'));
    writeFileSync(join(home, 'license'), JSON.stringify({ key: KEY }));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(getLicense({ projectDir: dir, publicKeyPem: PUB }).active).toBe(false);
    } finally {
      process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('activateLicense', () => {
  it('validates locally, binds remotely, then writes the file', async () => {
    const r = await activateLicense(KEY, { projectDir: dir, publicKeyPem: PUB, env, fetchImpl: okBind });
    expect(r).toMatchObject({ success: true, projectId: PROJECT_ID, tier: 'graphene', status: 'active', path: licensePath(dir) });
    const stored = JSON.parse(readFileSync(licensePath(dir), 'utf8'));
    expect(stored.key).toBe(KEY);
    expect(stored.source).toBe('manual');
    const sent = JSON.parse(String((okBind as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]?.body));
    expect(sent.projectId).toBe(PROJECT_ID);
  });
  it('refuses a malformed or unverifiable key before any network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await activateLicense('vc-nope', { projectDir: dir, publicKeyPem: PUB, env, fetchImpl })).success).toBe(false);
    expect((await activateLicense(`vc-f-deadbeef-${'a'.repeat(128)}`, { projectDir: dir, publicKeyPem: PUB, env, fetchImpl })).success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses outside a project', async () => {
    rmSync(join(dir, '.vibecarbon.json'));
    const r = await activateLicense(KEY, { projectDir: dir, publicKeyPem: PUB, env, fetchImpl: okBind });
    expect(r).toMatchObject({ success: false, reason: 'no-project' });
    expect(r.error).toMatch(/vibecarbon create/);
  });
  it('writes nothing when the server refuses or is unreachable', async () => {
    const refuse = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}), text: async () => JSON.stringify({ error: 'bound_to_other_project' }) })) as unknown as typeof fetch;
    const r = await activateLicense(KEY, { projectDir: dir, publicKeyPem: PUB, env, fetchImpl: refuse });
    expect(r).toMatchObject({ success: false, reason: 'bound_to_other_project' });
    expect(existsSync(licensePath(dir))).toBe(false);
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r2 = await activateLicense(KEY, { projectDir: dir, publicKeyPem: PUB, env, fetchImpl: down });
    expect(r2).toMatchObject({ success: false, reason: 'unreachable' });
    expect(existsSync(licensePath(dir))).toBe(false);
  });
});

describe('deactivateLicense', () => {
  it('posts the stored key to /release and leaves the file in place', async () => {
    writeFileSync(licensePath(dir), JSON.stringify({ key: KEY }));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sent: true }), text: async () => '{"sent":true}' })) as unknown as typeof fetch;
    const r = await deactivateLicense({ projectDir: dir, env, fetchImpl });
    expect(r).toEqual({ success: true, sent: true });
    expect(existsSync(licensePath(dir))).toBe(true);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://stub.test/api/v1/license/release');
  });
  it('accepts an explicit key with no file (deleted-repo case)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sent: true }), text: async () => '{"sent":true}' })) as unknown as typeof fetch;
    expect((await deactivateLicense({ projectDir: dir, key: KEY, env, fetchImpl })).success).toBe(true);
  });
  it('fails with no key anywhere', async () => {
    expect(await deactivateLicense({ projectDir: dir, env, fetchImpl: vi.fn() as unknown as typeof fetch })).toMatchObject({ success: false, reason: 'no-key' });
  });
  it('reports unreachable without touching the file', async () => {
    writeFileSync(licensePath(dir), JSON.stringify({ key: KEY }));
    const down = vi.fn(async () => { throw new Error('x'); }) as unknown as typeof fetch;
    expect(await deactivateLicense({ projectDir: dir, env, fetchImpl: down })).toMatchObject({ success: false, reason: 'unreachable' });
    expect(existsSync(licensePath(dir))).toBe(true);
  });
});

describe('removeLicenseFile / hasStoredLicense', () => {
  it('removes the one file, idempotently', () => {
    writeFileSync(licensePath(dir), '{}');
    expect(hasStoredLicense({ projectDir: dir })).toBe(true);
    expect(removeLicenseFile({ projectDir: dir })).toEqual({ success: true, removed: [licensePath(dir)] });
    expect(hasStoredLicense({ projectDir: dir })).toBe(false);
    expect(removeLicenseFile({ projectDir: dir })).toEqual({ success: true, removed: [] });
  });
});
```

Delete `activate-replace-confirm.test.ts`, `activate-v2-routing.test.ts`, `activate-v2-ux.test.ts`. In `deploy-gate-seam.test.ts`, change any license fixture to the `{ active, key, licenseId }` shape and any `~/.vibecarbon/license` setup to writing `<projectDir>/.vibecarbon.license`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/licensing/storage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `index.js` (lines 1–503)**

```js
/**
 * License management for Vibecarbon
 *
 * One storage slot: <projectDir>/.vibecarbon.license, JSON
 * `{ key, activatedAt, source }`, committed to git so everyone on the project
 * shares it. The key carries no project: which project it is bound to lives
 * on vibecarbon.com, set by `activate` (POST /bind) and cleared by the
 * emailed link `deactivate` requests (POST /release). Only `key` is
 * cryptographically checked; the other fields are display-only.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinner } from '../cli/progress.js';
import { c } from '../colors.js';
import { ensureProjectId, loadManifest, manifestExists } from '../project.js';
import { bindLicense, requestRelease } from './bind.js';
import { checkLicense } from './check.js';
import { evaluateDeployEntitlement, requiredTierFor } from './entitlement.js';
import { TIERS } from './tiers.js';
import { printDeployUpsell, printDeployWarning } from './upsell.js';
import { validateLicenseKey } from './validator.js';

const LICENSE_FILENAME = '.vibecarbon.license';

export function licensePath(projectDir = process.cwd()) {
  return join(projectDir, LICENSE_FILENAME);
}

function readJsonFileOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeProjectId(id) {
  return typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : null;
}

/** The current project's id from .vibecarbon.json, or null (no/corrupt manifest never throws). */
function currentManifestProjectId(projectDir) {
  if (!manifestExists(projectDir)) return null;
  try {
    return normalizeProjectId(loadManifest(projectDir)?.projectId);
  } catch {
    return null;
  }
}

function writeLicenseFile(data, projectDir) {
  writeFileSync(licensePath(projectDir), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
}

function noLicenseResult() {
  return {
    tier: 'graphite',
    ...TIERS.graphite,
    active: false,
    key: undefined,
    licenseId: null,
    activatedAt: undefined,
    storedAt: null,
    message: 'No license activated. Using Graphite tier.',
  };
}

/**
 * The stored key, re-verified. Active means "a key that verifies is on
 * disk"; whether it is bound to THIS project and paid up is a server
 * verdict fetched at deploy time, so `tier` is always null here.
 * @param {{ projectDir?: string, publicKeyPem?: string }} [options]
 */
export function getLicense({ projectDir = process.cwd(), publicKeyPem } = {}) {
  const path = licensePath(projectDir);
  const stored = readJsonFileOrNull(path);
  if (!stored?.key) return noLicenseResult();
  const validation = validateLicenseKey(stored.key, { publicKeyPem });
  if (!validation.valid) return noLicenseResult();
  return {
    tier: null,
    active: true,
    key: String(stored.key).trim(),
    licenseId: validation.licenseId,
    activatedAt: stored.activatedAt,
    storedAt: path,
  };
}

/** Presence, not validity: an unverifiable file must still be removable. */
export function hasStoredLicense({ projectDir = process.cwd() } = {}) {
  return existsSync(licensePath(projectDir));
}

/**
 * Validate the key locally, bind it to this project on vibecarbon.com, and
 * only then write the file. Nothing is written on any refusal or when the
 * server cannot be reached: there is no offline activate.
 * @returns {Promise<object>} `{ success: true, projectId, tier, status, periodEnd, path } | { success: false, error, reason? }`
 */
export async function activateLicense(
  key,
  { projectDir = process.cwd(), publicKeyPem, env, fetchImpl, source = 'manual' } = {},
) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'License key is required', reason: 'invalid' };
  }
  const validation = validateLicenseKey(key.trim(), { publicKeyPem });
  if (!validation.valid) {
    return { success: false, error: validation.error, reason: 'invalid' };
  }
  const projectId = currentManifestProjectId(projectDir);
  if (!projectId) {
    return {
      success: false,
      reason: 'no-project',
      error: 'No project here. Run vibecarbon create first, then activate inside it.',
    };
  }

  const bound = await bindLicense({ key: key.trim(), projectId, env, fetchImpl });
  if (!bound.ok) {
    return { success: false, reason: bound.reason, error: bindErrorMessage(bound), switchPlan: bound.switchPlan };
  }

  try {
    writeLicenseFile({ key: key.trim(), activatedAt: new Date().toISOString(), source }, projectDir);
  } catch (error) {
    return { success: false, reason: 'write', error: `Failed to save license: ${error.message}` };
  }
  return {
    success: true,
    projectId: bound.projectId,
    tier: bound.tier,
    status: bound.status,
    periodEnd: bound.periodEnd,
    path: licensePath(projectDir),
  };
}

function bindErrorMessage(bound) {
  switch (bound.reason) {
    case 'bound_to_other_project':
      return 'This key is already bound to another project. Run vibecarbon deactivate in that project, or release it from https://vibecarbon.com/license, then activate again.';
    case 'project_already_licensed':
      return bound.message || 'This project already has an active subscription.';
    case 'subscription_inactive':
      return 'This subscription is no longer active. Renew it from https://vibecarbon.com/license.';
    case 'unknown_key':
      return 'This key is not recognised by vibecarbon.com. Check the key from your purchase email.';
    case 'unreachable':
      return `Activation needs a connection to vibecarbon.com (${bound.detail ?? 'unreachable'}). Nothing was changed.`;
    default:
      return `vibecarbon.com refused this activation (${bound.detail ?? bound.reason}).`;
  }
}

/**
 * Ask vibecarbon.com to email the buyer a release link. The file is LEFT IN
 * PLACE: a released key is harmless on disk (the deploy gate answers
 * `unbound`, and activate overwrites it), and deleting it before the buyer
 * confirms would strand a project whose link is never clicked.
 * @returns {Promise<object>} `{ success: true, sent: true } | { success: false, error, reason }`
 */
export async function deactivateLicense({ projectDir = process.cwd(), key, env, fetchImpl } = {}) {
  const stored = readJsonFileOrNull(licensePath(projectDir));
  const useKey = (key ?? stored?.key ?? '').trim();
  if (!useKey) {
    return { success: false, reason: 'no-key', error: 'No license here. Pass the key: vibecarbon deactivate <key>.' };
  }
  const r = await requestRelease({ key: useKey, env, fetchImpl });
  if (!r.ok) {
    const error =
      r.reason === 'unreachable'
        ? `Could not reach vibecarbon.com (${r.detail ?? 'unreachable'}); the key is still bound.`
        : r.reason === 'unknown_key'
          ? 'This key is not recognised by vibecarbon.com.'
          : `vibecarbon.com refused the request (${r.detail ?? r.reason}).`;
    return { success: false, reason: r.reason, error };
  }
  return { success: true, sent: true };
}

/** Delete the local file only. No request. */
export function removeLicenseFile({ projectDir = process.cwd() } = {}) {
  const path = licensePath(projectDir);
  if (!existsSync(path)) return { success: true, removed: [] };
  try {
    unlinkSync(path);
    return { success: true, removed: [path] };
  } catch (error) {
    return { success: false, removed: [], error: `Failed to remove license: ${error.message}` };
  }
}
```

In `requireDeployEntitlement`: drop `stateDir` from the `getLicense` call (keep it for `checkLicense`, the cache lives there), and replace `if (license.active && license.format === 'v2')` with `if (license.active)`. Update the JSDoc paragraph that mentions lifetime keys: "Compose deploys return immediately; a key on disk is always checked with the server." `requireLicense` unchanged apart from `projectId: null`. Keep the re-exports.

Also update `src/lib/project.js` only if `loadManifest(projectDir)` does not exist with that signature — check with `grep -n "export function loadManifest" src/lib/project.js` and adapt the call.

- [ ] **Step 4: Run**

Run: `pnpm vitest run --project unit tests/unit/licensing/`
Expected: PASS for storage, deploy-gate-seam, and everything from Tasks 1–4. `command-gates.test.ts` / `paid-surface.test.ts` untouched and green.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/licensing tests/unit/licensing
git commit -m "feat(licensing): one storage file; activate binds, deactivate requests a release

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 6: `activate` / `deactivate` commands

**Files:**
- Modify: `src/activate.js` (rewrite), `src/cli.js:173` (help line)
- Test: `tests/unit/licensing/activate-command.test.ts` (create)

**Interfaces:**
- `activate [key]` (`-h`); `deactivate [key]` (`-h`, `-y`, `-rm`). `-all` is removed.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const activateLicense = vi.fn();
const deactivateLicense = vi.fn();
const removeLicenseFile = vi.fn();
const hasStoredLicense = vi.fn();
const getLicense = vi.fn();
vi.mock('../../../src/lib/licensing/index.js', () => ({
  activateLicense: (...a: unknown[]) => activateLicense(...a),
  deactivateLicense: (...a: unknown[]) => deactivateLicense(...a),
  removeLicenseFile: (...a: unknown[]) => removeLicenseFile(...a),
  hasStoredLicense: (...a: unknown[]) => hasStoredLicense(...a),
  getLicense: (...a: unknown[]) => getLicense(...a),
}));
const logs: string[] = [];
vi.mock('@clack/prompts', () => ({
  log: { info: (m: string) => logs.push(m), success: (m: string) => logs.push(m), error: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
  note: (m: string) => logs.push(m),
  outro: (m: string) => logs.push(m),
  intro: () => {},
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  isCancel: () => false,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/cli/progress.js', () => ({ spinner: () => ({ start() {}, stop() {} }) }));

const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
const { runActivate, runDeactivate } = await import('../../../src/activate.js');
const KEY = `vc-0123456789abcdef-${'a'.repeat(128)}`;

beforeEach(() => { logs.length = 0; vi.clearAllMocks(); });

describe('activate', () => {
  it('prints the binding on success', async () => {
    activateLicense.mockResolvedValue({ success: true, projectId: 'p', tier: 'graphene', status: 'active', periodEnd: '2026-10-15T00:00:00.000Z', path: '/x/.vibecarbon.license' });
    await runActivate([KEY]);
    expect(activateLicense).toHaveBeenCalledWith(KEY);
    expect(logs.join('\n')).toMatch(/Graphene/);
    expect(logs.join('\n')).toContain('Project: p');
    expect(logs.join('\n')).toContain('commit');
  });
  it('exits 1 with the server reason on refusal, and hints /license on switchPlan', async () => {
    activateLicense.mockResolvedValue({ success: false, reason: 'project_already_licensed', error: 'already', switchPlan: true });
    await expect(runActivate([KEY])).rejects.toThrow('exit 1');
    expect(logs.join('\n')).toContain('already');
    expect(logs.join('\n')).toContain('https://vibecarbon.com/license');
  });
  it('exits 1 offline and says nothing changed', async () => {
    activateLicense.mockResolvedValue({ success: false, reason: 'unreachable', error: 'Activation needs a connection to vibecarbon.com (timeout). Nothing was changed.' });
    await expect(runActivate([KEY])).rejects.toThrow('exit 1');
    expect(logs.join('\n')).toContain('Nothing was changed');
  });
});

describe('deactivate', () => {
  it('-y requests the release and tells the user to check their email; file stays', async () => {
    hasStoredLicense.mockReturnValue(true);
    deactivateLicense.mockResolvedValue({ success: true, sent: true });
    await runDeactivate(['-y']);
    expect(deactivateLicense).toHaveBeenCalledWith({ key: undefined });
    expect(removeLicenseFile).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/check your email/i);
    expect(logs.join('\n')).toMatch(/within an hour/i);
  });
  it('accepts a positional key with no file', async () => {
    hasStoredLicense.mockReturnValue(false);
    deactivateLicense.mockResolvedValue({ success: true, sent: true });
    await runDeactivate([KEY, '-y']);
    expect(deactivateLicense).toHaveBeenCalledWith({ key: KEY });
  });
  it('-rm removes the local file without a request', async () => {
    hasStoredLicense.mockReturnValue(true);
    removeLicenseFile.mockReturnValue({ success: true, removed: ['/x/.vibecarbon.license'] });
    await runDeactivate(['-rm', '-y']);
    expect(deactivateLicense).not.toHaveBeenCalled();
    expect(removeLicenseFile).toHaveBeenCalled();
  });
  it('exits 1 when unreachable, without removing the file', async () => {
    hasStoredLicense.mockReturnValue(true);
    deactivateLicense.mockResolvedValue({ success: false, reason: 'unreachable', error: 'Could not reach vibecarbon.com (timeout); the key is still bound.' });
    await expect(runDeactivate(['-y'])).rejects.toThrow('exit 1');
    expect(removeLicenseFile).not.toHaveBeenCalled();
  });
  it('-all is gone', async () => {
    await expect(runDeactivate(['-all'])).rejects.toThrow(/exit/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/licensing/activate-command.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/activate.js`**

```js
/**
 * Vibecarbon Activate / Deactivate Commands
 *
 *   vibecarbon activate [key]          Bind a key to this project (online)
 *   vibecarbon deactivate [key] [-rm]  Ask for a release link by email; -rm
 *                                      removes only the local file
 */
import * as p from '@clack/prompts';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { c } from './lib/colors.js';
import {
  activateLicense,
  deactivateLicense,
  hasStoredLicense,
  removeLicenseFile,
} from './lib/licensing/index.js';
import { VERSION } from './lib/version.js';

const LICENSE_URL = 'https://vibecarbon.com/license';
const PRICING_URL = 'https://vibecarbon.com/pricing';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const ACTIVATE_SPEC = {
  name: 'activate',
  summary: 'Bind a Vibecarbon license key to this project',
  positional: [{ name: 'key', optional: true, description: 'License key (vc-...). Prompts if omitted.' }],
  flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
};

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const DEACTIVATE_SPEC = {
  name: 'deactivate',
  summary: 'Release the license key from this project (confirmed by email)',
  positional: [{ name: 'key', optional: true, description: 'License key, when there is no .vibecarbon.license here' }],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompt' },
    { name: 'rm', boolean: true, description: 'Remove the local .vibecarbon.license only; no request is sent' },
  ],
};

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export async function runActivate(args) {
  const { positional, handled } = parseFlagsOrExit(args, ACTIVATE_SPEC);
  if (handled) return;
  introCommand('activate');

  let licenseKey = /** @type {string|undefined} */ (positional.key);
  if (!licenseKey) {
    const inputKey = await p.text({
      message: 'Enter your license key:',
      placeholder: 'vc-...',
      validate: (value) => {
        if (!value) return 'License key is required';
        if (!/^vc-[0-9a-f]{16}-[0-9a-f]{128}$/i.test(value.trim())) return 'Invalid key format. Expected vc-<id>-<signature>';
        return undefined;
      },
    });
    if (p.isCancel(inputKey)) exitCancelled();
    licenseKey = inputKey;
  }

  const s = spinner();
  s.start('Binding this key to the project on vibecarbon.com');
  const result = await activateLicense(licenseKey);
  if (!result.success) {
    s.stop('Activation failed', 1);
    p.log.error(c.error(`Error: ${result.error}`));
    if (result.reason === 'project_already_licensed' && result.switchPlan) {
      p.log.info(`${c.dim('Switch plans at')} ${c.info(LICENSE_URL)}`);
    } else if (result.reason === 'invalid' || result.reason === 'unknown_key') {
      p.log.info(`${c.dim('Buy a license at')} ${c.info(PRICING_URL)}`);
    }
    process.exit(1);
  }
  s.stop('License activated');

  p.log.success(`Welcome to ${c.success(capitalize(result.tier))}!`);
  p.note(
    [
      `Tier: ${capitalize(result.tier)}`,
      `Project: ${result.projectId}`,
      `Status: ${result.status}`,
      `This CLI: v${VERSION}`,
      '',
      'Commit .vibecarbon.license so everyone on the project can deploy.',
      'Subscription status is re-checked on every paid deploy.',
    ].join('\n'),
    'License Details',
  );
  p.outro('You can now deploy to Kubernetes and HA environments.');
}

export async function runDeactivate(args) {
  const { positional, values, handled } = parseFlagsOrExit(args, DEACTIVATE_SPEC);
  if (handled) return;
  introCommand('deactivate');

  const key = /** @type {string|undefined} */ (positional.key);
  const yes = !!values.y;

  if (values.rm) {
    if (!hasStoredLicense()) {
      p.log.info('No .vibecarbon.license here.');
      p.outro('');
      return;
    }
    if (!yes) {
      const confirm = await p.confirm({ message: 'Remove the local .vibecarbon.license? No request is sent; the key stays bound on vibecarbon.com.' });
      if (p.isCancel(confirm)) exitCancelled();
      if (!confirm) exitDeclined();
    }
    const r = removeLicenseFile();
    if (!r.success) {
      p.log.error(c.error(`Error: ${r.error}`));
      process.exit(1);
    }
    p.log.success('Removed .vibecarbon.license.');
    p.outro('');
    return;
  }

  if (!key && !hasStoredLicense()) {
    p.log.info('No license here. Pass the key: vibecarbon deactivate <key>');
    p.outro('');
    return;
  }

  if (!yes) {
    const confirm = await p.confirm({
      message: 'Ask vibecarbon.com to email a release link for this key? Nothing changes until it is clicked.',
    });
    if (p.isCancel(confirm)) exitCancelled();
    if (!confirm) exitDeclined();
  }

  const s = spinner();
  s.start('Requesting a release link');
  const result = await deactivateLicense({ key });
  if (!result.success) {
    s.stop('Request failed', 1);
    p.log.error(c.error(`Error: ${result.error}`));
    process.exit(1);
  }
  s.stop('Release link sent');
  p.log.success('Check your email: click the link within an hour to release this key from its project.');
  p.log.info('Nothing changes until you do. .vibecarbon.license stays here; run vibecarbon deactivate -rm to remove it.');
  p.outro('');
}
```

`src/cli.js:173`: `deactivate               Release the license from this project (confirmed by email)`.

- [ ] **Step 4: Run**

Run: `pnpm vitest run --project unit tests/unit/licensing/activate-command.test.ts && pnpm lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/activate.js src/cli.js tests/unit/licensing/activate-command.test.ts
git commit -m "feat(cli): activate binds online; deactivate requests an emailed release, -rm for local cleanup

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 7: Licence API stub + harness

**Files:**
- Create: `tests/e2e/utils/license-stub.js`
- Modify: `tests/integration/_harness/run-cli.ts` (drop `testLicenseKey`/fake licence; keep fake HOME), `tests/integration/_harness/index.ts` (exports), `tests/.env.e2e.example`
- Test: `tests/unit/e2e/license-stub.test.ts` (create)

**Interfaces:**
- Produces (`license-stub.js`, ESM JS):
  - `startLicenseStub({ privateKeyPem }) → Promise<{ baseUrl: string, close(): Promise<void>, seed({ licenseId, projectId = null, tier = 'fullerene', status = 'active', periodEndYmd, cancelAtPeriodEnd = false }), mintKey(licenseId?) → { key, licenseId }, state: Map, calls: Array<{ path, body }> }>`
  - Routes: `POST /api/v1/license/check | /bind | /release | /status` implementing the contract in Global Constraints. `/release` in the stub **releases immediately** (it is a test double for "the buyer clicked the link") and records the call.
  - `signingKeyOrNull(): string | null` — `VIBECARBON_LICENSE_PRIVATE_KEY` from env or `tests/.env.e2e`.

- [ ] **Step 1: Write the failing test**

```ts
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { derivePublicKeyPem } from '../../../scripts/generate-license.js';
import { checkLicense } from '../../../src/lib/licensing/check.js';
import { bindLicense, requestRelease } from '../../../src/lib/licensing/bind.js';
import { startLicenseStub } from '../../e2e/utils/license-stub.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = derivePublicKeyPem(PEM);
const PID = '11111111-1111-4111-8111-111111111111';
const PID2 = '22222222-2222-4222-8222-222222222222';

let stub: Awaited<ReturnType<typeof startLicenseStub>>;
let stateDir: string;
beforeEach(async () => {
  stub = await startLicenseStub({ privateKeyPem: PEM });
  stateDir = mkdtempSync(join(tmpdir(), 'vc-state-'));
});
afterEach(async () => {
  await stub.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('license stub', () => {
  it('serves signed verdicts the real client verifies', async () => {
    const { key, licenseId } = stub.mintKey();
    stub.seed({ licenseId, projectId: PID, tier: 'graphene', periodEndYmd: '2026-12-31' });
    const r = await checkLicense({ key, projectId: PID, stateDir, env: { VIBECARBON_API_BASE: stub.baseUrl }, publicKeyPem: PUB });
    expect(r.source).toBe('live');
    expect(r.verdict).toMatchObject({ status: 'active', tier: 'graphene', projectId: PID });
  });
  it('answers unbound and wrong_project', async () => {
    const { key, licenseId } = stub.mintKey();
    stub.seed({ licenseId, projectId: null, periodEndYmd: '2026-12-31' });
    expect((await checkLicense({ key, projectId: PID, stateDir, env: { VIBECARBON_API_BASE: stub.baseUrl }, publicKeyPem: PUB })).verdict?.status).toBe('unbound');
    stub.seed({ licenseId, projectId: PID2, periodEndYmd: '2026-12-31' });
    expect((await checkLicense({ key, projectId: PID, stateDir, env: { VIBECARBON_API_BASE: stub.baseUrl }, publicKeyPem: PUB })).verdict?.status).toBe('wrong_project');
  });
  it('binds, refuses a second project, releases', async () => {
    const { key, licenseId } = stub.mintKey();
    stub.seed({ licenseId, periodEndYmd: '2026-12-31' });
    const env = { VIBECARBON_API_BASE: stub.baseUrl };
    expect((await bindLicense({ key, projectId: PID, env })).ok).toBe(true);
    expect((await bindLicense({ key, projectId: PID, env })).ok).toBe(true);
    expect(await bindLicense({ key, projectId: PID2, env })).toMatchObject({ ok: false, reason: 'bound_to_other_project' });
    expect(await requestRelease({ key, env })).toEqual({ ok: true });
    expect(stub.state.get(licenseId)?.projectId).toBeNull();
    expect(stub.calls.map((c) => c.path)).toEqual(['/api/v1/license/bind', '/api/v1/license/bind', '/api/v1/license/bind', '/api/v1/license/release']);
  });
  it('401s an unknown key', async () => {
    const { key } = stub.mintKey();
    expect(await bindLicense({ key, projectId: PID, env: { VIBECARBON_API_BASE: stub.baseUrl } })).toMatchObject({ ok: false, reason: 'unknown_key' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit tests/unit/e2e/license-stub.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the stub**

```js
/**
 * In-process stand-in for vibecarbon.com's licence API, for integration and
 * e2e runs. Signs REAL verdict tokens with the signing private key (the
 * CLI's embedded public key is the only one it trusts, and a test-only
 * override would be a production bypass), so the CLI under test walks its
 * production code path against this stub with VIBECARBON_API_BASE set.
 *
 * `/release` releases immediately: the stub stands in for "the buyer
 * clicked the emailed link". Every request is recorded in `calls`.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { derivePublicKeyPem, mintKey as mintSignedKey, randomLicenseId, signVerdictToken } from '../../../scripts/generate-license.js';
import { validateLicenseKey } from '../../../src/lib/licensing/validator.js';
import { loadE2EEnvFile } from './e2e-env-file.js';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function signingKeyOrNull(env = process.env) {
  if (!env.VIBECARBON_LICENSE_PRIVATE_KEY) {
    loadE2EEnvFile(join(REPO_ROOT, 'tests', '.env.e2e'), env);
  }
  return env.VIBECARBON_LICENSE_PRIVATE_KEY || null;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function startLicenseStub({ privateKeyPem }) {
  if (!privateKeyPem) throw new Error('startLicenseStub: privateKeyPem is required');
  const publicKeyPem = derivePublicKeyPem(privateKeyPem);
  /** @type {Map<string, { projectId: string|null, tier: string, status: string, periodEndYmd: string, cancelAtPeriodEnd: boolean }>} */
  const state = new Map();
  const calls = [];

  function resolve(body) {
    if (!body || typeof body.key !== 'string') return { error: { status: 400, body: { error: 'invalid_request' } } };
    const v = validateLicenseKey(body.key, { publicKeyPem });
    if (!v.valid) return { error: { status: v.error === 'Invalid license signature' ? 401 : 400, body: { error: v.error === 'Invalid license signature' ? 'bad_signature' : 'invalid_key' } } };
    const row = state.get(v.licenseId);
    if (!row) return { error: { status: 401, body: { error: 'unknown_key' } } };
    return { row, licenseId: v.licenseId };
  }

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ path: req.url, body });
    const r = resolve(body);
    if (r.error) return json(res, r.error.status, r.error.body);
    const { row, licenseId } = r;
    const pid = typeof body.projectId === 'string' ? body.projectId.toLowerCase() : null;

    switch (req.url) {
      case '/api/v1/license/check': {
        if (!pid) return json(res, 400, { error: 'invalid_request' });
        let status, tier, periodEnd;
        if (row.projectId === null) [status, tier, periodEnd] = ['unbound', 'none', todayYmd()];
        else if (row.projectId !== pid) [status, tier, periodEnd] = ['wrong_project', 'none', todayYmd()];
        else [status, tier, periodEnd] = [row.status === 'trialing' ? 'active' : row.status, row.tier, row.periodEndYmd];
        const token = signVerdictToken(privateKeyPem, { projectId: pid, status, tier, periodEnd, issued: todayYmd() });
        return json(res, 200, { token, status, tier, projectId: pid, periodEnd: `${periodEnd}T00:00:00.000Z`, cancelAtPeriodEnd: tier === 'none' ? false : row.cancelAtPeriodEnd });
      }
      case '/api/v1/license/bind': {
        if (!pid) return json(res, 400, { error: 'invalid_request' });
        if (!ACTIVE.has(row.status)) return json(res, 403, { error: 'subscription_inactive' });
        if (row.projectId !== null && row.projectId !== pid) return json(res, 409, { error: 'bound_to_other_project' });
        for (const [otherId, other] of state) {
          if (otherId !== licenseId && other.projectId === pid && ACTIVE.has(other.status)) {
            return json(res, 409, { error: 'project_already_licensed', switchPlan: false, message: 'This project already has a subscription.' });
          }
        }
        row.projectId = pid;
        return json(res, 200, { projectId: pid, tier: row.tier, status: row.status, periodEnd: `${row.periodEndYmd}T00:00:00.000Z` });
      }
      case '/api/v1/license/release': {
        row.projectId = null;
        return json(res, 200, { sent: true });
      }
      case '/api/v1/license/status':
        return json(res, 200, { tier: row.tier, status: row.status, periodEnd: `${row.periodEndYmd}T00:00:00.000Z`, cancelAtPeriodEnd: row.cancelAtPeriodEnd, projectId: row.projectId });
      default:
        return json(res, 404, { error: 'not_found' });
    }
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    calls,
    seed({ licenseId, projectId = null, tier = 'fullerene', status = 'active', periodEndYmd, cancelAtPeriodEnd = false }) {
      if (!periodEndYmd) throw new Error('seed: periodEndYmd (YYYY-MM-DD) is required');
      state.set(licenseId, { projectId: projectId ? projectId.toLowerCase() : null, tier, status, periodEndYmd, cancelAtPeriodEnd });
    },
    mintKey(licenseId = randomLicenseId()) {
      return { key: mintSignedKey(privateKeyPem, { licenseId }), licenseId };
    },
    close() {
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
```

`run-cli.ts`: delete the `testLicenseKey` function, the licence-file write in `getFakeHome` (it now only `mkdtempSync`s a HOME and creates `.vibecarbon/`), the `loadE2EEnvFile` import if unused, and the header comment about the legacy key. Keep `HOME: getFakeHome()`. Add an optional `apiBase?: string` to `RunOptions` that sets `VIBECARBON_API_BASE` (default `'http://127.0.0.1:9'`, a closed port, so no test ever reaches the real network by accident).

`tests/integration/_harness/index.ts`: remove the `testLicenseKey` export; re-export `startLicenseStub`, `signingKeyOrNull` from `../../e2e/utils/license-stub.js`.

`tests/.env.e2e.example`: replace the `VIBECARBON_TEST_LICENSE_KEY` block with:

```
# ─── Licence signing key ── required by integration AND e2e ───────────────────
# The harness runs a local stub of vibecarbon.com's licence API and signs real
# verdict tokens with this key (the CLI trusts only the embedded public half).
# Same value as vibecarbon-web's LICENSE_SIGNING_PRIVATE_KEY, as raw PEM.
VIBECARBON_LICENSE_PRIVATE_KEY=''
```

- [ ] **Step 4: Run**

Run: `pnpm vitest run --project unit tests/unit/e2e/license-stub.test.ts tests/unit/e2e/ tests/unit/lib/credential-key-convention.test.ts tests/unit/metrics/`
Expected: the stub test PASSes. `env-e2e-example`, `iter-step-env-parity`, `credential-key-convention`, `perf-publish-ci-gates` FAIL on the renamed variable — update each to expect `VIBECARBON_LICENSE_PRIVATE_KEY` where it expected `VIBECARBON_TEST_LICENSE_KEY` (`iter-step-env-parity.test.ts:110` becomes "the integration harness never sources a licence key" → `expect(runCli).not.toContain('LICENSE_KEY')`). Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add -A tests scripts
git commit -m "test(licensing): local licence-API stub replaces the pre-minted test key

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 8: Integration tests — activate, deactivate, license gate

**Files:**
- Modify: `tests/integration/cli/activate/activate.test.ts`, `tests/integration/cli/deactivate/deactivate.test.ts`, `tests/integration/cli/_global/license-gate.test.ts`

All three use `signingKeyOrNull()` and `it.skipIf(!signingKey)` for the cases that need real signatures (as `license-gate.test.ts` already does), and `startLicenseStub` in `beforeAll` with `apiBase: stub.baseUrl` passed to `runCli`.

- [ ] **Step 1: Rewrite `activate.test.ts`**

Cases:
1. `prints help` — `-h` output contains `Bind a Vibecarbon license key`, not `vc2`, not `-refresh`.
2. `binds a genuinely signed key and writes .vibecarbon.license` (skipIf no key): seed the stub unbound; run `activate <key>` in a fixture project with `projectId`; expect exit 0, stdout contains `Project: <projectId>` and `Welcome to Fullerene`; file exists with `key`; `stub.state.get(licenseId).projectId === projectId`.
3. `refuses a well-formed key with no valid signature before any request`: run with `apiBase: stub.baseUrl`; expect exit 1, `Invalid license signature`, `stub.calls` empty, no file.
4. `refuses outside a project`: no `.vibecarbon.json`; exit 1; `vibecarbon create`.
5. `409 bound elsewhere → exit 1, deactivate hint, no file` (skipIf): seed bound to another project.
6. `unreachable → exit 1, nothing written`: `apiBase: 'http://127.0.0.1:9'`.
7. `rejects a malformed key`.

- [ ] **Step 2: Rewrite `deactivate.test.ts`**

Cases: help mentions `-rm` and not `-all`; `-y` with a stored key hits `/release` once and leaves the file (skipIf); positional key with no file works (skipIf); `-rm -y` removes the file and makes no request; unreachable exits 1 with the file intact; `-all` is rejected as an unknown flag.

- [ ] **Step 3: Update `license-gate.test.ts`**

- Delete case (6) "a legacy lifetime key in HOME clears k8s-ha without contacting vibecarbon.com".
- Case (7) writes `.vibecarbon.license` with `stub.mintKey()` (no seed needed: unreachable is the point) and keeps its assertions.
- Add (skipIf): `an activated key bound to this project deploys with "Subscription checked"` — seed bound, `apiBase: stub.baseUrl`, expect stdout contains `Subscription checked`, not `License required`, and `~/.vibecarbon/license-checks/<projectId>.json` exists in the fake HOME.
- Add (skipIf): `an unbound key refuses with "License not bound"`; `a key bound to another project refuses with "License bound elsewhere"` — both exit 1 and never print `License required`.
- The rest (compose is free, operating commands are free, missing key refuses) unchanged.

- [ ] **Step 4: Run**

Run: `pnpm test:integration -- tests/integration/cli/activate tests/integration/cli/deactivate tests/integration/cli/_global`
Expected: PASS (signed cases run if `tests/.env.e2e` has the key, skip otherwise — run once WITH the key before committing).

- [ ] **Step 5: Commit**

```bash
git add tests/integration
git commit -m "test(cli): activate/deactivate/gate integration against the licence stub

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 9: e2e harness, CI secrets, docs, census

**Files:**
- Modify: `tests/e2e/utils/e2e-env.js:295-345, 384-450`, `tests/e2e/utils/cli-runner.ts` (add `runActivate`), `tests/e2e/runner.ts` (call it after `runCreate`)
- Modify: `.github/workflows/test.yml:100-125, 155-160, 210-230`, `.github/workflows/e2e-us-perf.yml:205-230`
- Modify: `README.md:148-156, 320`, `docs/tests.md`, `docs/specs/billing-modes.md`, `docs/design.md` (pricing line if it mentions the old key)
- Create: `tests/unit/licensing/no-legacy-traces.test.ts`
- Modify: `tests/unit/licensing/no-dev-bypass.test.ts` header comment (line 11)

- [ ] **Step 1: Write the census**

```ts
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Clean sweep: no code, test, workflow, or doc may describe the retired v1
// lifetime key, the v2 project-bound key, the legacy storage slot, or the
// pre-minted test key. A hit is a leftover, not a false positive.
const PATTERNS = [
  'vc2-',
  'vc-f-',
  'lifetime key',
  'lifetime license',
  'lifetime Fullerene',
  'isLifetime',
  'legacy license',
  'legacy key',
  'legacy slot',
  'legacyLicensePath',
  'listStoredLicenses',
  'VIBECARBON_TEST_LICENSE_KEY',
  "'.vibecarbon', 'license'", // join(home, '.vibecarbon', 'license'): the old global slot
  '-legacy',
  'mintV1Key',
  'mintV2Key',
  'storedProjectId',
];
const SCOPE = 'src scripts tests docs README.md TERMS.md .github carbon/README.md';

describe('no traces of retired licence formats', () => {
  for (const pattern of PATTERNS) {
    it(`"${pattern}" appears nowhere in ${SCOPE}`, () => {
      const out = execSync(`grep -rn --exclude-dir=node_modules -F -- ${JSON.stringify(pattern)} ${SCOPE} || true`, { encoding: 'utf8' });
      const hits = out.split('\n').filter((l) => l && !l.includes('no-legacy-traces.test.ts') && !/CHANGELOG/.test(l));
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it to get the worklist**

Run: `pnpm vitest run --project unit tests/unit/licensing/no-legacy-traces.test.ts`
Expected: FAIL with the exact lines still to fix. (`FSL` / `LICENSE` file mentions of "license" are fine; only the listed patterns count. If `lifetime` hits the FSL text in `README.md:310`, narrow the pattern to `lifetime key` / `lifetime,` and re-run.)

- [ ] **Step 3: e2e harness**

`e2e-env.js`: replace `assertLicenseActive` with

```js
/**
 * Fail fast unless the licence signing key is present: the harness runs a
 * local stub of vibecarbon.com's licence API and every paid-tier deploy in
 * the matrix is checked against it. No key, no signed verdicts, and a
 * matrix leg would die 40 minutes in with "License not bound".
 */
export function assertLicenseSigningKey(env = process.env) {
  const key = signingKeyOrNull(env);
  if (key) return key;
  throw new Error(
    '[e2e-env] VIBECARBON_LICENSE_PRIVATE_KEY is not set (shell or tests/.env.e2e).\n' +
      'It is the same value as vibecarbon-web\'s LICENSE_SIGNING_PRIVATE_KEY, as raw PEM.',
  );
}
```

In `setupE2EEnv`: `const signingKey = assertLicenseSigningKey(env); const stub = await startLicenseStub({ privateKeyPem: signingKey });` (make `setupE2EEnv` async if it isn't; update its callers), store `stub` on the returned object, and in the child-env builder set `VIBECARBON_API_BASE: stub.baseUrl`. Export `licenseStub` for the runner.

`cli-runner.ts`: add

```ts
/** Mint a key in the stub (already bound to nothing), then bind it to the freshly created project with the real CLI. */
export async function runActivate(stub: LicenseStub, options: RunOptions): Promise<CliResult> {
  const { key, licenseId } = stub.mintKey();
  stub.seed({ licenseId, tier: 'fullerene', periodEndYmd: '2099-12-31' });
  return runCli(`activate ${key}`, options);
}
```

`runner.ts`: call `runActivate` immediately after `runCreate` succeeds, in the project dir; fail the leg if it exits non-zero.

- [ ] **Step 4: CI**

`test.yml`: the "Materialize license" step becomes

```yaml
      - name: Check licence signing key
        env:
          VIBECARBON_LICENSE_PRIVATE_KEY: ${{ secrets.VIBECARBON_LICENSE_PRIVATE_KEY }}
        run: |
          if [ -z "$VIBECARBON_LICENSE_PRIVATE_KEY" ]; then
            echo "::error::VIBECARBON_LICENSE_PRIVATE_KEY secret is not set — signed-verdict tests cannot run."
            exit 1
          fi
```

and every `VIBECARBON_TEST_LICENSE_KEY: ${{ secrets.VIBECARBON_TEST_LICENSE_KEY }}` becomes `VIBECARBON_LICENSE_PRIVATE_KEY: ${{ secrets.VIBECARBON_LICENSE_PRIVATE_KEY }}`. Same in `e2e-us-perf.yml`'s "Materialize credentials" step (delete the `~/.vibecarbon/license` write). **The user must add the secret in GitHub before this PR's CI can pass** — say so in the PR body.

- [ ] **Step 5: Docs**

`README.md:148-156`:

```md
| **`activate [key]`** | Bind a Graphene or Fullerene key to this project (unlocks Kubernetes and HA deploys). Run inside the project. |
| **`deactivate [key]`** | Release the key from this project; confirmed by a link emailed to the buyer. `-rm` removes only the local file |
```

`README.md:320`: replace from "Run `vibecarbon activate <key>`" to the end of the paragraph with: "Run `vibecarbon activate <key>` inside the project; it binds the key to that project on vibecarbon.com and writes `.vibecarbon.license`, which should be committed and shared with your team. A key is bound to one project at a time: `vibecarbon deactivate` emails the buyer a release link, after which the key can be activated elsewhere. Every bind and release is announced to the buyer by email. See [TERMS.md](./TERMS.md) for full usage terms. Generated project code is [MIT](./carbon/LICENSE), so you own your app outright."

`docs/specs/billing-modes.md`: rewrite the licence section to the one flow (key → activate/bind → check → deactivate/release), referencing the spec. `docs/tests.md`: the licence paragraph now describes the stub and `VIBECARBON_LICENSE_PRIVATE_KEY`. `no-dev-bypass.test.ts:11` comment: "activates a key minted for the local stub".

- [ ] **Step 6: Run everything**

Run: `pnpm lint && pnpm test:unit && pnpm test:integration`
Expected: all PASS including the census. Then `pnpm vitest run tests/unit/docs/cli-docs-census.test.ts` (paid modes still named in the docs).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(licensing): e2e uses the stub; CI secret is the signing key; docs and census for the clean sweep

Claude-Session: https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y"
```

---

### Task 10: Verification and PR

- [ ] **Step 1: Full local gate with the key present**

Ensure `tests/.env.e2e` has `VIBECARBON_LICENSE_PRIVATE_KEY`; run `pnpm test:prepush`. Expected: green, zero skipped signed cases (`grep -c "skipped"` in the output should show only unrelated skips).

- [ ] **Step 2: Manual smoke against the stub**

```bash
node -e "import('./tests/e2e/utils/license-stub.js').then(async m=>{const s=await m.startLicenseStub({privateKeyPem:process.env.VIBECARBON_LICENSE_PRIVATE_KEY});const k=s.mintKey();s.seed({licenseId:k.licenseId,periodEndYmd:'2099-12-31'});console.log(s.baseUrl, k.key);setInterval(()=>{},1e6)})"
```

In a scratch project (`vibecarbon create smoke -y …`): `VIBECARBON_API_BASE=<url> vibecarbon activate <key>` → binds; `VIBECARBON_API_BASE=<url> vibecarbon deploy -mode k8s -y` (with exec stubs or `-h`) → "Subscription checked"; `VIBECARBON_API_BASE=<url> vibecarbon deactivate -y` → "Check your email"; file still present; `deactivate -rm -y` → removed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/license-bind-at-activate
gh pr create --title "feat(licensing): keys bind to a project at activate, not at checkout" --body "$(cat <<'EOF'
## Summary
- One project-less key (`vc-<licenseId>-<sig>`); binding is server state set by `activate` (`POST /bind`) and cleared by an emailed link `deactivate` requests (`POST /release`). `/check` now sends `projectId`; `unbound` / `wrong_project` verdicts block without grace.
- Clean sweep: v1 lifetime key, v2 project-bound key, the `~/.vibecarbon/license` slot, `-all`, `-legacy`, and `VIBECARBON_TEST_LICENSE_KEY` are gone; a census test keeps them gone.
- Test harness runs a local licence-API stub signing real verdicts, so integration and e2e never touch vibecarbon.com.

Spec: `docs/superpowers/specs/2026-09-15-license-bind-at-activate-design.md`. Web half: vibecarbon-web (Phase 1 deployed first; Phase 2 after this merges).

## Before merging
- [ ] Add repository secret `VIBECARBON_LICENSE_PRIVATE_KEY` (raw PEM; same key as vibecarbon-web `LICENSE_SIGNING_PRIVATE_KEY`, base64-decoded) — CI is red until then.
- [ ] Delete the `VIBECARBON_TEST_LICENSE_KEY` secret afterwards.

## Test plan
- [ ] `pnpm test:prepush` green locally with the key
- [ ] CI green after the secret is added
- [ ] Manual: activate → deploy k8s (stub) → deactivate flow in a scratch project

https://claude.ai/code/session_01QDBQRrFniYosQwGj3uud1Y
EOF
)"
```

Report the PR URL. Do **not** merge or cut the release; those are the user's calls (the release must wait for vibecarbon-web Phase 2 to be deployed, per the spec's sequencing).
