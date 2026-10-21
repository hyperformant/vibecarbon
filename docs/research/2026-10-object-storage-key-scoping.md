# Object storage key scoping (real accounts, 2026-10-20)

The evidence behind ruling R2 of the security-hardening plan (docs/superpowers/plans/2026-10-20-security-hardening.md): which providers can give each environment's app its own object-storage key, and how. Copied from the spike notes with every access-key fragment removed. Every key, bucket and policy the spike created was deleted (see the cleanup lines).

Scripts and raw logs stayed in the session scratchpad (`lib.mjs`, `linode.mjs`, `do.mjs`, `scaleway.mjs`, `scw-perm.mjs`, `scw-org.mjs`, `hetzner.mjs`, `vultr.mjs`, `*.log`). Credentials loaded in-process via `util.parseEnv(tests/.env.e2e)`; secrets redacted in all output. Each probe: two buckets A/B (each with `seed.txt`), then Put/Get/List/Delete on A and B, plus ListBuckets.

## Summary table (corrected the first draft of R2)

| Provider | Per-bucket key | Via API | Verified live | Prefix scope | First-draft R2 claim |
|---|---|---|---|---|---|
| Linode | yes, `bucket_access` read_write | yes | **yes** | no (bucket-level only) | confirmed |
| DigitalOcean | yes, `grants[{bucket, permission}]` | **yes** (`/v2/spaces/keys`) | **yes** | no (400 on `bucket/prefix`) | **wrong**: API minting works, no console paste needed |
| Scaleway | mechanism exists (IAM app + bucket policy) | yes, but needs org IAM rights | **no**: our key has zero IAM permissions | yes, per docs (bucket policy Resource `bucket/prefix/*`) | still unconfirmed; token gap now confirmed |
| Hetzner | no API to mint keys; bucket policies enforced, but principal looks like the project, not the key | no (console only) | partial: policy engine yes, per-key separation **not** shown | yes, for everyone at once (Deny `*` on prefix enforced) | key mint: confirmed console-only; "policy can separate keys" looks unlikely |
| Vultr | no | no | n/a (no key endpoints) | Deny-`*` prefix policies enforced, not per key | confirmed |

## Linode: mint, verified

- Lookup: `GET /v4/object-storage/endpoints` maps `us-iad-10.linodeobjects.com` to region `us-iad`.
- Mint: `POST /v4/object-storage/keys` with
  `{"label":"…","regions":["us-iad"],"bucket_access":[{"region":"us-iad","bucket_name":"<A>","permissions":"read_write"}]}`
  returns 200 with `limited: true`, `access_key` and `secret_key`. The echoed `bucket_access[].cluster` is `us-iad-1` even though the endpoint is `us-iad-10`, and it works anyway.
- Scoped key, about 5 s after minting: A Put/Get/List/Delete all **OK**. B Put/Get/List/Delete all **403 AccessDenied**.
- Control: the infra key is OK on both.
- Revoke: `DELETE /v4/object-storage/keys/{id}` returns 200.
- Quirks:
  - ListBuckets fails with SignatureDoesNotMatch for both keys at the path-style root (an existing Linode quirk, not about scoping).
  - On B, a scoped GET of a missing key returned 404 NoSuchKey, while an existing key returned 403. That is a minor key-existence oracle on other buckets.
- Residual risk: the key covers the whole bucket, so envs sharing the app bucket can see each other (R4).
- Cleanup: key deleted (list shows none with the spike label), and both buckets deleted (`GET /v4/object-storage/buckets/us-iad` shows none).

## DigitalOcean Spaces: mint via API, verified (plan said console-only, which is wrong)

- `GET /v2/spaces/keys` returns 200, so the endpoint exists. The account has 1 pre-existing key, which was left untouched.
- Mint: `POST /v2/spaces/keys` with `{"name":"…","grants":[{"bucket":"<A>","permission":"readwrite"}]}` returns 201 with `key.access_key` and `key.secret_key`.
- Scoped key, about 10 s after minting: A Put/Get/List/Delete **OK**. B Put/Get/List/Delete **403**. ListBuckets 403.
- Prefix: a grant with `bucket: "<A>/app/"` returns 400 "bucket name must begin and end with lowercase letters or numbers", so there is no prefix scope.
- Revoke: `DELETE /v2/spaces/keys/{access_key}` returns 204.
- The DO token used is the e2e full-access token. A custom-scoped token would need the `spaces_key` create/delete scopes. That is untested, but these are the DO scope names.
- Residual risk: bucket-level only (R4). DO has `fullaccess` (all buckets) and `read`/`readwrite` (per bucket) grants, so the deploy must never mint `fullaccess` for the app.
- Cleanup: key deleted (204), and no spike keys remain. Both buckets deleted. Bucket B lingered in ListBuckets for about 20 s (eventual consistency), then HeadBucket returned 404 and the list was empty.

## Scaleway: not verified, blocked by token permissions

