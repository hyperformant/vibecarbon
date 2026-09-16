# License keys bind to a project at `activate`, not at checkout

**Date:** 2026-09-15
**Status:** Approved design, awaiting implementation plan
**Repos:** `vibecarbon` (CLI, this repo) and `vibecarbon-web` (API, pricing, fulfilment). The CLI and the API it calls change together; the web-side sections name the vibecarbon-web files.
**Supersedes:** the v1 lifetime key (`vc-f-<customerId>-<sig>`, global slot) and the v2 project-bound key (`vc2-<customerId>-<projectId>-<sig>`, merged to `main` in #96, never released). Both are removed, not deprecated.

## Why

Today a buyer must run `vibecarbon create`, open `.vibecarbon.json`, copy `projectId`, and paste it into the pricing page before they can pay, because the project id is signed into the v2 key at Stripe fulfilment. That inverts the natural order (pay, then point the licence at a project) and blocks anyone who wants to buy before scaffolding.

Nobody has purchased a licence on any version, so there is nothing to stay compatible with. This design replaces every prior key format with one key and one flow, and removes all traces of the old ones.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Does a licence belong to an account? | Yes. Stripe Checkout still collects only an email. The purchase email carries a Supabase magic link; the account is created on first click. No signup wall before payment. |
| Moving a subscription to another project | Release + rebind, self-serve from the CLI (`deactivate`) or the dashboard (later workstream). One project at a time. |
| Key shape | One project-less key. Binding is server state only ("option B"). The CLI never infers the project from the key. |
| Backwards compatibility | None. Clean sweep of v1 and v2 code, fixtures, env vars, and docs. |

## 1. Key and data model

### The key

```
vc-<licenseId16>-<sigHex>
message signed: <licenseId16>
```

- `licenseId` is 16 lowercase hex characters, random, minted once at fulfilment and stored. It is the handle the dashboard, `/bind`, `/release`, and support use.
- Ed25519, same signing pair as today: private half in vibecarbon-web `.env` (`LICENSE_SIGNING_PRIVATE_KEY`), public half embedded in `src/lib/licensing/validator.js`.
- The key is stable for the life of the subscription. Bind, release, rebind, renewal, plan switch, and status change never re-mint it.
- No email hash, no tier, no project, no version digit in the key. The CLI verifies the signature and forwards the key; the server owns every fact about it.

### `license_subscriptions` (vibecarbon-web, migration `00012`)

The table has no real rows, so this is a redefinition, not an evolution:

| Change | Column |
|---|---|
| add | `license_id TEXT NOT NULL UNIQUE` (16 hex) |
| add | `user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL` (filled when the buyer first uses the magic link; nothing else in this workstream reads it) |
| add | `bound_at TIMESTAMPTZ NULL` |
| alter | `project_id UUID` becomes **nullable**; `NULL` means unbound |
| drop | `customer_hash` |
| keep | the partial unique index from `00011` ("one active subscription per project"); it ignores `NULL` naturally |

Lookup index becomes `(license_id)` (covered by the unique constraint) plus the existing unfulfilled index. `customer_hash`'s lookup index is dropped with the column.

## 2. API (vibecarbon-web, `src/server/routes/v1/license.ts`)

Every route takes the key as proof. The server verifies the signature, extracts `licenseId`, and loads the row by `license_id`. A key that verifies but has no row is `401 { error: 'unknown_key' }` (same class of refusal as a bad signature).

| Route | Body | Behaviour |
|---|---|---|
| `POST /bind` **new** | `{ key, projectId, cliVersion }` | `project_id IS NULL` → set `project_id`, `bound_at`; `200 { projectId, tier, status, periodEnd }`. Already bound to **this** project → same `200` (idempotent; re-running `activate` in a fresh clone is harmless). Bound to **another** project → `409 { error: 'bound_to_other_project' }` (the other project id is **not** returned). Another active subscription already bound to this project → `409 { error: 'project_already_licensed', switchPlan: boolean }` (this check moves here from checkout). Row status not `active`/`past_due` → `403 { error: 'subscription_inactive' }`. |
| `POST /release` **new** | `{ key }` | Sets `project_id = NULL`, `bound_at = NULL`. `200 { released: true }`. Idempotent (already unbound → same response). Works whatever the subscription status, so a lapsed key can still be cleaned up. |
| `POST /check` **changed** | `{ key, projectId, cliVersion }` | `projectId` is now **required** (the server used to read it out of the key). Unbound row → verdict `status: 'unbound'`. Bound to a different project → `status: 'wrong_project'`. Otherwise unchanged: `active` / `past_due` / `canceled`, tier, `periodEnd`, `cancelAtPeriodEnd`. The signed verdict token embeds the **requested** `projectId` in every case so the CLI's cache (keyed by project) stays consistent; for `unbound`/`wrong_project` the tier is `'none'`. |
| `POST /status` **new** | `{ key }` | Browser-facing read for the `/license` page: `200 { tier, status, periodEnd, cancelAtPeriodEnd, projectId: uuid \| null }`. No verdict token, no `projectId` input, never used by the CLI. Exists so `/check` can keep `projectId` required. |
| `POST /resend`, `POST /portal` | unchanged | Already work from the key alone. `/resend` mails the key; `/portal` mails a Customer Portal link. Both keep emailing rather than returning, for the reasons in `License.tsx`'s header comment. |

`VerdictStatus` (`src/server/billing/license-catalog.ts`) becomes `'active' | 'past_due' | 'canceled' | 'unbound' | 'wrong_project' | 'none'`. `'none'` remains "no row" (used only when the key is unknown, which is already a 401, so in practice the CLI sees it only from a hand-built token — keep it for the type's completeness and the existing tests).

Rate limiting: `/bind` and `/release` join the existing per-key limiter (`lastSentAt` map) with the same window as `/resend`.

Removed: `POST /billing/license-checkout` no longer accepts or validates `projectId`; the `project_already_licensed` check leaves it. `cancelUrl` drops `?project=`.

## 3. CLI (this repo)

### Storage

One file, `.vibecarbon.license` in the project root, committed to git. `src/lib/licensing/index.js` loses the two-slot model: no `~/.vibecarbon/license`, no `legacy`/`project` slot, no `listStoredLicenses`. `getLicense()` reads the one file, verifies the signature, and returns `{ key, licenseId, valid, storedAt }` or `null`.

### `activate [key]` (`src/activate.js`)

1. Parse `vc-<16 hex>-<128 hex>`; anything else is "Invalid key format. Expected vc-…" before any network.
2. Verify the signature locally (typo fast-fail; not the source of truth).
3. Read `projectId` from `.vibecarbon.json`. None → "No project here. Run `vibecarbon create` first, then activate inside it." and exit 1.
4. `POST ${VIBECARBON_API_BASE}/api/v1/license/bind`.
   - `200` → write `.vibecarbon.license`, print tier and project.
   - `409 bound_to_other_project` → "This key is already bound to another project. Run `vibecarbon deactivate` in that project, or release it from your dashboard, then activate again." exit 1.
   - `409 project_already_licensed` → print the message and, when `switchPlan`, point at `${SITE_URL}/license`. exit 1.
   - `403 subscription_inactive` → "This subscription is no longer active" + portal hint. exit 1.
   - network failure / 5xx / 429 → "Activation needs a connection to vibecarbon.com" and **write nothing**. exit 1. There is no offline activate.
5. A valid `.vibecarbon.license` already present for the same key → still call `/bind` (idempotent) so a clone on a new machine self-heals; print "already active".

### `deactivate [key]`

Reads the key from `.vibecarbon.license` (or the positional argument, for the deleted-repo case), `POST /release`, then deletes the file if it exists. Network failure → "Could not reach vibecarbon.com; the key is still bound. Nothing was removed." exit 1. Idempotent when no file and no bind.

### Deploy-time check (`src/lib/licensing/check.js`, `entitlement.js`, `gate.js`, `upsell.js`)

- `check.js` adds `projectId` to the request body. Nothing else changes: cache path, `fallback`, the 429/5xx/WAF handling all stand.
- `entitlement.js` decision table gains two rows, both **blocking**, both bypassing grace (grace exists for billing hiccups, not for an unbound key):
  - `unbound` → `reason: 'unbound'`; copy: "This key isn't bound to a project yet. Run `vibecarbon activate <key>` here."
  - `wrong_project` → `reason: 'wrong_project'`; copy: "This key is bound to a different project. Run `vibecarbon deactivate` there first, or release it from your dashboard."
- The local "embedded UUID matches `.vibecarbon.json`" comparison is deleted; the server is the only place that knows the binding.

### Removed from the CLI

`vc-f-`/`vc2-` parsing; `-legacy`, `-refresh`, and the legacy slot branch in `activate`; `~/.vibecarbon/license`; `scripts/generate-license.js` loses `-legacy`, `--tier`, `--customer`, `--email` and gains `--license-id <16hex>` (random when omitted); every "legacy lifetime" test fixture and comment; the `wrong-project` local-mismatch error; docs and `README` lines that describe any of it. `getReleaseDate()`/FSL stamping is unrelated and stays.

### Integration test harness (`tests/integration/_harness/run-cli.ts`)

The harness currently gets past `requireLicense()` with a real legacy lifetime key. That key ceases to exist. Replacement:

- `VIBECARBON_TEST_LICENSE_KEY` is removed. `VIBECARBON_LICENSE_PRIVATE_KEY` is required instead (shell, `tests/.env.e2e`, or the CI secret).
- The harness starts one in-process HTTP stub per test file, implementing `/api/v1/license/{bind,release,check}` with an in-memory `Map<licenseId, { projectId, tier, status, periodEnd }>`, signing verdict tokens with that private key. It mints a key with `scripts/generate-license.js`, pre-binds it to the project under test, writes `.vibecarbon.license` into the fake project dir, and sets `VIBECARBON_API_BASE` for the spawned CLI.
- Consequence accepted by the user: the production signing private key becomes a GitHub Actions secret in this repo (it already lives in vibecarbon-web's deployed `.env`). The alternative, a test-only public key override in the CLI, would be a production bypass and is rejected.
- The e2e harness (`tests/e2e`) uses the same stub; its `node src/cli.js activate` step becomes "write `.vibecarbon.license` + pre-bind in the stub".

## 4. Web: pricing, checkout, fulfilment, email (vibecarbon-web)

### Pricing (`src/client/components/PricingSection.tsx`)

- Delete `PricingProjectField.tsx`, the `projectId`/`projectIdValid`/`onProjectIdMissing` props, the `?project=` search param, and the "Enter your project ID to continue." string (added 2026-09-15 as a stopgap; gone with the field).
- Checkout body is `{ tier, interval }`.
- The interval toggle becomes a plain `Monthly | Annual` segment; the "Two months free" badge moves to a muted caption directly under the toggle: "Annual billing: two months free." Always visible, not tied to the selected interval. Mirror upstream in `carbon/src/client/components/PricingSection.tsx` (the toggle is template code).

### Fulfilment (`src/server/billing/fulfillment.ts`, `license.ts`)

- One `mintLicenseKey({ privateKeyPem, licenseId })`. `mintLicenseKeyV2`, `customerIdFromEmail`, `compactProjectId`, `rehyphenateProjectId`, `buildV2Message`, `formatV2Key`, `parseV2Key`, and the v1 `TIER_CHARS` map are deleted. `parseLicenseKey(key) → { licenseId } | null` and `verifyLicenseKey` are the only parsing surface.
- On `checkout.session.completed`: mint `licenseId`, mint the key, insert the row with `project_id = NULL`, send the purchase email. Deterministic re-minting is gone, so fulfilment stores nothing extra: the key is re-derivable from the stored `licenseId` + private key whenever `/resend` needs it.
- `license-catalog.ts`: delete `LEGACY_LIFETIME_FULLERENE`, `FULLERENE_PRICE_ID`, and the one-time-purchase branch. Remove `FULLERENE_PRICE_ID` from `.env`, `.env.local`, `.env.example`, and the Stripe product if the user wants (out of scope for code).

### Purchase email (`src/server/emails/templates.ts`)

Contains, in order: the key; the exact command `vibecarbon activate vc-…` with "run this inside your project"; a Supabase magic link (`supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email })`, the same helper `impersonation.ts:146` already uses) whose redirect is `/dashboard`; the `/license` self-serve link. The magic-link callback (`AuthCallback.tsx` → existing auth route) additionally runs `UPDATE license_subscriptions SET user_id = auth.uid() WHERE email = <verified email> AND user_id IS NULL`. That single statement is the entirety of account plumbing in this workstream; the dashboard itself is a separate spec.

### Success page (`src/client/pages/Checkout.tsx`)

No longer derives the key. Shows "Your licence key is on its way to *email*", the `activate` instructions, and a "Didn't get it? Resend" link to `/license`.

### `/license` page (`src/client/pages/License.tsx`)

Behaviour unchanged. The status result gains one line: "Bound to project `<uuid>`" or "Not bound to a project yet". `/check` on this page passes no `projectId`; the server treats an omitted `projectId` from a browser session as "report binding only" — implement as a separate `POST /status { key }` returning `{ tier, status, periodEnd, projectId | null }` rather than overloading `/check`, which must keep `projectId` required for the CLI.

### Docs

`docs/specs/billing-modes.md` (this repo) is rewritten for the one flow. vibecarbon-web `content/docs/*.mdx` pages that mention the project id at purchase, `vc-f`, `vc2`, lifetime keys, or `~/.vibecarbon/license` are updated: `getting-started.mdx`, `cli.mdx`, `deployment.mdx`, `environments.mdx`, and the blog comparison post's pricing paragraph.

## 5. Error handling summary

| Situation | Where caught | Outcome |
|---|---|---|
| Typo in key | CLI, before network | format / signature error, exit 1 |
| Key verifies, no row | `/bind`, `/check` | `401 unknown_key` → CLI "This key isn't recognised" |
| Activate offline | CLI | error, nothing written |
| Activate in a project that already has another active subscription | `/bind` 409 | message + `/license` hint |
| Activate a key bound elsewhere | `/bind` 409 | deactivate-there / dashboard hint |
| Deploy with unbound key | `/check` verdict | block, `activate` hint, no grace |
| Deploy with key bound to another project | `/check` verdict | block, `deactivate` hint, no grace |
| Deploy offline with cached verdict | CLI cache | unchanged 30-day grace |
| Stripe webhook retry after insert | fulfilment | idempotent on `provider_subscription_id` (unchanged) |
| Buyer deletes the repo without deactivating | dashboard (later) or `deactivate <key>` from anywhere | release |

## 6. Testing

**vibecarbon-web**
- `license-mint.test.ts`: mint/parse/verify the new key; rejects malformed, wrong-length, or tampered keys; the key is stable across re-mint for the same `licenseId`.
- `/bind` state machine: unbound → bound; same project → idempotent 200; other project → 409; project already licensed → 409 with `switchPlan`; inactive → 403; unknown key → 401.
- `/release`: bound → released; already released → 200; unknown → 401.
- `/check`: `projectId` required (400 when missing); `unbound` and `wrong_project` verdicts carry tier `none` and the requested `projectId`; active bound key unchanged.
- `/status`: returns binding without a project id.
- Fulfilment: inserts `project_id = NULL`, `license_id` present; email contains key, command, magic link.
- Pricing component: no project field; checkout body `{ tier, interval }`; caption under the toggle.
- Structural: no reference to `vc2`, `customer_hash`, `FULLERENE_PRICE_ID`, `PricingProjectField`, or `mintLicenseKeyV2` anywhere under `src/` or `tests/`.

**vibecarbon (CLI)**
- validator: accepts the new format only; rejects `vc-f-…` and `vc2-…` explicitly.
- `activate`: each row of the `/bind` outcome table; offline writes nothing; no `.vibecarbon.json` → create hint; idempotent re-activate.
- `deactivate`: releases then deletes; positional key with no file; offline leaves the file.
- `check.js`: sends `projectId`; cache/fallback tests unchanged.
- `entitlement.js`: `unbound` and `wrong_project` block without grace; existing rows unchanged.
- Harness: stub server signs verifiable verdicts; a paid command reaches its arg-parse logic with a stub-bound key; the no-local-bypass census (`a4c099e`) still passes.
- Structural census: no `legacy`, `lifetime`, `vc2`, `~/.vibecarbon/license`, or `VIBECARBON_TEST_LICENSE_KEY` anywhere in `src/`, `tests/`, `scripts/`, or docs.

## 7. Sequencing

1. **vibecarbon-web API, additive**: migration `00012`, new mint/parse, `/bind`, `/release`, `/status`, `/check` with required `projectId` and the two new statuses. Deploy. Nothing public changes yet because no CLI calls these.
2. **CLI PR (this repo)**: storage, `activate`, `deactivate`, `check.js`, entitlement, harness, docs. CI green requires the new `VIBECARBON_LICENSE_PRIVATE_KEY` secret to exist first.
3. **vibecarbon-web switch**: pricing without project field, fulfilment mints unbound keys, new email and success page, remove v1/v2 code and `FULLERENE_PRICE_ID`. Deploy.
4. Cut CLI **0.44.0**. Order matters: a CLI that `activate`s against an API without `/bind` would fail for every buyer, so 1 precedes 2, and 3 precedes 4 so the first public release never sees a v2 key minted.

## Out of scope

The project dashboard (viewing projects, releasing bindings in the browser, changing plans, account management) is the next spec; this design only guarantees it has `user_id` and `license_id` to build on. Stripe-side cleanup of the legacy lifetime product is a manual step for the user.
