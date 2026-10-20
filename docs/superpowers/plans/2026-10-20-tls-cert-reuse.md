# TLS Certificate Reuse and Non-Blocking First Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let's Encrypt only matters on a domain's first-ever deploy and on background renewals. Every other path restores the environment's last issued certificate from its backup bucket. A first issuance that doesn't land quickly leaves the deploy finished with "TLS pending" instead of failed.

**Architecture:** One operator-side module, `src/lib/deploy/tls-snapshot.js`, owns the key layout, validation and S3 get/put of certificate snapshots.
- **Writes.** Servers write snapshots themselves: nightly, beside the wal-g base backup, and once right after a deploy's TLS turns trusted. The write uses `wal-g st put` inside the db container. The db container already holds the bucket credentials, so key material never transits the operator for upload.
- **Reads.** The operator reads a snapshot back, validates it in Node (`node:crypto` `X509Certificate`), and ships it into place before Traefik or cert-manager would otherwise start issuance.
- **When issuance fails.** The deploy gates stop failing on an untrusted certificate. They record `envConfig.tls`. Retry happens in the background: through cert-manager on k8s, with a shorter minimum backoff, and through a small cron on compose, because Traefik never retries a failed first issuance on its own.

**Tech Stack:** Node 24 ESM CLI, `@aws-sdk/client-s3`, Traefik v3 (file-store ACME `acme.json`), cert-manager v1.20.2, WAL-G 3.0.9, vitest.

**Spec:** No standalone spec. The source is the approved recommendation in this session (2026-10-20), item 2: "Store issued certificates in the environment's backup bucket and restore them on redeploy, restore, standby and failover. Only the first deploy and background renewals then contact Let's Encrypt. Make the first issuance non-blocking: the deploy finishes with 'TLS pending', the client retries in the background, and `vibecarbon status` shows the state. Drop the fallback CA." Brandon approved it with "Go ahead". Rulings below are provisional against that text.

## Verified platform behaviour (context7, 2026-10-20)

These findings shaped the design. Implementers must not re-derive them.

1. **Traefik never retries a failed first issuance.** Traefik docs (`reference/install-configuration/tls/certificate-resolvers/acme.md`, "Fallback"): "For new (sub)domains which need Let's Encrypt authentication, the default Traefik certificate will be used until Traefik is restarted."
   - Renewal starts 30 days before expiry for 90-day certificates, checked daily, and applies only to certificates already in `acme.json`.
   - If the CA is unreachable, Traefik keeps serving previously generated, even expired, ACME certificates from `acme.json`.
   - **Consequences.** A restored `acme.json` is served immediately and renewed in the background. A failed first order needs an explicit Traefik restart to retry, which Task 4 adds. `acme.json` must be mode 600 (scale.js:796 already writes it that way).
2. **cert-manager re-issues for any one of these reasons:**
   - the Secret is missing or corrupt;
   - its key doesn't match;
   - **its issuer annotations (`cert-manager.io/issuer-name`, `issuer-kind`, `issuer-group`) don't match `Certificate.spec.issuerRef`**;
   - the DNS names differ;
   - renewal is due;
   - **a CertificateRequest for the current revision exists whose `status.certificate` differs from the Secret's.**

   With no CertificateRequest, the Certificate spec is compared against the Secret's X.509 data. That is the documented backup-and-restore case, and a match means no issuance.
   - **Consequences.** A restored Secret must carry ACME issuer annotations that equal the Certificate's issuerRef.
   - On a cluster that already has a self-signed CertificateRequest (the pilot standby being promoted), the Certificate must be deleted and recreated around the Secret restore. Deleting a Certificate leaves its Secret in place, and its CertificateRequests are garbage-collected by ownerRef.
3. **cert-manager's backoff after a terminal failure is 1h, 2h, 4h … 32h.** It is configurable via `--certificate-request-minimum-backoff-duration`, which is present in v1.20.2 (`internal/apis/config/controller/types.go:149` at tag `v1.20.2`, checked via `gh api`).
   - The maximum-backoff flag arrived in v1.21 and is not available.
   - Ephemeral failures, meaning network errors including a CA 5xx, re-sync within 5 minutes on their own.

## Global Constraints

- **Never print key material.** No `acme.json`, `tls.key`, `tls.crt` or Secret JSON in any log, spinner, error message, perf marker or `~/.vibecarbon/logs` tee.
  - Temp files are created with `mkdtempSync` and mode `0o600` and removed in `finally`.
  - On the server, scripts run under `umask 077` and `rm -f` their temp copies on exit with `trap`.