- The e2e key has **no IAM permissions at all**:
  - `GET /iam/v1alpha1/api-keys/{own AK}` returns 403 permissions_denied (`iam get api_key`).
  - `GET /account/v3/projects/{id}` returns 403.
  - List of applications, policies and api-keys returns 403.
  - `POST /iam/v1alpha1/applications` (organization_id = the default project id, which Scaleway uses as the org id) returns **403 `iam create application`**.
- Nothing was created in IAM.
- The S3 owner ID is `<project>:<project>`, so the key's own principal (`user_id:` or `application_id:`) cannot be discovered without IAM read. `PutBucketPolicy` with an invalid principal gives 400 MalformedPolicy "Invalid principal in policy", so principals are validated.
- Docs (context7, scaleway/docs-content, "combining IAM and bucket policies"):
  - A principal must first get Object Storage access through an **IAM policy**, and IAM grants are **project-wide**.
  - Once a bucket has a policy, only the principals it lists explicitly keep access, including the owner, who must be listed.
  - Prefix scoping works through `Resource: ["<bucket>/prefix/*"]`.
- So a one-bucket app key on Scaleway means one of these:
  - (a) the app bucket in a dedicated project, with the IAM rule `project_ids: [thatProject]` (clean);
  - (b) project-wide IAM for the app plus a bucket policy on **every** other bucket (backup and state) that lists only the infra principal. This is fragile: a bucket without a policy is open to the app.
- Either way, minting needs an org-level IAM permission set on the deploy key (IAMManager or equivalent: applications, api-keys and policies write). That would make the deploy credential able to mint org-wide keys, which is itself an escalation to weigh.
- Not verified live. Re-run `scaleway.mjs` with a key that has IAMManager to verify. It already does: app without IAM, bucket policy grant, prefix policy, project-wide IAM, and a conditioned-rule attempt.
- Cleanup: both buckets deleted. A transient local DNS/IPv6 failure hit the first cleanup, and `scw-clean.mjs` re-run confirmed the list is empty. No apps, policies or keys exist (all creates were refused).

## Hetzner: console-only key mint; policy engine is real; per-key separation unproven

- No credential API:
  - `api.hetzner.cloud/v1/{object_storage, object_storage/credentials, object-storage/credentials, s3_credentials, buckets}` all return 404 "api route not found".
  - `api.hetzner.com/v1/object_storage/credentials` returns 404. That host does serve `/v1/storage_boxes` (200), so the probe reached a real API.
- The backend is Ceph RGW (`fsn1-prod1-ceph5` in request IDs). The S3 Owner ID is `p<hex>`, 9 characters, which looks like a **project-level** RGW user. The ACL shows the bucket owner = that ID with FULL_CONTROL.
- Bucket policy supported and enforced:
  - Policy `{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Principal":"*","Action":["s3:PutObject","s3:GetObject"],"Resource":["arn:aws:s3:::<A>/other/*"]}]}` is accepted (204).
  - Our own key: PutObject `other/obj.txt` gets 403. `app/` and root objects stay OK.
- Principal strings that match our key, tested with a Deny on PutObject `other/*`:
  - `{"AWS":["arn:aws:iam:::user/<ownerId>"]}` **matches** (403).
  - `{"AWS":["<ownerId>"]}` **matches** (403).
  - `arn:aws:iam::<ownerId>:root` and `arn:aws:iam:::user/<accessKey>` do **not** match.
- So a principal is the project user, not the access key. If every key in a project maps to the same RGW user (likely, given the FAQ "every key works on every bucket in the project"), **a bucket policy cannot tell the app key from the infra key**.
- To settle it, a second console key is needed:
  - compare its ListBuckets `Owner.ID`; if it is the same `p…` ID, per-key policy is impossible;
  - also try `arn:aws:iam:::user/<owner>:<subuser>` in case each key is an RGW subuser.
- An Allow-only policy naming a foreign principal did **not** lock out the owner (AWS semantics, unlike Scaleway).
- Versioning: PutBucketVersioning Enabled works. GetObjectLockConfiguration on a normal bucket gives 404 ObjectLockConfigurationNotFound. Object lock needs a create-time flag and was not tested (input to R3).
- Flake seen: one transient 404 NoSuchBucket on an existing bucket right after creation (eventual consistency).
- Residual risk: as things stand, the documented isolation is a **separate Hetzner project** (own key, console-made) for the app bucket.
- Cleanup: policy deleted (204), and both buckets deleted (including object versions). ListBuckets shows no spike buckets.

## Vultr: no scoping, confirmed

- `GET /v2/object-storage` lists 1 subscription (ewr, tier `tier_008h_0600m_archive`).
- `/v2/object-storage/{id}/{keys,access-keys,users,credentials}` all return 404. The only key operation in Vultr's API is regenerating the subscription's single key pair.
- Ceph RGW: a Deny-`*` prefix bucket policy is accepted and enforced for our key (PutObject `other/` gets 403), but it applies to everyone, so it cannot separate an app key.
- The only isolation is a separate Object Storage subscription, which costs a monthly fee per subscription. Not created.
- Residual risk: shared tier.
- Cleanup: policy deleted, both buckets deleted, and the list is empty.

## Cleanup confirmation (all providers)

