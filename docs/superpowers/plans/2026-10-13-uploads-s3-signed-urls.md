# Uploads via S3 Signed URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User uploads go straight from the browser to the provider-native app bucket via signed URLs issued by Hono, and Supabase Storage + imgproxy are removed from the template.

**Architecture:** A small server module (`carbon/src/server/lib/storage.ts`) wraps `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against the app bucket already provisioned by `vibecarbon deploy` (env `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, already delivered to the app container in compose via `.env` and in k8s via `vibecarbon-secrets`). Hono checks permission and returns a presigned PUT (upload) or a 302 to a presigned GET (read). The bucket stays private. Local dev gets an S3-compatible container (SeaweedFS) in `docker-compose.override.yml` only. Deploy sets bucket CORS for the app origin.

**Tech Stack:** Hono, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, React 19, Vitest, SeaweedFS (dev only).

**Spec:** `~/.claude/plans/glowing-bubbling-papert.md`, decision 4 ("Uploads: private app bucket, Hono as gatekeeper, S3 moves the bytes").

## Global Constraints

- Never write file bytes to VPS disk; never proxy file bytes through Hono.
- The app bucket stays private; no public-read ACLs or bucket policies.
- Routes live under `/api` (already proxied by Vite in dev and routed to the app by Traefik in prod): upload presign `POST /api/v1/files/presign`, read `GET /api/files/*`.
- Object keys: `avatars/<userId>/<random>.<ext>` (public-read through the app) and `private/<userId>/<random>.<ext>` (owner-only). `<random>` = `crypto.randomUUID()`.
- Avatars: max 2 MB, types `image/jpeg|image/png|image/gif|image/webp`. Private uploads: max 10 MB, any type except `text/html`, `image/svg+xml`, `application/xhtml+xml` (stored-XSS vectors).
- Presigned PUT expires in 300 s; presigned GET expires in 300 s; the 302 response carries `Cache-Control: private, max-age=60`.
- Storage is optional: when any of the five S3 env vars is missing, the presign route returns `503 { error: 'storage_not_configured' }` and the read route returns 404. The app must still boot.
- Template package manager is npm (`carbon/package.json`); keep `overrides` and `pnpm.overrides` identical if touched.
- User-facing strings go through `t()` (see `carbon/AGENTS.md` Localization).
- No Supabase vocabulary in new code or copy (plan's terminology rule).
- Commits: conventional commits, pathspec commits only (`git commit -- <files>`), never `--no-verify`.

## Review Focus

1. A user requests a presign for another user's key path: the server derives the key itself from the session user id; client-supplied paths are never accepted. Test in Task 2.
2. Declared size differs from actual upload size: the signed `Content-Length` makes S3 reject a mismatched PUT; the server rejects declared sizes over the limit with 400. Test in Task 2 (server side; S3 enforcement is the provider's).
3. `GET /api/files/private/<otherUser>/...` from a signed-in user who is not the owner: 404 (not 403, to avoid confirming existence). Test in Task 3.
4. Path traversal / odd keys (`..`, `//`, URL-encoded slashes, keys outside `avatars/` and `private/`): 404 without signing. Test in Task 3.
5. Storage env missing (fresh local project before the S3 container starts, or a deploy without S3): app boots, presign returns 503 with a clear code, the avatar UI shows a translated error instead of crashing. Test in Tasks 1 and 4.

---

### Task 1: Server storage module

**Files:**
- Create: `carbon/src/server/lib/storage.ts`
- Modify: `carbon/src/server/lib/env.ts` (add optional S3 vars)
- Modify: `carbon/package.json` (+ `package-lock.json`): add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (same major as root `package.json`'s `@aws-sdk/client-s3` `^3`)
- Test: `carbon/tests/unit/server/storage.test.ts`

**Interfaces:**
- Produces:
  - `export const UPLOAD_KINDS = { avatar: { prefix: 'avatars', maxBytes: 2_097_152, types: ['image/jpeg','image/png','image/gif','image/webp'] }, private: { prefix: 'private', maxBytes: 10_485_760, types: null } } as const`
  - `export type UploadKind = keyof typeof UPLOAD_KINDS`
  - `export function isStorageConfigured(): boolean`
  - `export function buildObjectKey(kind: UploadKind, userId: string, contentType: string): string` (throws `StorageInputError` on bad type)
  - `export async function presignUpload(args: { kind: UploadKind; userId: string; contentType: string; size: number }): Promise<{ key: string; url: string; headers: Record<string, string>; expiresIn: number }>` (throws `StorageInputError` for size/type violations, `StorageNotConfiguredError` when unconfigured)
  - `export async function presignRead(key: string): Promise<string>`
  - `export function parseObjectKey(raw: string): { kind: UploadKind; userId: string; key: string } | null` (null for anything not matching `^(avatars|private)/<uuid-ish userId>/<uuid>\.<ext>$`)
  - `export class StorageInputError extends Error {}`; `export class StorageNotConfiguredError extends Error {}`

- [ ] **Step 1: Add env vars.** In `env.ts` `envSchema`, add after `SITE_URL`:
```ts
  // App storage bucket (provider-native S3, provisioned by `vibecarbon deploy`).
  // All optional: when any is missing, uploads are disabled (503) and the app
  // still boots.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
```
- [ ] **Step 2: Install deps.** `cd carbon && npm install @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3`
- [ ] **Step 3: Write failing tests** in `carbon/tests/unit/server/storage.test.ts` (look at sibling tests in `carbon/tests/unit/server/` for how env is stubbed; `carbon/tests/_helpers/env.ts`). Cover:
  - `buildObjectKey('avatar', 'u1', 'image/png')` matches `/^avatars\/u1\/[0-9a-f-]{36}\.png$/`; `'image/svg+xml'` for avatar throws `StorageInputError`; `private` with `text/html` throws; `private` with `application/pdf` → `.pdf`; unknown type → extension `bin`.
  - `presignUpload` with size `2_097_153` for avatar throws `StorageInputError`; size `0` throws; valid call returns `url` containing `X-Amz-Signature`, `headers` equal `{ 'Content-Type': 'image/png', 'Content-Length': '1000' }`, `expiresIn` 300, and `key` starting `avatars/u1/`.
  - With `S3_BUCKET` unset, `isStorageConfigured()` is false and `presignUpload` rejects with `StorageNotConfiguredError`.
  - `parseObjectKey` returns null for `avatars/u1/../x.png`, `avatars//x.png`, `other/u1/<uuid>.png`, `avatars/u1/<uuid>` (no ext), `avatars%2Fu1/...`; returns `{ kind: 'avatar', userId: 'u1', key }` for a valid key.
  - `presignRead(key)` returns a URL whose path ends with the key and contains `X-Amz-Expires=300`.
  Presigning is pure (no network) with the AWS SDK, so use fake creds `S3_ENDPOINT=http://localhost:8333`, `S3_REGION=us-east-1`, `S3_BUCKET=test-bucket`, keys `test`/`test`.
- [ ] **Step 4: Run** `cd carbon && npx vitest run tests/unit/server/storage.test.ts` → FAIL (module missing).
- [ ] **Step 5: Implement** `storage.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';

export const UPLOAD_KINDS = {
  avatar: {
    prefix: 'avatars',
    maxBytes: 2_097_152,
    types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as readonly string[],
  },
  private: { prefix: 'private', maxBytes: 10_485_760, types: null },
} as const;
export type UploadKind = keyof typeof UPLOAD_KINDS;

// Types a browser would render inline from our origin's links: refused even for
// private uploads so a stored file can never become a script on our domain.
const BLOCKED_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml']);
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
};
const EXPIRES_IN = 300;
const KEY_RE = /^(avatars|private)\/([A-Za-z0-9-]{1,64})\/([0-9a-f-]{36})\.([a-z0-9]{1,8})$/;

export class StorageInputError extends Error {}
export class StorageNotConfiguredError extends Error {}

export function isStorageConfigured(): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY);
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!isStorageConfigured()) throw new StorageNotConfiguredError('storage_not_configured');
  client ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY as string, secretAccessKey: env.S3_SECRET_KEY as string },
  });
  return client;
}

export function buildObjectKey(kind: UploadKind, userId: string, contentType: string): string {
  const spec = UPLOAD_KINDS[kind];
  if (BLOCKED_TYPES.has(contentType)) throw new StorageInputError('type_not_allowed');
  if (spec.types && !spec.types.includes(contentType)) throw new StorageInputError('type_not_allowed');
  return `${spec.prefix}/${userId}/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
}

export async function presignUpload(args: { kind: UploadKind; userId: string; contentType: string; size: number }) {
  const spec = UPLOAD_KINDS[args.kind];
  if (!Number.isInteger(args.size) || args.size <= 0 || args.size > spec.maxBytes) {
    throw new StorageInputError('size_not_allowed');
  }
  const key = buildObjectKey(args.kind, args.userId, args.contentType);
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET, Key: key, ContentType: args.contentType, ContentLength: args.size,
  });
  // Signing Content-Length makes S3 reject a body whose size differs from the
  // size we approved.
  const url = await getSignedUrl(s3(), command, {
    expiresIn: EXPIRES_IN,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return {
    key, url, expiresIn: EXPIRES_IN,
    headers: { 'Content-Type': args.contentType, 'Content-Length': String(args.size) },
  };
}

export async function presignRead(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: EXPIRES_IN });
}