- **No extra encryption layer.** Ruling: the backup bucket already holds unencrypted wal-g base backups, which are strictly more sensitive, under the same credential. Encrypting certificates with an env secret would add a key-loss failure mode (a redeploy after `.env` loss can't decrypt) and no confidentiality against that credential. Cost if wrong: add libsodium for wal-g and certificates together later.
- **Snapshot key layout, one function, used everywhere:**
  - `tls/<projectName>/<envName>/<ca>/<format>.json`;
  - `<ca>` is `prod` or `staging`;
  - `<format>` is `compose-acme` (raw Traefik `acme.json`) or `k8s-secret` (the `kubectl get secret vibecarbon-tls -o json` document).
  - This lives outside the wal-g prefix, so `wal-g delete garbage` can never touch it.
- **Restore is best-effort and never fails a deploy, failover or scale.** A missing bucket, missing credentials, S3 error, missing object or failed validation each produce at most one `p.log.info` line naming the reason, and then the path continues to fresh issuance.
- **Restore never overwrites a better live certificate.** It writes only when the live certificate is absent, unparsable, self-signed or standby-issued, doesn't cover the required names, has less than `MIN_REMAINING_VALIDITY_MS` left, or expires before the snapshot's.
- **`MIN_REMAINING_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000`.**
- **Server-side snapshot writes never overwrite a good snapshot with a worse one.** The guards are:
  - only a node whose `WALG_ROLE` is not `standby` writes;
  - compose writes only when `acme.json` holds a certificate whose `"main"` is the apex domain;
  - k8s writes only when the Secret's `cert-manager.io/issuer-name` is not `vibecarbon-standby-selfsigned`.
- **The snapshot prefix travels to the server as data**, as the full S3 URL `s3://<backupBucket>/tls/<project>/<env>/<ca>`:
  - compose: `.env` key `TLS_SNAPSHOT_S3_PREFIX`, written only through `formatDotenvLine`;
  - k8s: `vibecarbon-config` ConfigMap key `TLS_SNAPSHOT_S3_PREFIX`.

  Scripts never derive it.
- **Cross-plan dependency.** If `docs/superpowers/plans/2026-10-20-project-app-bucket.md` lands first:
  - the backup bucket comes from its `resolveEnvStorage(...).backupBucket`, otherwise from `resolveEnvBucketNames(...).backupBucketName` (src/lib/deploy/prompts.js:494);
  - its per-env `-purge` must also delete `tls/<project>/<env>/`, so add that prefix to its purge list.
- **First-look budgets:**
  - `TLS_FIRST_LOOK_BUDGET_MS = 180_000` for managed DNS. The DNS-01 settle floor puts healthy issuance at about 120 s (2026-10-20 trials: wildcard 119 s, apex 124 s).
  - Manual DNS keeps `TLS_READY_MANUAL_BUDGET_MS = 60_000`.
- **Compose TLS retry cadence is every 30 minutes.** Ruling: Let's Encrypt's failed-validation limit is 5 per account, per hostname, per hour. Every restart issues the apex order and the wildcard order, so 2 restarts per hour stay at 4. This is issuance scheduling for an external outage, not a retry ladder around our own bug: Traefik has no retry of its own (finding 1).
- **No second CA.** No Supabase vocabulary. Conventional commits, pathspec commits, never `--no-verify`, no `!:` footers. Ship with a Compatibility note.
- **Shell embedded in YAML or `bash -c '…'` wrappers carries no apostrophes**, comments included (tests/unit/template/embedded-shell-syntax.test.ts).

## Review Focus

1. **A snapshot from the other CA** (a staging certificate restored into a prod deploy, or the reverse) must be skipped, never served. Pinned by Task 1's CA tests and the key layout.
2. **The domain or challenge type changed since the snapshot** (the apex changed, or a manual HTTP-01 apex-only certificate meets a DNS-01 wildcard Certificate). It must be skipped, because otherwise cert-manager re-issues anyway and compose would serve the wrong names. Pinned by Task 1's name-coverage tests.
3. **An expired or nearly expired snapshot**, for example a restore 80 days after the last nightly run, must be skipped in favour of fresh issuance. Pinned by Task 1's validity tests.
4. **A standby's self-signed Secret, or a disarmed node's empty `acme.json`, overwriting the good snapshot** in the nightly job. Pinned by Task 2's guard tests.
5. **Key material in logs.** A restore driven with a real-looking fixture must leave no `BEGIN`, `PRIVATE KEY` or base64 key substring in anything written to `p.log`, `console` or `progressLog`. Pinned by Task 3's leak test, with Task 6 and Task 7 reusing the helper.

---

### Task 1: The snapshot module

**Files:**
- Create: `src/lib/deploy/tls-snapshot.js`
- Test: `tests/unit/deploy/tls-snapshot.test.ts`, `tests/unit/deploy/_tls-fixtures.ts`. The fixture helper generates certificates at runtime with `openssl req -x509` into a mkdtemp directory. Never commit a PEM private key: hook secret scans would flag it.

**Interfaces:**
- Produces, all exported:
  - `MIN_REMAINING_VALIDITY_MS: number`;
  - `caSlug(acmeServerOrIssuerName: string): 'prod'|'staging'`: `'staging'` iff the input contains `staging`;
  - `tlsSnapshotKey({ projectName, envName, ca, format }): string`, where `format` is `'compose-acme'|'k8s-secret'`;
  - `tlsSnapshotS3Prefix({ backupBucket, projectName, envName, ca }): string`, returning `s3://<bucket>/tls/<project>/<env>/<ca>`;
  - `inspectComposeAcme(acmeJsonText: string, { domain, ca, now? }): { ok: true, notAfter: Date } | { ok: false, reason: string }`;
  - `inspectK8sTlsSecret(secretJsonText: string, { dnsNames: string[], now? }): { ok: true, notAfter: Date, issuerName: string } | { ok: false, reason: string }`;
  - `buildRestoredTlsSecret(secretJsonText: string, { namespace: 'vibecarbon', issuerName: string }): object`, a manifest ready for `kubectl apply -f -`;
  - `isSnapshotBetter(liveVerdict, storedVerdict): boolean`;
  - `readTlsSnapshot(s3Config, key): Promise<string|null>`, which is `null` on NoSuchKey or any S3 error; it logs the error class only;
  - `writeTlsSnapshot(s3Config, key, body): Promise<boolean>`.
  - `s3Config` has the same `{ region, endpoint, bucket, accessKey, secretKey }` shape as `src/lib/backup-s3.js`. Reuse its client construction by exporting `getS3Client` from there; don't create a second one.

- [ ] **Step 1: Write the failing tests.** Each assertion below is its own `it`.
  - `caSlug('https://acme-staging-v02.api.letsencrypt.org/directory') === 'staging'`, `caSlug('letsencrypt-prod-hetzner') === 'prod'`, and `caSlug('') === 'prod'`.
  - `tlsSnapshotKey({projectName:'myapp', envName:'prod', ca:'staging', format:'k8s-secret'}) === 'tls/myapp/prod/staging/k8s-secret.json'`.
  - `inspectComposeAcme`, where the fixture `acme.json` is `{"letsencrypt":{"Account":{"Registration":{"uri":"https://acme-staging-v02.api.letsencrypt.org/acme/acct/1"}},"Certificates":[{"domain":{"main":"app.example.com"},"certificate":"<base64 PEM>","key":"<base64 PEM>"}]}}`:
    - it returns `ok:true` with the fixture's `notAfter` for `ca:'staging'`;
    - it returns `ok:false` with reason containing `CA` for `ca:'prod'`;
    - it returns `ok:false` with reason containing `app.example.com` when no `main` matches;
    - it returns `ok:false` for a certificate with 3 days left;
    - it returns `ok:false` for unparsable JSON. The reason must not contain the input text.
  - `inspectK8sTlsSecret`:
    - a certificate whose SANs are `[app.example.com, *.app.example.com]` passes for `dnsNames` equal to the same pair;
    - it fails for `['app.example.com', '*.app.example.com', 'x.example.com']`;
    - it fails when `metadata.annotations['cert-manager.io/issuer-name'] === 'vibecarbon-standby-selfsigned'`;
    - it fails when `tls.key` is missing.
  - `buildRestoredTlsSecret`:
    - the output has `type: 'kubernetes.io/tls'` and `metadata.name: 'vibecarbon-tls'`;
    - it has annotations `cert-manager.io/issuer-name: <issuerName>`, `cert-manager.io/issuer-kind: 'ClusterIssuer'`, `cert-manager.io/issuer-group: 'cert-manager.io'` and `cert-manager.io/certificate-name: 'vibecarbon-tls'`;
    - it has no `resourceVersion`, `uid`, `creationTimestamp`, `managedFields` or `ownerReferences`.
  - `isSnapshotBetter`:
    - live `{ok:false}` with stored `{ok:true}` gives `true`;
    - both ok, with stored `notAfter` later, gives `true`;
    - both ok, with live later, gives `false`;
    - stored `{ok:false}` gives `false`.
  - `readTlsSnapshot`, with the S3 client mocked via `vi.mock('@aws-sdk/client-s3')`, returns `null` on a `NoSuchKey` error, and `null` plus no throw on an `AccessDenied` error.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/tls-snapshot.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Parse PEMs with `new X509Certificate(pem)`, using `validTo` and `subjectAltName`. Compose base64 fields are base64 of PEM text. Name coverage means the set of the certificate's SAN DNS names equals the required set exactly, with no superset and no subset.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(deploy): tls certificate snapshot keys, validation and storage`.

### Task 2: Server-side snapshot writes, nightly and on demand

**Files:**
- Create:
  - `carbon/backup/tls-snapshot.sh`: compose. It runs from the project dir, like compose-backup.sh.
- Modify:
  - `carbon/backup/compose-backup.sh`: call `bash backup/tls-snapshot.sh || echo "tls snapshot skipped"` after the wal-g block. The script's own failure must never fail the backup.
  - `carbon/k8s/base/backup/cronjob.yaml`: add a second step after wal-g, in the same container.
  - `carbon/k8s/base/backup/rbac.yaml`: `secrets` `get` with `resourceNames: ["vibecarbon-tls"]` only.
  - `carbon/k8s/base/config/configmap.yaml`: key `TLS_SNAPSHOT_S3_PREFIX: ""`, patched at deploy.
  - `src/lib/deploy/bundle.js`: write the `.env` key.
  - `src/lib/deploy/k8s/k3s.js`: the configmap patch beside `SITE_URL`, around line 3704.
  - `src/create.js` / `src/lib/upgrade-policy.js`, if they enumerate `backup/` files.
- Test:
  - `tests/unit/template/tls-snapshot-script.test.ts`;
  - extend `tests/unit/template/embedded-shell-syntax.test.ts` coverage, which should pick up the cronjob automatically, so verify that.

**Interfaces:**
- Consumes `tlsSnapshotS3Prefix` (Task 1) to compute the value written at deploy.
- Produces the server-side invariant: an object at `<TLS_SNAPSHOT_S3_PREFIX>/compose-acme.json` or `<…>/k8s-secret.json`, uploaded uncompressed and unencrypted, so `readTlsSnapshot` can `GetObject` it as-is.

- [ ] **Step 1: Verify the wal-g flags first.**
  - Run `docker run --rm --entrypoint wal-g ghcr.io/hyperformant/postgres:<DB_IMAGE_TAG from src/lib/images.js> st put --help`. Expected: `--no-compress` and `--no-encrypt` are listed.
  - Also confirm that `st put` writes relative to `WALG_S3_PREFIX`.
  - If either is false: Ruling, fall back to doing only the operator-side snapshot points in Task 3 and drop the nightly path. Record it in the ledger and skip Steps 2–5.
- [ ] **Step 2: Write the failing tests.** They render and inspect the script text, and execute the compose script with `docker` and `wal-g` stubbed by PATH-shim scripts in a temp dir that record their argv.
  - With `.env` `WALG_ROLE=standby`, no `wal-g st put` is invoked, and the exit code is 0.
  - With an `acme.json` lacking `"main": "app.example.com"`, nothing is uploaded and the exit code is 0.
  - With a matching `acme.json`, exactly one invocation is `WALG_S3_PREFIX=<TLS_SNAPSHOT_S3_PREFIX> wal-g st put --no-compress --no-encrypt <tmp> compose-acme.json`, and the temp file no longer exists afterwards.
  - With `TLS_SNAPSHOT_S3_PREFIX` empty, the script skips with exit 0.
  - The script contains `umask 077` and a `trap` that removes its temp file.
  - The cronjob's second step:
    - contains `kubectl get secret vibecarbon-tls`;
    - gates on the issuer-name annotation not equal to `vibecarbon-standby-selfsigned`;
    - pipes into `kubectl exec -i … -- bash -c` running the same `st put` with `k8s-secret.json`;
    - never `echo`es the Secret.
- [ ] **Step 3:** Run `pnpm vitest run tests/unit/template/tls-snapshot-script.test.ts tests/unit/template/embedded-shell-syntax.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - The compose script copies the file out with `docker compose cp traefik:/letsencrypt/acme.json "$TMP"`, then `docker compose cp "$TMP" db:/tmp/acme-snapshot.json`, then runs `st put` via `docker compose exec -T db`, then removes both copies.
  - The k8s step streams over stdin, with no file on the CronJob pod.
- [ ] **Step 5:** Run the tests. Expected: PASS. Commit: `feat(backup): nightly tls certificate snapshot beside the base backup`.

### Task 3: Compose and compose-ha deploy restore and snapshot steps

**Files:**
- Modify:
  - `src/lib/deploy/plan/steps.js`: `restoreTlsStep()` and `snapshotTlsStep()`;
  - `src/lib/deploy/plan/deploy-plan.js`;
  - `src/lib/deploy/effects/index.js`: effects `restoreTlsSnapshot` and `snapshotTls`;
  - the compose-ha effects file `src/lib/deploy/effects/compose-ha.js`: primary only.
- Create:
  - `src/lib/deploy/compose/tls-restore.js`;
  - `tests/unit/deploy/compose-tls-restore.test.ts`;
  - `tests/unit/deploy/plan/tls-step-order-census.test.ts`;
  - `tests/unit/deploy/_no-key-leak.ts`, a shared spy helper.
- Modify: the deploy-plan snapshot tests, updated for the new steps.

**Interfaces:**
- Consumes Task 1's `readTlsSnapshot`, `inspectComposeAcme`, `isSnapshotBetter` and `tlsSnapshotKey`, plus `scpUpload` and `sshRunScript` (src/lib/ssh.js).
- Produces:
  - `restoreComposeTls({ ip, sshKeyPath, projectName, domain, envName, ca, s3Config, deps? }): Promise<{ restored: boolean, reason: string }>`. Task 5 reuses it.
  - `snapshotComposeTlsNow({ ip, sshKeyPath, projectName }): Promise<void>`, which runs `bash backup/tls-snapshot.sh` remotely and is best-effort.
  - Step names `restore-tls` and `snapshot-tls`.

- [ ] **Step 1: Write the failing census test.**
  - For tiers `compose` and `compose-ha` from `planDeploy`, the index of `restore-tls` is less than the index of `start-compose-stack`, and the index of `snapshot-tls` is greater than the index of `verify-tls`.
  - The census walks every tier `planDeploy` accepts whose list includes `start-compose-stack`, so a future compose tier is drafted automatically.
  - It also asserts both step names appear exactly once.
- [ ] **Step 2: Write the failing behavioural tests** for `restoreComposeTls`, with injected `deps` for `read`, `ssh` and `scp`.
  - When the live `acme.json` check reports the apex is present (remote script exit 0 from `grep -Eq '"main": ?"<domain>"'`), there is no read, no scp, and the result is `restored:false`, `reason:'live certificate present'`.
  - When the live certificate is absent and the snapshot is valid:
    - one scp goes to `/opt/<project>/.tls-restore/acme.json`;
    - one remote script contains `docker compose` `run --rm --no-deps`, mounts that file `:ro` and runs `chmod 600 /letsencrypt/acme.json`;
    - the temp file is removed;
    - the result is `restored:true`.
  - When the traefik container is running, the remote script also runs `docker compose restart traefik` after the write.
  - When the snapshot is absent, invalid or for the wrong CA, nothing is written, and the result is `restored:false` with the reason from `inspectComposeAcme`.
  - With `s3Config` null, the result is `restored:false`, `reason:'no backup bucket'`.
  - The compose `-f` set comes from the same helper `startComposeStack` uses. Assert that `docker-compose.prod.yml` and the dns01 override (when present) are in the command.
  - **No-leak test:** run a full restore with a real fixture through `_no-key-leak.ts`, which spies on `p.log.*`, `console.*` and `progressLog`. No captured string contains `BEGIN`, `PRIVATE KEY` or the fixture's base64 key.
- [ ] **Step 3:** Run `pnpm vitest run tests/unit/deploy/compose-tls-restore.test.ts tests/unit/deploy/plan/`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Effect `restoreTlsSnapshot` resolves `s3Config` from the deploy ctx's backup S3 config and `ca` from `caSlug(ACME_CA_SERVER)`, read the way tls-ready.js reads it. It never throws.
  - Effect `snapshotTls` runs only when `ctx.tlsTrusted === true` (set by Task 4).
  - The compose-ha effects call both on the primary only.
- [ ] **Step 5:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(deploy): compose restores the last issued certificate before traefik starts`.

### Task 4: Compose non-blocking first issuance and the Traefik retry cron

**Files:**
- Modify:
  - `src/lib/deploy/tls-ready.js`: `TLS_FIRST_LOOK_BUDGET_MS`. Replace `assertTlsReadyOrDegraded` with `tlsVerdict(...)`, which never throws.
  - `src/lib/deploy/effects/index.js`: `verifyTlsReady`.
  - `src/lib/deploy/compose/ha.js:1779-1800`: the failover gate, which keeps its warning.
  - `src/lib/deploy/compose/index.js`: `setupComposeBackupCron`, which installs the retry line too.
  - wherever the compose and compose-ha finalize persist the env entry, which stores `tls`.
- Create:
  - `carbon/backup/tls-retry.sh`.
- Test:
  - `tests/unit/deploy/tls-ready.test.ts`, updated: the abort tests become verdict tests;
  - `tests/unit/template/tls-retry-script.test.ts`;
  - `tests/unit/deploy/compose-backup-cron.test.ts`, or the existing cron test file, extended.

**Interfaces:**
- Consumes `waitForTrustedTls` and `probeTlsTrustOnce` (existing).
- Produces:
  - `tlsVerdict({ trusted, managedDns, reason, served }): { state: 'trusted'|'pending', reason?: string }`;
  - `ctx.tlsTrusted: boolean`;
  - the persisted `envConfig.tls = { state: 'trusted'|'pending', checkedAt: ISO string, reason?: string }`. Task 8 reads it.

- [ ] **Step 1: Write the failing tests.**
  - `tlsVerdict({trusted:false, managedDns:true, reason:'x'})` returns `{state:'pending', reason:'x'}` and does not throw.
  - `tlsVerdict({trusted:true})` returns `{state:'trusted'}`.
  - `verifyTlsReady`, with an untrusted probe and managed DNS:
    - it calls `waitForTrustedTls` with `budgetMs: TLS_FIRST_LOOK_BUDGET_MS`;
    - it emits one `p.log.warn` containing `TLS pending`, the reason and `vibecarbon status`;
    - it sets `ctx.tlsTrusted=false` and `ctx.tlsState.state==='pending'`;
    - it does not call `process.exit` or throw.
  - The retry script:
    - when `acme.json` contains the apex `main`, it exits 0 without `docker compose restart`;
    - otherwise it runs exactly one `docker compose restart traefik`;
    - when `.env` has a non-empty `ACME_DISARMED_CA_SERVER`, it exits 0 without restarting;
    - when the per-host counter file `/opt/<p>/backups/tls-retry.count` reaches 48, it stops restarting and logs `giving up`. The counter resets when the certificate is present.
  - `setupComposeBackupCron` installs one line `*/30 * * * * cd <remoteDir> && bash backup/tls-retry.sh >> <remoteDir>/backups/tls-retry.log 2>&1`, idempotently: re-running it doesn't duplicate the line, the same grep-v pattern as the backup line.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/tls-ready.test.ts tests/unit/template/tls-retry-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the Traefik log-tail fetch, but put it into the pending warning instead of an abort. Update the tls-ready.js header comment: the rule is now "a deploy reports its TLS state; it does not wait out a CA".
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(deploy): compose finishes with TLS pending instead of failing on a slow CA`.

### Task 5: Compose-ha failover and compose scale reuse the certificate

**Files:**
- Modify:
  - `src/lib/deploy/acme-role.js`: `armComposeAcme` calls `restoreComposeTls` before running `composeTraefikRecreateShell`.
  - `src/lib/deploy/compose/ha.js`: pass `s3Config`, `domain`, `envName` and `ca` through to `armComposeAcme`.
  - `src/scale.js:786-798`: call `restoreComposeTls` before the new server's compose up. Run the `acme.json` wipe only when the restore returned `restored:false`.
- Test:
  - `tests/unit/deploy/compose-ha-acme-role.test.ts`, extended;
  - `tests/unit/scale/compose-scale-tls-restore.test.ts`.

**Interfaces:** consumes `restoreComposeTls` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - `armComposeAcme`, with deps recording the call order: the restore runs before the recreate script.
  - A restore that throws still leads to the recreate, so a DR path never throws over certificates.
  - Scale, HTTP-01, with the restore returning `restored:true`: no `echo "{}" > /letsencrypt/acme.json` is sent.
  - Scale, HTTP-01, with `restored:false`: the wipe is sent exactly as today.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(failover): compose-ha promotion and scale serve the existing certificate`.

### Task 6: k8s deploy: no placeholder window, Secret restore, shorter backoff, non-blocking probe

**Files:**
- Modify:
  - `src/lib/deploy/k8s/k3s.js`:
    - `renderK8sBase` writes `traefik/certificate.yaml` with the real `dnsNames` and `effectiveIssuer`;
    - the restore runs before `apply -k base` (around line 3446);
    - the cert-manager controller args are patched after the install near line 3006;
    - the 3683–3702 patch stays as an idempotent no-op.
  - `src/lib/deploy/orchestrator.js:1290-1345`: split the probe into an app phase and a TLS phase.
- Create:
  - `src/lib/deploy/k8s/tls-restore.js`;
  - `tests/unit/deploy/k8s-tls-restore.test.ts`;
  - `tests/unit/deploy/k8s-certificate-render.test.ts`;
  - `tests/unit/deploy/cert-manager-backoff.test.ts`.

**Interfaces:**
- Consumes Task 1.
- Produces:
  - `renderTlsCertificateManifest({ domain, dnsNames, issuerName, effectiveIssuer }): string`, as YAML;
  - `restoreK8sTlsSecret({ env, s3Config, projectName, envName, ca, issuerName, dnsNames, runKubectl }): Promise<{ restored: boolean, reason: string }>`;
  - `CERT_MANAGER_MIN_BACKOFF = '5m'`.
  - Task 7 reuses `restoreK8sTlsSecret`'s pieces.

- [ ] **Step 1: Write the failing tests.**
  - `renderTlsCertificateManifest` output parsed with `yaml` has:
    - `spec.dnsNames` deep-equal to the input;
    - `spec.issuerRef.name === effectiveIssuer`;
    - `metadata.annotations['vibecarbon.dev/promote-issuer'] === issuerName`;
    - no `app.example.com`.
  - `renderK8sBase`'s rendered tree contains that file. The census asserts that no rendered file in the base tree still contains `app.example.com`.
  - `restoreK8sTlsSecret`, with `runKubectl` recording argv and input:
    - with the live Secret valid and better, there is no S3 read, no apply, and `restored:false`;
    - with the live Secret absent and the snapshot valid, there is exactly one `apply -f -` whose `input` is the `buildRestoredTlsSecret` JSON, `argv` contains no certificate data, and the result is `restored:true`;
    - with the snapshot for a different `dnsNames`, there is no apply;
    - on a pilot standby (`pilotStandby:true`), the function isn't called. Assert at the `applyK3sManifests` call site via the existing k3s test harness: restore precedes `apply -k <baseDir>` for primary and single-cluster, and is absent for a standby.
  - The cert-manager args patch is one `kubectl -n cert-manager patch deployment cert-manager --type=json`, adding `--certificate-request-minimum-backoff-duration=5m` to `spec.template.spec.containers[0].args`. It is idempotent: when the arg is already present, no patch runs.
  - Orchestrator probe:
    - an app phase with TLS verification off, pinned SNI, still public DNS, budget unchanged at 1,200,000 ms, failure still hard;
    - then a TLS phase running `probePublicHealth` with verification and the ACME watchdog, budget `TLS_FIRST_LOOK_BUDGET_MS`;
    - TLS-phase failure or a watchdog `abort` gives `tls.state='pending'` with the watchdog reason, a `TLS pending` warning, and exit 0;
    - the no-leak helper wraps a restore run.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-tls-restore.test.ts tests/unit/deploy/k8s-certificate-render.test.ts tests/unit/deploy/cert-manager-backoff.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The live Secret is read with `kubectl get secret vibecarbon-tls -n vibecarbon -o json`, run silently; NotFound gives live `{ok:false}`. The orchestrator persists `envConfig.tls` in the k8s finalize, the same shape as Task 4.
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(k8s): restore the issued certificate and stop waiting out the CA`.

### Task 7: k8s-ha promotion serves the primary's certificate

**Files:**
- Modify: `src/failover.js:460-502` (`promoteAcmeIssuer`) and its caller around line 1391, which passes `s3Config`, `projectName`, `envName`, `ca` and `domain`.
- Test: `tests/unit/failover/promote-acme-issuer.test.ts`, extending or creating it.

**Interfaces:** consumes `readTlsSnapshot`, `inspectK8sTlsSecret`, `buildRestoredTlsSecret` and `renderTlsCertificateManifest`.

- [ ] **Step 1: Write the failing tests** with an injected `kubectl` recorder.
  - **Valid snapshot for `vibecarbon-tls`.** The calls, in order:
    1. `delete certificate vibecarbon-tls -n vibecarbon --ignore-not-found`;
    2. `apply -f -` with the restored Secret, using annotation issuer equal to the promote annotation's target;
    3. `apply -f -` of the Certificate rendered with `effectiveIssuer = target`.
    No `patch certificate` call is made for `vibecarbon-tls`.
  - **No or invalid snapshot.** Today's patch behaviour, byte-identical argv.
  - **`grafana-tls`.** Always today's patch path; snapshots are out of scope for it.
  - **Any throw in the snapshot path.** It falls back to the patch path and warns once. It never throws, since a DR path never throws over certificates.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(failover): k8s-ha promotion restores the primary certificate instead of re-issuing`.

### Task 8: `vibecarbon status` TLS row and e2e proof of reuse

**Files:**
- Modify:
  - `src/status.js`: a `checkTls(domain)` that wraps `probeTlsTrustOnce`, with `formatTlsLines` rendered after Health.
  - `tests/e2e/checks/health.ts`: `checkSslValid` budget.
  - `tests/e2e/scenarios/_run-lifecycle.ts`: record and compare serials.
  - `docs/deploy-hetzner.md` and the compose deploy doc: one short "Certificates" paragraph each.
- Create:
  - `tests/e2e/checks/tls-reuse.ts`;
  - `tests/unit/e2e/tls-reuse-check.test.ts`;
  - `tests/unit/status/tls-row.test.ts`.

**Interfaces:**
- Consumes `envConfig.tls` (Tasks 4 and 6) and `probeTlsTrustOnce`.
- Produces:
  - e2e check `tls_reused`;
  - `checkTlsReused(previousSerial: string, domain: string): VerificationResult`.

- [ ] **Step 1: Write the failing tests.**
  - The status row:
    - trusted renders `● trusted  expires <YYYY-MM-DD>`;
    - untrusted with `envConfig.tls.state==='pending'` renders `● pending` plus the stored reason and the hint `issuance retries in the background`;
    - untrusted and not pending renders `● untrusted` plus the reason.
    - `probeTlsTrustOnce` must also return `validTo` on a trusted handshake: extend it, keeping the existing tests green.
  - `checkTlsReused`: the same serial passes; a different serial fails, with a message naming both serials and `re-issued instead of reused`.
  - The lifecycle:
    - records the served serial at verify-deploy;
    - asserts `tls_reused` at verify-restore (after destroy and re-deploy) and at verify-failover, the promoted node or cluster;
    - on k8s and k8s-ha, the warm-change step also asserts that `kubectl get certificaterequest -n vibecarbon` gained no item.
    - `checkSslValid` uses 32 × 15 s (480 s) when the CLI's project config shows `tls.state==='pending'` after deploy, else today's 12 × 15 s.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/status/tls-row.test.ts tests/unit/e2e/tls-reuse-check.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test:unit`. Expected: PASS. Commit: `feat(status): show TLS state, and e2e proves certificates are reused`.

## Verification

- Every task: the named tests, plus `pnpm test:unit`, green.
- End of branch:
  - `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`;
  - carbon `npm run test:prepush`;
  - `test.yml` green.
- Real infra is Brandon's call, because it costs money. It is one `hetzner/compose` scenario plus one `hetzner/k8s-ha` scenario. Acceptance:
  - `tls_reused` passes at verify-restore and at verify-failover;
  - the k8s-ha failover log shows no `Order` created on the promoted cluster.

## Open risks (not blockers)

- **Lifetimes.** Let's Encrypt's default lifetime is still 90 days in 2026, and its announced move to shorter certificates makes the nightly snapshot necessary rather than nice. If the nightly path is dropped (Task 2 Step 1 fallback), snapshot freshness depends on CLI activity, and a long-idle environment's restore falls back to fresh issuance.
- **A hidden reissue on every k8s redeploy.** Today `apply -k base` resets `vibecarbon-tls` to the `app.example.com` placeholder, and the patch then follows. That may already trigger a CertificateRequest on every warm k8s redeploy: unverified, and a candidate cause of past "re-issuance on redeploy" noise. Task 6's render removes the window, and Task 8's CertificateRequest-count assertion proves it either way.
- **Failover when the backup bucket's region is down too.** Restore degrades to today's behaviour: fresh issuance, now pending instead of failing.