Nothing remains: no `vc-scope-spike-*` buckets on any provider, no spike keys on Linode or DO, and no Scaleway IAM objects (none were ever created). Hetzner and Vultr had no keys to clean.

## Implications (superseded by plan ruling R2)

- `appKeyScoping`:
  - linode = `mint`, verified;
  - **digitalocean = `mint`**, verified; this replaces the planned paste flow;
  - scaleway = `mint` only if the deploy key gets IAM write (needs Brandon's decision), else `none`; the preferred design is a dedicated project for the app bucket;
  - hetzner = `none` unless a second console key proves a distinct principal; the isolation option is a separate project;
  - vultr = `none`.
- Prefix scoping, so envs sharing the app bucket are separated: not possible with any minted key (Linode and DO are bucket-only). Only Scaleway bucket policies offer it, per docs. R4 stands, and getting envs isolated needs an app bucket per env.

## Hetzner second key

A second console key was made in the same project as key 1. Scripts: `hetzner2-id.mjs`, `hetzner2-fresh.mjs` (the definitive principal matrix), `hetzner2-design.mjs`, `hetzner2-delbkt.mjs`. `hetzner2-pol.mjs` is the discarded first attempt (see the caveat below).

- **Identity.** Both keys report the same ListBuckets `Owner.ID` and DisplayName, the project user `p<digits>`. A bucket created by key 2 is owned by that same ID, and key 1 reads it freely. Owner and ACL data cannot tell the keys apart.
- **But each key is an RGW subuser named by its access key ID.** The principal `arn:aws:iam:::user/<ownerId>:<accessKeyId>` matches only that key. Fresh bucket per policy, 10 PutObject samples per key, after a 60 s wait:
  - Deny `user/<owner>:<AK2>`: key1 allowed every time, key2 denied every time. **Distinguishes.**
  - Deny with `NotPrincipal user/<owner>:<AK1>`: key1 allowed, key2 denied. **Distinguishes.**
  - Deny `user/<owner>` or `*`: both keys denied (controls).
  - Deny `user/<owner>:BOGUS`: both allowed, so the match is exact, not "any subuser".
  - No match on either key: `user/<AK2>`, bare `<AK2>`, the conditions `aws:username=<AK2>`, `aws:userid` like `*AK2*`, `aws:PrincipalArn` like `*AK2*`, `aws:AccessKeyId`. (`aws:username=<owner>` matches both keys.)
  - A `CanonicalUser` principal is rejected (503).
- **Deny-list on another bucket works for data.** Bucket B with Deny `s3:*` for `user/<owner>:<AK2>` on `B` and `B/*`:
  - key2 is denied Put, Get, List and DeleteObject. It is also denied Get, Put and DeleteBucketPolicy, PutBucketAcl, PutBucketVersioning, PutBucketLifecycle and PutBucketCors. The app key cannot remove the fence.
  - key1 keeps full access.
- **Allow-list on the app bucket alone does not fence the app out of other buckets.** A bucket policy only governs its own bucket, and the owner/subuser has implicit project-wide access (an Allow-only policy never locks anyone out). Deny `NotPrincipal user/<owner>:<AK2>` on bucket A does make A app-only (key1 was denied object ops), but that is the reverse direction.
- **Gaps that bucket policies cannot close:**
  1. **DeleteBucket ignores the deny.** key2 deleted an *empty* fenced bucket, even with an explicit `s3:DeleteBucket` deny (owner override). A non-empty one returns 409, and key2 cannot empty it.
  2. **Project-wide calls.** key2 can ListBuckets (sees every bucket name) and CreateBucket.
  3. **Any bucket without the policy is fully open** to the app key. That includes buckets created later.
- **Caveat: the policy cache is slow and inconsistent.** Rewriting the policy on the *same* bucket gave mixed allow/deny results across gateways for over 30 s, and a deleted policy was still enforced on some gateways a minute later. Set each fence once, at bucket creation, then verify with a polled probe. Don't rewrite it and expect the change to apply right away.
- **Conclusion: per-key isolation works on Hetzner, as a deny-list.**
  - Put `{"Effect":"Deny","Principal":{"AWS":["arn:aws:iam:::user/<ownerId>:<appAccessKeyId>"]},"Action":["s3:*"],"Resource":["arn:aws:s3:::<bucket>","arn:aws:s3:::<bucket>/*"]}` on **every** non-app bucket in the project (state, backups, and the app buckets of other environments).
  - Optionally add Deny `NotPrincipal <app subuser + infra subuser>` on the app bucket.
  - Residual risks: an empty fenced bucket can be deleted, bucket names are visible, and any unfenced or new bucket is open. Minting is still console-only. The `<ownerId>` comes from ListBuckets and the access key ID is known, so the deploy can write the fences.
  - A separate project is still the stronger isolation.
- **Cleanup.** All `vc-scope-spike-hetzner2-*` buckets and policies are deleted. Both keys' ListBuckets show only the 1 pre-existing bucket, which was never touched. Two buckets needed a delayed retry (eventual consistency or a stale deny), and the retry confirmed both gone.