export function parseObjectKey(raw: string): { kind: UploadKind; userId: string; key: string } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { kind: m[1] === 'avatars' ? 'avatar' : 'private', userId: m[2], key: raw };
}
```
  Note: `presignUpload` must check `isStorageConfigured()` before key building so the unconfigured error wins (call `s3()` first or check explicitly).
- [ ] **Step 6: Run** the test file → PASS; then `cd carbon && npm run lint && npm run typecheck` (use the scripts that exist in `carbon/package.json`).
- [ ] **Step 7: Commit** `git commit -m "feat(template): add S3 signed-URL storage module" -- carbon/src/server/lib/storage.ts carbon/src/server/lib/env.ts carbon/package.json carbon/package-lock.json carbon/tests/unit/server/storage.test.ts`

### Task 2: Presign route

**Files:**
- Create: `carbon/src/server/routes/v1/files.ts`
- Modify: `carbon/src/server/index.ts` (mount `app.route('/api/v1/files', filesRoutes)` next to the other `/api/v1` routes, and `app.route('/api/files', fileReadRoutes)` from Task 3)
- Test: `carbon/tests/integration/server/files-presign.test.ts` (follow existing `carbon/tests/integration/server/*` patterns and `carbon/tests/_helpers/app.ts` for building an authed request)

**Interfaces:**
- Consumes: `presignUpload`, `StorageInputError`, `StorageNotConfiguredError` (Task 1); the existing auth middleware that sets `c.get('user')` (read how `routes/v1/index.ts` guards authed routes and reuse the same middleware; do not invent a new one).
- Produces: `POST /api/v1/files/presign` body `{ kind: 'avatar' | 'private', contentType: string, size: number }` → `200 { key, url, headers, expiresIn, fileUrl }` where `fileUrl = '/api/files/' + key`; `400 { error: 'type_not_allowed' | 'size_not_allowed' | 'invalid_body' }`; `401` unauthenticated; `503 { error: 'storage_not_configured' }`.

- [ ] **Step 1: Failing tests:** unauthenticated → 401; avatar `image/png` size 1000 → 200 and `key` starts with `avatars/<session user id>/` (the session id, even when the body contains extra fields like `userId: 'someone-else'` or `path: '../x'`, which must be ignored); avatar `image/svg+xml` → 400 `type_not_allowed`; avatar size 3 MB → 400 `size_not_allowed`; body missing `size` → 400 `invalid_body`; with S3 env unset → 503 `storage_not_configured`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with zod validation (`z.object({ kind: z.enum(['avatar','private']), contentType: z.string().min(1).max(127), size: z.number().int() })`, `.strip()` so extra keys are dropped), map errors to the status codes above, rate-limit with the existing rate limiter used by other mutating routes (find it in `carbon/src/server/lib/rate-limiter.ts`; 30 requests / 10 min per user).
- [ ] **Step 4: Run** → PASS, plus `npm run lint && npm run typecheck`.
- [ ] **Step 5: Commit** `feat(template): add upload presign route`.

### Task 3: Read route

**Files:**
- Modify: `carbon/src/server/routes/v1/files.ts` (export `fileReadRoutes`)
- Test: `carbon/tests/integration/server/files-read.test.ts`

**Interfaces:**
- Consumes: `parseObjectKey`, `presignRead`, `isStorageConfigured` (Task 1); optional-auth helper used elsewhere for routes that work signed-in or not (find how `c.get('user')` is populated without rejecting; reuse it).
- Produces: `GET /api/files/*` → `302 Location: <presigned GET>` with `Cache-Control: private, max-age=60`; `404` for invalid keys, unconfigured storage, or private keys not owned by the signed-in user.

- [ ] **Step 1: Failing tests:** avatar key, anonymous → 302 with `X-Amz-Signature` in Location and the cache header; private key, anonymous → 404; private key, owner → 302; private key, other user → 404; keys `avatars/u1/../x.png`, `avatars%2Fu1%2F<uuid>.png`, `etc/passwd` → 404; storage unconfigured → 404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (take the raw path after `/api/files/` from `c.req.path`, never decode it, pass to `parseObjectKey`). **Step 4: Run** → PASS + lint/typecheck. **Step 5: Commit** `feat(template): serve stored files via signed redirects`.

### Task 4: Client upload flow + avatar resize

**Files:**
- Modify: `carbon/src/client/components/FileUpload.tsx` (replace the Supabase Storage calls)
- Create: `carbon/src/client/lib/image-resize.ts`
- Modify: `carbon/src/client/pages/settings/Profile.tsx` only if `AvatarUpload` props change
- Modify: locale files in `carbon/src/client/locales/` for any new strings
- Test: `carbon/tests/component/file-upload.test.tsx`, `carbon/tests/unit/client/image-resize.test.ts` (if a unit dir for client exists; otherwise put it under `carbon/tests/component/`)

**Interfaces:**
- Consumes: `POST /api/v1/files/presign` (Task 2) via the existing API helper in `carbon/src/client/lib/api.ts` (read it; reuse its auth header logic).
- Produces: `FileUpload` props become `{ kind: 'avatar' | 'private'; accept?; maxSize?; onUpload(url: string); onError?; className?; children? }` (drop `bucket` and `path`; the server owns the key). `onUpload` receives `fileUrl` (`/api/files/...`). `resizeImage(file: File, maxEdge: number, type?: 'image/webp'): Promise<Blob>`.

- [ ] **Step 1: Failing component test** (mock `fetch`): selecting a file calls presign with `{ kind, contentType, size }`, then `PUT`s the body to `url` with the returned `headers`, then calls `onUpload('/api/files/<key>')`; a 503 presign response calls `onError` with the translated "uploads are not configured" message; a failed PUT calls `onError`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: `AvatarUpload` resizes to max 256 px edge as `image/webp` (quality 0.9) via `createImageBitmap` + `OffscreenCanvas` (fall back to `<canvas>` when `OffscreenCanvas` is absent; if both fail, upload the original file) before calling the shared upload function; GIFs are uploaded as-is (resizing would drop animation). Remove the `supabase` import from `FileUpload.tsx`. Update the component doc comment to the new usage. **Step 4: Run** → PASS + lint/typecheck. **Step 5: Commit** `feat(template): upload files with signed URLs and resize avatars in the browser`.

### Task 5: Local S3 for development

**Files:**
- Modify: `carbon/docker-compose.override.yml` (dev-only; deploys use `-f docker-compose.yml -f docker-compose.prod.yml`, see `src/lib/deploy/compose/index.js:701`)
- Create: `carbon/volumes/s3/s3.json` (SeaweedFS identities file with dev-only keys)
- Modify: `carbon/scripts/dev-init.js` (write `S3_ENDPOINT=http://localhost:8333`, `S3_REGION=us-east-1`, `S3_BUCKET=<project>-local`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` into `.env.local` using the repo's dotenv module `carbon/scripts/lib/dotenv.js` `formatDotenvLine`; never hand-build lines)
- Create: `carbon/scripts/ensure-dev-bucket.js` (creates the bucket and sets CORS for `http://localhost:5173` + the `DEV_VITE_PORT` origin; idempotent), invoked from the dev start path (`carbon/scripts/docker-up.js` after services are healthy)
- Test: `carbon/tests/unit/scripts/ensure-dev-bucket.test.ts` (mock the S3 client: creates bucket when missing, tolerates `BucketAlreadyOwnedByYou`, always puts CORS)

- [ ] **Step 1:** Add service:
```yaml
  s3:
    image: chrislusf/seaweedfs:3.97
    container_name: ${PROJECT_NAME}-s3
    command: server -s3 -s3.config=/etc/seaweedfs/s3.json -dir=/data -master.volumeSizeLimitMB=256
    ports:
      - "${DEV_S3_PORT:-8333}:8333"
    volumes:
      - ./volumes/s3/s3.json:/etc/seaweedfs/s3.json:ro
      - s3_data:/data
    networks:
      - vibecarbon-network
```
  plus `s3_data:` under `volumes:`. Verify the tag exists on Docker Hub before using it (`docker manifest inspect chrislusf/seaweedfs:<tag>`); pick the newest 3.x that exists.
- [ ] **Step 2: Failing unit test** for `ensure-dev-bucket.js`, **Step 3: implement**, **Step 4: run** → PASS.
- [ ] **Step 5: Manual verification:** `cd carbon && node scripts/dev-init.js` (fresh), `docker compose up -d s3`, `node scripts/ensure-dev-bucket.js`, then run the server and do a real presign + `curl -X PUT` + `GET /api/files/<key>` round trip; paste the output into the task report.
- [ ] **Step 6: Commit** `feat(template): local S3 for development uploads`.

### Task 6: Remove Supabase Storage and imgproxy

**Files (find every reference with** `grep -rnE "imgproxy|storage-api|supabase/storage|/storage/v1|STORAGE_BACKEND|storage_data|waitForSupabaseStorageSchema|storage_upload|storage_download|storage_bucket_ensure"` **across `carbon/`, `src/`, `tests/`, `services/`, `docs/`):**
- `carbon/docker-compose.yml`, `carbon/docker-compose.prod.yml`, `carbon/docker-compose.override.yml`: delete `storage` and `imgproxy` services, `storage_data` volume, and any `depends_on`/env pointing at them.
- `carbon/volumes/kong/kong.yml`: delete the `/storage/v1` service/route.
- `carbon/k8s/values/supabase.values.yaml` + `supabase.standby.values.yaml`: `storage.enabled: false`, `imgproxy.enabled: false` (the chart stays until step 5).
- `carbon/supabase/migrations/00001_init.sql`: delete the STORAGE BUCKETS section and its `storage.objects` policies (template has no deployed customers; editing the base migration is allowed).
- `carbon/src/server/routes/v1/performance.ts`, `carbon/src/server/routes/_internal/services-status.ts`, `carbon/src/client/pages/admin/Infrastructure.tsx`: drop the storage service health entry.
- `src/lib/images.js`, `src/lib/status/container-rows.js`, `src/lib/deploy/k8s/k3s.js` (`waitForSupabaseStorageSchema` and its callers), `src/lib/deploy/k8s/standby-config.js`, `src/lib/deploy/compose/*`: drop storage/imgproxy image pins, expected-container lists, waits.
- `tests/e2e/checks/*`: replace the `storage_upload/download/delete/bucket_ensure` checks with one `file_upload_roundtrip` check: sign in, `POST /api/v1/files/presign` (avatar, 1x1 png), `PUT` to the returned URL, `GET /api/files/<key>` following the redirect, assert bytes equal.
- Unit/integration tests that pin the removed pieces: update or delete with a one-line justification in the commit body.

- [ ] **Step 1:** Run the grep; list each hit in the task report as removed / updated / intentionally kept (with reason).
- [ ] **Step 2:** Make the edits.
- [ ] **Step 3:** Root: `pnpm lint && pnpm test:unit && pnpm test:integration`; carbon: `npm run lint && npm run typecheck && npm test` (use carbon's actual script names). All green.
- [ ] **Step 4: Commit** `refactor: remove Supabase Storage and imgproxy`.

### Task 7: Bucket CORS at deploy

**Files:**
- Modify: `src/lib/providers/s3-base.js` (add `async setBucketCors(bucketName, origins)` using `PutBucketCorsCommand`: `AllowedMethods ['GET','PUT','HEAD']`, `AllowedHeaders ['content-type','content-length']`, `ExposeHeaders ['ETag']`, `MaxAgeSeconds 3600`)
- Modify: `src/lib/deploy/orchestrator.js` (after the app bucket create/exists step, call `setBucketCors(s3Config.bucket, ['https://' + domain])`; failure is a warning line, not a deploy failure, because uploads are the only consumer)
- Test: `tests/unit/providers/s3-bucket-cors.test.ts` (mock the S3 client; assert the command input), and extend the orchestrator unit test that covers bucket creation (find it with `grep -rln "Creating backup bucket\|createBucket" tests/unit`).

- [ ] **Step 1: Failing tests. Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS** + `pnpm lint && pnpm test:unit`. **Step 5: Commit** `feat(deploy): set CORS on the app bucket for browser uploads`.

### Task 8: Docs

**Files:** `carbon/AGENTS.md` (storage section: how to upload/read files with the new routes), `carbon/content/docs/**` pages that mention Supabase Storage or avatars storage, `carbon/README.md` if it lists services.
- [ ] **Step 1:** `grep -rniE "supabase storage|storage bucket|imgproxy|avatars bucket" carbon/AGENTS.md carbon/content carbon/README.md carbon/DEVELOPMENT.md`
- [ ] **Step 2:** Rewrite those passages for the signed-URL flow (voice: friendly second person, no em dashes in user-facing copy).
- [ ] **Step 3: Commit** `docs(template): document signed-URL uploads`.
