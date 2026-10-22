# TLS Certificate Reuse and Non-Blocking First Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let's Encrypt only matters on a domain's first-ever deploy and on background renewals. Every other path restores the environment's last issued certificate from its backup bucket. A first issuance that doesn't land quickly leaves the deploy finished with "TLS pending" instead of failed.

**Architecture:** One operator-side module, `src/lib/deploy/tls-snapshot.js`, owns the key layout, validation and S3 get/put of certificate snapshots.
- **Writes.** Servers write snapshots themselves: on every scheduled backup run, beside the wal-g base backup, and (compose) once right after a deploy's TLS turns trusted. The write is `wal-g st put -s -f --no-compress --no-encrypt` inside the db container, fed on stdin. The db container already holds the bucket credentials, so on compose key material never transits the operator for upload. The k8s post-deploy snapshot is the one operator-side write (Task 6, decision D7).
- **Reads.** The operator reads a snapshot back, validates it in Node (`node:crypto` `X509Certificate`), and ships it into place before Traefik or cert-manager would otherwise start issuance.
- **When issuance fails.** The deploy gates stop failing on an untrusted certificate. They record `envConfig.tls`. Retry happens in the background: through cert-manager on k8s, with a shorter minimum backoff, and through a small cron on compose, because Traefik never retries a failed first issuance on its own.

**Tech Stack:** Node 24 ESM CLI, `@aws-sdk/client-s3` (through `createS3Client`, src/lib/walg/restore-base.js:81), Traefik v3.6.11 (file-store ACME `acme.json`), cert-manager v1.20.2 (k3s.js:1320), WAL-G 3.0.9 in `ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r2`, vitest.

**Spec:** No standalone spec. The source is the approved recommendation in this session (2026-10-20), item 2: "Store issued certificates in the environment's backup bucket and restore them on redeploy, restore, standby and failover. Only the first deploy and background renewals then contact Let's Encrypt. Make the first issuance non-blocking: the deploy finishes with 'TLS pending', the client retries in the background, and `vibecarbon status` shows the state. Drop the fallback CA." Brandon approved it with "Go ahead". Rulings below are provisional against that text.

## Refresh 2026-10-21

The plan was written before #234 (security), #235 (HA correctness), #236 (primary-only add-ons), #237 (backup/restore integrity) and #238 (k8s-ha registry copy) landed under this branch, and before the env-app-bucket work (`resolveEnvStorage`). Every task was re-checked against the tree at `43a1370`. What changed and why:

1. **Task order.** Old Task 4 (non-blocking verdict) is now Task 2, because old Task 3's `snapshotTls` effect consumed `ctx.tlsTrusted`, which old Task 4 produced. Old Task 2 (server-side writes) is now Task 3. Old Task 3 (compose restore steps) is now Task 4. Tasks 5 to 8 keep their numbers.
2. **Key layout moved under the environment's backup folder.** It is now `backups/<project>/<env>/tls/<ca>/<format>.json`, a sibling of the wal-g prefix `backups/<project>/<env>/walg` (`walgPrefixFor`, restore-base.js:76). The backup bucket is per project now (storage layout decided 2026-10-20), and `destroy -purge` already deletes `backups/<project>/<env>/` (destroy.js:1170). The old `tls/<project>/<env>/` would have survived `-purge`. Lineage folders live under `walg/`, so `tls/` never reads as a lineage. Decision D5.
3. **Cross-plan dependency resolved.** The env-app-bucket plan landed: the backup bucket is `resolveEnvStorage(...).backupBucket` (prompts.js:543), carried as `backupS3Config.bucket` in the orchestrator. The `-purge` addition is no longer needed (item 2).
4. **`getS3Client` no longer exists.** `src/lib/backup-s3.js` is now `formatBytes` only. The S3 client is `createS3Client(s3Config)` from src/lib/walg/restore-base.js:81. Credentials are the deploy's `s3Config.accessKey/secretKey`, with `bucket` set to the backup bucket, the same shape the orchestrator's lineage listing builds at orchestrator.js:2357-2373.
5. **wal-g flags verified (old Task 2 Step 1 is done).** Ran 2026-10-21 against `WALG_FILE_PREFIX` storage in the local `17.11-walg3.0.9-r2` image. `st put` has `--no-compress`, `--no-encrypt`, `-f/--force` and `-s/--read-stdin`. The stdin form is `wal-g st put -s [flags] <destination>`: a `-` argument creates an object literally named `-`. The object lands at `<prefix>/<destination>`. The plan now always passes `-f`, because overwriting is the intent and S3 storage may refuse an existing object without it. Streaming over stdin removes the temp copy inside the db container.
6. **Backup scripts gained a result-marker contract (#237).** `compose-backup.sh` and the CronJob print exactly one `BACKUP_RESULT=` line on stdout (src/lib/walg/backup-result.js). Exit 3 means "base pushed, retention failed", and on k8s the podFailurePolicy fails the Job on 3. The TLS step must print only to stderr, never print `BACKUP_RESULT`, never change the exit code, and run only after a normal run (rc 0, 3 or 75). A refusal (rc 1, which covers a retired node or the backup-prefix fence) also means no snapshot. `compose-backup.sh` is `set -e`, so its last `docker compose exec` must capture rc instead of exiting early.
7. **The k8s snapshot prefix rides in `vibecarbon-backup-settings`, not `vibecarbon-config`.** `vibecarbon-config` is Flux-reconciled from git, so a `TLS_SNAPSHOT_S3_PREFIX: ""` key there would be reset on every reconcile. `vibecarbon-backup-settings` is deploy-owned and per environment, rendered by `carbon/scripts/render-backup-settings.mjs` for both the CLI (k3s.js:4013) and `.github/workflows/deploy.yml` (lines 82-91). It is already read by the CronJob. The GitOps workflow needs a new `TLS_SNAPSHOT_S3_PREFIX` var, which `gitops-deploy.js:291` seeds.
8. **The compose snapshot prefix reaches the scripts through compose interpolation.** It is written to `.env` with `formatDotenvLine` (bundle.js:435-446) and declared on the `traefik` service as `TLS_SNAPSHOT_S3_PREFIX: ${TLS_SNAPSHOT_S3_PREFIX:-}` (docker-compose.prod.yml:170). Scripts read it with `docker compose exec -T traefik printenv TLS_SNAPSHOT_S3_PREFIX`, so no shell hand-parses `.env`. The traefik image (alpine) has `printenv`, `cat`, `cp` and `chmod` (checked 2026-10-21). Decision D1.
9. **Flux owns `traefik/certificate.yaml` today.** `vibecarbon-base` applies `./k8s/base` every 10 minutes, including the `app.example.com` placeholder Certificate. That resets the CLI's patch on GitOps environments. Task 6 renders the real Certificate and makes it deploy-owned, as the db StatefulSet, backup CronJob and local-registry already are: a `$patch: delete` in both `k8s/flux/clusters/*/vibecarbon.yaml`, plus `kustomize.toolkit.fluxcd.io/prune: disabled`. Decision D2. (Flux also resets `vibecarbon-config` `SITE_URL` to the placeholder. That is out of scope here and noted for the controller.)
10. **cert-manager backoff is merged into the existing test-and-set.** k3s.js step 1c (lines 3615-3666) already reads the controller args once and appends missing flags. `--certificate-request-minimum-backoff-duration=5m` joins that list, so there is no second patch.
11. **The per-deploy `vibecarbon-tls` patch becomes dead code** once `renderK8sBase` renders the Certificate (k3s.js:4256-4278). It is deleted, not kept as a no-op (no legacy compat). Decision D3. The `SITE_URL` patch and the grafana-tls pilot-standby patch stay.
12. **Line drift.** orchestrator k8s probe 1290-1345 → 1944-2000. compose/ha.js failover gate 1779-1800 → 2569-2586. k3s.js configmap patch 3704 → 4279-4290. `apply -k base` 3446 → 4006. cert-manager install 3006 → 3561. failover.js `promoteAcmeIssuer` 460-502 → 499-541, its call 1391 → 2246. scale.js wipe 786-798 → 672-683, now inside the journaled cutover's `recreate` step.
13. **The scale `acme.json` wipe sits inside the journaled cutover (#237).** `resumeComposeCutover` re-enters it without the in-memory restore result. The wipe now decides from a live check on the new server ("does acme.json hold the apex `main`?"), not from `restored:false`.
14. **The CA must not be guessed on DR paths.** The deploy persists `envConfig.tls.ca` (`prod`|`staging`), and compose failover and scale read it. With no record they skip the restore and do not fall back to the operator's shell. The server's Traefik uses its own `.env` `ACME_CA_SERVER`, which can differ from the operator's shell (Review Focus 1). Decision D6. k8s-ha promotion takes the CA from the promote annotation's issuer name, which the cluster carries.
15. **The final save is one place for every tier.** orchestrator.js:2395-2580 builds `nextEnv` from the on-disk env inside `updateProjectConfig` and runs `preserveSafetyFields`. `tls` is added there once (Task 2), from `deployResult.tls`. `tls` is not a safety field.
16. **Single compose has no `backupS3Config` in its ctx.** Only compose-ha's ctx carries it (orchestrator.js:1758). Task 4 adds it to `deployCtx` (orchestrator.js:1639) and drops the compose-ha duplicate.
17. **The retry cron got a DNS-01 doctrine guard.** It never restarts a Traefik younger than 15 minutes. A restart mid-order abandons an in-flight DNS-01 challenge, and a second order on the same `_acme-challenge` name meets cached answers: Vultr's negative and positive caching, DO's anycast lag (memories `vultr-dns-txt-zone-build`, `dns01-settle-floor-doctrine`). Nothing here touches `legoTuningEnv` or the settle floor.
18. **New repo rules picked up.** Messages pass `tests/unit/lib/copyable-command-census.test.ts`, so commands go in backticks or end the sentence. CLI copy has no em dashes. `runKubectlWithRetry` streams stdout to the tee'd terminal unless `captureStdout: true` (k3s.js:540-557), so every Secret read must pass it. New backup scripts ship through `upgrade` automatically (`backup/**` is safe, upgrade-policy.js:51), but `create.js:896` copies files by name, so each new script is added there.

## Verified platform behaviour (context7, 2026-10-20; wal-g re-checked 2026-10-21)

These findings shaped the design. Implementers must not re-derive them.

1. **Traefik never retries a failed first issuance.** Traefik docs (`reference/install-configuration/tls/certificate-resolvers/acme.md`, "Fallback"): "For new (sub)domains which need Let's Encrypt authentication, the default Traefik certificate will be used until Traefik is restarted."
   - Renewal starts 30 days before expiry for 90-day certificates, checked daily, and applies only to certificates already in `acme.json`.
   - If the CA is unreachable, Traefik keeps serving previously generated, even expired, ACME certificates from `acme.json`.
   - **Consequences.** A restored `acme.json` is served immediately and renewed in the background. A failed first order needs an explicit Traefik restart to retry, which Task 2 adds. `acme.json` must be mode 600.
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
   - A Certificate applied with placeholder names before the patch (today's `apply -k base`) is a spec mismatch, which is why Task 6 renders before it restores.
3. **cert-manager's backoff after a terminal failure is 1h, 2h, 4h … 32h.** It is configurable via `--certificate-request-minimum-backoff-duration`, which is present in v1.20.2 (`internal/apis/config/controller/types.go:149` at tag `v1.20.2`, checked via `gh api`).
   - The maximum-backoff flag arrived in v1.21 and is not available.
   - Ephemeral failures, meaning network errors including a CA 5xx, re-sync within 5 minutes on their own.
   - `acme-order-recovery.js`'s watchdog (clears `lastFailureTime` on a terminal Order) stays. The shorter backoff complements it after the deploy has returned.
4. **wal-g `st put` (2026-10-21, local image).** The form is `wal-g st put [-s] [-f] [--no-compress] [--no-encrypt] <local_path|(-s) > <destination>`. It writes `<WALG_*_PREFIX>/<destination>`. With `-s`, the only positional argument is the destination.

## Global Constraints

- **Never print key material.** No `acme.json`, `tls.key`, `tls.crt` or Secret JSON in any log, spinner, error message, perf marker or `~/.vibecarbon/logs` tee.
  - Operator temp files are created under `mkdtempSync` with mode `0o600` and removed in `finally`.
  - On the server, scripts run under `umask 077` and `rm -f` their temp copies on exit with `trap`.
  - Every `kubectl get secret` passes `captureStdout: true` (or goes through `sshKubectl`, which returns stdout without printing). Any error from a command that carried key material on stdin or stdout is reported by exit status and a fixed phrase, never by its `stderr`/`stdout`/`message`.
  - Key material goes on stdin (`input`), never on argv.
- **No extra encryption layer.** Ruling: the backup bucket already holds unencrypted wal-g base backups, which are strictly more sensitive, under the same credential. Encrypting certificates with an env secret would add a key-loss failure mode (a redeploy after `.env` loss can't decrypt) and no confidentiality against that credential. Cost if wrong: add libsodium for wal-g and certificates together later.
- **Snapshot key layout, one module, used everywhere:**
  - `backups/<projectName>/<envName>/tls/<ca>/<format>.json`;
  - `<envName>` is the environment as the operator names it (`operatorEnv` in k3s.js, never an HA stack name such as `prod-primary`);
  - `<ca>` is `prod` or `staging`;
  - `<format>` is `compose-acme` (raw Traefik `acme.json`) or `k8s-secret` (the `kubectl get secret vibecarbon-tls -o json` document).
  - It sits beside, never inside, the wal-g prefix `backups/<p>/<e>/walg`, so `wal-g delete` never touches it, and `destroy -purge` removes it with the environment's backups.
  - The bucket is the env's backup bucket (`backupS3Config.bucket`, from `resolveEnvStorage`). Nothing in this plan creates a bucket.
- **Restore is best-effort and never fails a deploy, failover or scale.** A missing bucket, missing credentials, S3 error, missing object or failed validation each produce at most one `p.log.info` line naming the reason, and then the path continues to fresh issuance. DR paths never prompt for credentials (`resolveS3Config({ skipPrompts: true })`).
- **Restore never overwrites a better live certificate.** It writes only when the live certificate is absent, unparsable, self-signed or standby-issued, doesn't cover the required names, has less than `MIN_REMAINING_VALIDITY_MS` left, or expires before the snapshot's.
- **`MIN_REMAINING_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000`.**
- **Server-side snapshot writes never overwrite a good snapshot with a worse one.** The guards are:
  - no write from a refused or failed backup run (rc 1), so a retired node or a fenced old primary never writes;
  - compose: no write when the db container's `WALG_ROLE` is `standby`, when `.vibecarbon-retired` exists, when `.env` has a non-empty `ACME_DISARMED_CA_SERVER` (read through the traefik container's resolved command, see Task 3), or when `acme.json` holds no certificate whose `"main"` is the apex domain;
  - k8s: no write when the Secret's `cert-manager.io/issuer-name` is `vibecarbon-standby-selfsigned` or `VIBECARBON_ROLE` is `retired`.
- **The snapshot prefix travels to the server as data**, as the full S3 URL `s3://<backupBucket>/backups/<project>/<env>/tls/<ca>`, built by `tlsSnapshotS3Prefix`:
  - compose: `.env` key `TLS_SNAPSHOT_S3_PREFIX`, written only through `formatDotenvLine` (bundle.js envOverrides), surfaced to scripts by compose interpolation on the `traefik` service;
  - k8s: the deploy-owned `vibecarbon-backup-settings` ConfigMap key `TLS_SNAPSHOT_S3_PREFIX`, rendered by `render-backup-settings.mjs` for both the CLI and the workflow.

  Scripts never derive it, and no shell parses `.env`.
- **Backup result-marker contract (#237) is untouched.** The TLS step prints to stderr only, never prints `BACKUP_RESULT`, and leaves the backup's exit code as it was.
- **First-look budgets:**
  - `TLS_FIRST_LOOK_BUDGET_MS = 180_000` for managed DNS. The DNS-01 settle floor puts healthy issuance at about 120 s (2026-10-20 trials: wildcard 119 s, apex 124 s). The floor itself (`legoTuningEnv`, `ACME_DNS_DELAY_BEFORE_CHECKS`) is not touched.
  - Manual DNS keeps `TLS_READY_MANUAL_BUDGET_MS = 60_000`.
  - `TLS_READY_BUDGET_MS` (480 s) is removed, not kept as an alias.
- **Compose TLS retry cadence is every 30 minutes, and never against a Traefik younger than 15 minutes.** Ruling: Let's Encrypt's failed-validation limit is 5 per account, per hostname, per hour. Every restart issues the apex order and the wildcard order, so 2 restarts per hour stay at 4. This is issuance scheduling for an external outage, not a retry ladder around our own bug: Traefik has no retry of its own (finding 1). The age guard keeps a restart from abandoning an in-flight DNS-01 order (Refresh item 17). It gives up after 48 restarts (24 h), which `status` shows as pending.
- **`.vibecarbon.json` only via `updateProjectConfig`**, in the orchestrator's final save, through `preserveSafetyFields` as it already does. Dotenv only via `formatDotenvLine`.
- **No second CA.** No Supabase vocabulary. Conventional commits, pathspec commits, never `--no-verify`, no `!:` footers. Ship with a Compatibility note. No legacy compat code.
- **Shell embedded in YAML or `bash -c '…'` wrappers carries no apostrophes**, comments included (tests/unit/template/embedded-shell-syntax.test.ts, which already walks `carbon/backup/*.sh` and `backup/cronjob.yaml`).
- **Operator-facing copy:** commands in backticks or ending the sentence (copyable-command census), no em dashes, lowercase informational hints.

## Review Focus

1. **A snapshot from the other CA** (a staging certificate restored into a prod deploy, or the reverse) must be skipped, never served. Pinned by Task 1's CA tests, the key layout, and Task 5's "no `tls.ca` record, no restore" test.
2. **The domain or challenge type changed since the snapshot** (the apex changed, or a manual HTTP-01 apex-only certificate meets a DNS-01 wildcard Certificate). It must be skipped, because otherwise cert-manager re-issues anyway and compose would serve the wrong names. Pinned by Task 1's name-coverage tests.
3. **An expired or nearly expired snapshot**, for example a restore 80 days after the last backup run, must be skipped in favour of fresh issuance. Pinned by Task 1's validity tests.
4. **A standby's self-signed Secret, a disarmed node's `acme.json`, or a fenced old primary overwriting the good snapshot** in the scheduled job. Pinned by Task 3's guard and rc tests.
5. **Key material in logs.** A restore driven with a real-looking fixture must leave no `BEGIN`, `PRIVATE KEY` or base64 key substring in anything written to `p.log`, `console`, `process.stdout`/`stderr` or `progressLog`. Pinned by Task 4's leak test, with Tasks 5, 6 and 7 reusing the helper.
6. **The backup marker contract.** A TLS step that prints `BACKUP_RESULT`, turns exit 3 into 0 (or the reverse), or runs after a refusal. Pinned by Task 3's marker tests.
7. **The retry cron fights an in-flight order.** Pinned by Task 2's Traefik-age test.
8. **Flux reverts the rendered Certificate.** Pinned by Task 6's Flux patch census.

---

### Task 1: The snapshot module

**Status:** still needed, reshaped (key layout, S3 client, read result shape).

**Files:**
- Create: `src/lib/deploy/tls-snapshot.js`
- Test: `tests/unit/deploy/tls-snapshot.test.ts`, `tests/unit/deploy/_tls-fixtures.ts`. The fixture helper generates certificates at runtime with `openssl req -x509` into a mkdtemp directory. Never commit a PEM private key: hook secret scans would flag it.

**Interfaces:**
- Produces, all exported:
  - `MIN_REMAINING_VALIDITY_MS: number`;
  - `caSlug(acmeServerOrIssuerName: string): 'prod'|'staging'`: `'staging'` iff the input contains `staging`;
  - `tlsSnapshotKey({ projectName, envName, ca, format }): string`, where `format` is `'compose-acme'|'k8s-secret'`, returning `backups/<p>/<e>/tls/<ca>/<format>.json`;
  - `tlsSnapshotS3Prefix({ backupBucket, projectName, envName, ca }): string`, returning `s3://<bucket>/backups/<p>/<e>/tls/<ca>`;
  - `inspectComposeAcme(acmeJsonText: string, { domain, ca, now? }): { ok: true, notAfter: Date } | { ok: false, reason: string }`;
  - `inspectK8sTlsSecret(secretJsonText: string, { dnsNames: string[], now? }): { ok: true, notAfter: Date, issuerName: string } | { ok: false, reason: string }`;
  - `buildRestoredTlsSecret(secretJsonText: string, { namespace: 'vibecarbon', issuerName: string }): object`, a manifest ready for `kubectl apply -f -`;
  - `isSnapshotBetter(liveVerdict, storedVerdict): boolean`;
  - `readTlsSnapshot(s3Config, key, deps?): Promise<{ text: string } | { text: null, reason: string }>`. The reason is `'no snapshot'` on NoSuchKey/404, otherwise `` `S3 ${err.name}` ``. It never throws and never logs; callers print the one info line.
  - `writeTlsSnapshot(s3Config, key, body, deps?): Promise<{ ok: true } | { ok: false, reason: string }>`, with the same never-throw and no-logging rules.
  - `s3Config` is `{ region, endpoint, bucket, accessKey, secretKey }` with `bucket` = the backup bucket. The client comes from `createS3Client` (src/lib/walg/restore-base.js:81), injectable as `deps.makeClient`.

- [ ] **Step 1: Write the failing tests.** Each assertion below is its own `it`.
  - `caSlug('https://acme-staging-v02.api.letsencrypt.org/directory') === 'staging'`, `caSlug('letsencrypt-prod-hetzner') === 'prod'`, and `caSlug('') === 'prod'`.
  - Key layout, and `-purge` coverage:

    ```ts
    it('keys the snapshot beside the wal-g prefix, inside the env folder -purge deletes', () => {
      const key = tlsSnapshotKey({ projectName: 'myapp', envName: 'prod', ca: 'staging', format: 'k8s-secret' });
      expect(key).toBe('backups/myapp/prod/tls/staging/k8s-secret.json');
      expect(key.startsWith(`${walgPrefixFor('myapp', 'prod').replace(/walg$/, '')}`)).toBe(true);
      expect(key.startsWith(walgPrefixFor('myapp', 'prod'))).toBe(false);
      expect(tlsSnapshotS3Prefix({ backupBucket: 'b', projectName: 'myapp', envName: 'prod', ca: 'prod' }))
        .toBe('s3://b/backups/myapp/prod/tls/prod');
    });
    ```
  - `inspectComposeAcme`, where the fixture `acme.json` is `{"letsencrypt":{"Account":{"Registration":{"uri":"https://acme-staging-v02.api.letsencrypt.org/acme/acct/1"}},"Certificates":[{"domain":{"main":"app.example.com"},"certificate":"<base64 PEM>","key":"<base64 PEM>"}]}}`:
    - it returns `ok:true` with the fixture's `notAfter` for `ca:'staging'`;
    - it returns `ok:false` with reason containing `CA` for `ca:'prod'`;
    - it returns `ok:false` with reason containing `app.example.com` when no `main` matches;
    - it returns `ok:false` for a certificate with 3 days left;
    - it returns `ok:false` for unparsable JSON. The reason must not contain the input text.
  - `inspectK8sTlsSecret`:
    - a certificate whose SANs are `[app.example.com, *.app.example.com]` passes for `dnsNames` equal to the same pair;
    - it fails for `['app.example.com', '*.app.example.com', 'x.example.com']`;
    - it fails when `metadata.annotations['cert-manager.io/issuer-name'] === 'vibecarbon-standby-selfsigned'` (import `STANDBY_SELFSIGNED_ISSUER` from `src/lib/deploy/k8s/acme-issuer-policy.js`, never restate the literal);
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
  - `readTlsSnapshot`, with `deps.makeClient` returning a stub whose `send` rejects:
    - a `NoSuchKey` error gives `{ text: null, reason: 'no snapshot' }`;
    - an `AccessDenied` error gives `{ text: null, reason: 'S3 AccessDenied' }` and no throw;
    - nothing is written to `console` (spy).
  - `writeTlsSnapshot` sends one `PutObjectCommand` whose `Key` is the given key and whose `Body` is the given text, and returns `{ ok: false, reason: 'S3 <name>' }` on a rejected send.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/tls-snapshot.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Parse PEMs with `new X509Certificate(pem)`, using `validTo` and `subjectAltName`. Compose base64 fields are base64 of PEM text. Name coverage means the set of the certificate's SAN DNS names equals the required set exactly, with no superset and no subset. The compose CA check reads `Account.Registration.uri`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(deploy): tls certificate snapshot keys, validation and storage`.

### Task 2: Compose non-blocking first issuance and the Traefik retry cron (was Task 4)

**Status:** still needed, reshaped (runs before the restore tasks; persists `tls.ca`; failover gate line and wording; Traefik-age guard; crontab grep pattern).

**Files:**
- Modify:
  - `src/lib/deploy/tls-ready.js`: `TLS_FIRST_LOOK_BUDGET_MS` replaces `TLS_READY_BUDGET_MS` as `waitForTrustedTls`'s default (line 40). `assertTlsReadyOrDegraded` (lines 180-205) is replaced by `tlsVerdict(...)`, which never throws. The header comment's rule becomes "a deploy reports its TLS state; it does not wait out a CA".
  - `src/lib/deploy/effects/index.js`: `verifyTlsReady` (lines 569-622) sets `ctx.tlsState` and never fails the deploy.
  - `src/lib/deploy/orchestrator.js`: the compose and compose-ha dispatch (lines 1722-1797) copy `ctx.tlsState` into `deployResult.tls`. The final save (`nextEnv`, around line 2395) writes `tls: deployResult.tls ?? persistedEnvConfig.tls` (dropped when both are absent).
  - `src/lib/deploy/compose/ha.js:2569-2586`: the failover gate uses `TLS_FIRST_LOOK_BUDGET_MS`, keeps its warning, and says the background retry is the tls-retry cron, not Traefik.
  - `src/lib/deploy/compose/index.js:1338-1363`: `setupComposeBackupCron` installs the retry line too, and its `grep -v` drops both `compose-backup.sh` and `tls-retry.sh` lines.
  - `src/create.js:896-897`: copy and `chmod 755` `backup/tls-retry.sh`.
- Create:
  - `carbon/backup/tls-retry.sh`.
- Test:
  - `tests/unit/deploy/tls-ready.test.ts`, updated: the abort tests become verdict tests, and the budget-constant test pins 180_000;
  - `tests/unit/template/tls-retry-script.test.ts`;
  - `tests/unit/deploy/compose-backup-cron.test.ts`, extended.

**Interfaces:**
- Consumes `waitForTrustedTls` and `probeTlsTrustOnce` (existing), and `caSlug` (Task 1).
- Produces:
  - `tlsVerdict({ trusted, managedDns, reason, served, traefikLogTail?, fixHint? }): { state: 'trusted'|'pending', reason?: string, detail?: string }`;
  - `ctx.tlsState: { state: 'trusted'|'pending', checkedAt: string, reason?: string, ca: 'prod'|'staging' }`, set by `verifyTlsReady` on every run, trusted or not. `ca` is `caSlug(readOperatorVar('ACME_CA_SERVER').value)`, the same value the bundle wrote into the server `.env`;
  - the persisted `envConfig.tls = { state, checkedAt, reason?, ca }`. Tasks 5, 6 and 8 read it.

- [ ] **Step 1: Write the failing tests.**
  - `tlsVerdict({trusted:false, managedDns:true, reason:'x'})` returns `{state:'pending', reason:'x', ...}` and does not throw.
  - `tlsVerdict({trusted:true})` returns `{state:'trusted'}`.
  - `verifyTlsReady`, with an untrusted probe and managed DNS:
    - it calls `waitForTrustedTls` with `budgetMs: TLS_FIRST_LOOK_BUDGET_MS`;
    - it emits one `p.log.warn` containing `TLS pending`, the reason and `` `vibecarbon status` ``;
    - it sets `ctx.tlsState.state==='pending'` and `ctx.tlsState.ca` from `ACME_CA_SERVER`;
    - it does not call `process.exit` or throw.
  - `verifyTlsReady` trusted: `ctx.tlsState.state==='trusted'`, no warn.
  - The final save: a compose deployResult with `tls` persists it, and a deployResult without `tls` keeps the on-disk `tls` (extend the orchestrator final-save test that already covers `preserveSafetyFields`, or add `tests/unit/deploy/final-save-tls.test.ts`).
  - The retry script, executed with `docker` stubbed by a PATH-shim that records argv and answers `ps`, `inspect` and `exec` from fixture files:

    ```ts
    it('never restarts a traefik younger than 15 minutes', () => {
      const run = runRetry({ acmeHasApex: false, traefikStartedSecondsAgo: 600 });
      expect(run.calls.filter((c) => c.includes('restart traefik'))).toHaveLength(0);
      expect(run.code).toBe(0);
    });
    ```
    - when `acme.json` contains the apex `main`, it exits 0 without `docker compose restart`, and resets the counter;
    - otherwise, with Traefik older than 15 minutes, it runs exactly one `docker compose restart traefik`;
    - when the running traefik command carries `acme-disarmed.invalid` (import `ACME_DISARMED_CA_SERVER` from acme-role.js in the test), it exits 0 without restarting;
    - when `.vibecarbon-retired` exists, it exits 0 without restarting;
    - when the per-host counter file `backups/tls-retry.count` reaches 48, it stops restarting and logs `giving up`;
    - the script reads `acme.json` with `grep -q` inside the traefik container and never `cat`s it to its own output.
  - `setupComposeBackupCron` installs one line `*/30 * * * * cd <remoteDir> && bash backup/tls-retry.sh >> <remoteDir>/backups/tls-retry.log 2>&1`, idempotently: re-running it doesn't duplicate either line.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/tls-ready.test.ts tests/unit/template/tls-retry-script.test.ts tests/unit/deploy/compose-backup-cron.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the Traefik log-tail fetch, but put it into the pending warning instead of an abort. The disarm check reads the running container's resolved command (`docker inspect -f '{{json .Config.Cmd}}'`), never `.env`. The age check reads `{{.State.StartedAt}}` and compares with `date -u +%s` (busybox-safe parsing).
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(deploy): compose finishes with TLS pending instead of failing on a slow CA`.

### Task 3: Server-side snapshot writes, on every backup run (was Task 2)

**Status:** still needed, reshaped (key layout, flags verified, marker contract, prefix carriage, k8s settings ConfigMap, GitOps var).

**Files:**
- Create:
  - `carbon/backup/tls-snapshot.sh`: compose. It runs from the project dir, like compose-backup.sh.
- Modify:
  - `carbon/backup/compose-backup.sh`: the final `docker compose exec -T db bash -c '…'` becomes `rc=0; docker compose exec … || rc=$?`. On rc 0 or 3 it runs `bash backup/tls-snapshot.sh >&2 || echo "tls snapshot skipped" >&2`, then prints the completion line on rc 0 and `exit "$rc"`. The header comment's contract section names the TLS step.
  - `carbon/backup/compose-backup.sh` is otherwise unchanged; the retired-node refusal, lock and fence stay first.
  - `carbon/docker-compose.prod.yml:170-202`: the traefik service gains `environment: TLS_SNAPSHOT_S3_PREFIX: ${TLS_SNAPSHOT_S3_PREFIX:-}`.
  - `carbon/k8s/base/backup/cronjob.yaml`: an env var `TLS_SNAPSHOT_S3_PREFIX` from `configMapKeyRef` `vibecarbon-backup-settings` (optional), and a TLS step after `' || rc=$?` and before `if [ "$rc" -eq 75 ]`, run only on rc 0, 3 or 75, which never changes `rc`.
  - `carbon/k8s/base/backup/rbac.yaml`: Role `backup-exec` gains `secrets` `get` with `resourceNames: ["vibecarbon-tls"]` only.
  - `carbon/scripts/render-backup-settings.mjs`: `renderBackupSettingsConfigMap(settings)` writes `TLS_SNAPSHOT_S3_PREFIX` when `settings.tlsSnapshotPrefix` is set. Script mode reads an optional `TLS_SNAPSHOT_S3_PREFIX` env var.
  - `carbon/.github/workflows/deploy.yml:82-91`: pass `TLS_SNAPSHOT_S3_PREFIX: ${{ vars.TLS_SNAPSHOT_S3_PREFIX }}`.
  - `src/lib/deploy/k8s/gitops-deploy.js:291-293`: seed the `TLS_SNAPSHOT_S3_PREFIX` var beside the backup vars.
  - `src/lib/deploy/k8s/k3s.js`: hoist the `acmeServer` / `issuerName` computation (now lines 4245-4246) above `renderK8sBase` (line 3986), and pass `tlsSnapshotPrefix` into `renderBackupSettingsConfigMap` (line 4013). `backupBucketName` and `operatorEnv` are already arguments.
  - `src/lib/deploy/bundle.js`: a `tlsSnapshotPrefix` render option sets `envOverrides.TLS_SNAPSHOT_S3_PREFIX` (the formatDotenvLine merge at lines 435-446).
  - `src/lib/deploy/orchestrator.js:1519-1533`: pass `tlsSnapshotPrefix` to `renderBundle` when `backupS3Config.bucket` is set.
  - `src/create.js:896-897`: copy and `chmod 755` `backup/tls-snapshot.sh`.
- Test:
  - `tests/unit/template/tls-snapshot-script.test.ts`;
  - `tests/unit/backup/` (or wherever the marker tests live) extended for the compose-backup.sh rc handling;
  - `tests/unit/template/backup-cronjob-recovery-guard.test.ts`, extended for the TLS step;
  - `tests/unit/template/embedded-shell-syntax.test.ts` already walks `carbon/backup/*.sh` and the cronjob: verify it picks up `tls-snapshot.sh`, with no edit expected;
  - the render-backup-settings unit test, extended.

**Interfaces:**
- Consumes `tlsSnapshotS3Prefix` and `caSlug` (Task 1).
- Produces the server-side invariant: an object at `<TLS_SNAPSHOT_S3_PREFIX>/compose-acme.json` or `<…>/k8s-secret.json`, uploaded uncompressed and unencrypted, so `readTlsSnapshot` can `GetObject` it as-is.
- Produces `bash backup/tls-snapshot.sh`, run from `/opt/<project>`, exit 0 on every skip; Task 4 runs it on demand.

- [ ] **Step 1 (done 2026-10-21, Refresh item 5):** `st put` flags and stdin form verified. No action; the implementer re-reads finding 4.
- [ ] **Step 2: Write the failing tests.** They render and inspect the script text, and execute the compose script with `docker` stubbed by a PATH-shim that records argv and stdin byte counts.
  - With the db container reporting `WALG_ROLE=standby`, no `st put` is invoked, and the exit code is 0.
  - With `.vibecarbon-retired` present, nothing is uploaded and the exit code is 0.
  - With the traefik command carrying the disarmed CA server, nothing is uploaded.
  - With an `acme.json` lacking `"main": "app.example.com"`, nothing is uploaded and the exit code is 0.
  - With a matching `acme.json`, exactly one invocation is `docker compose exec -T -e WALG_S3_PREFIX=<prefix> db wal-g st put -s -f --no-compress --no-encrypt compose-acme.json`, fed from `docker compose exec -T traefik cat /letsencrypt/acme.json` on stdin, and no file is left in the project dir.
  - With `TLS_SNAPSHOT_S3_PREFIX` empty, the script skips with exit 0.
  - The script contains `umask 077`, prints nothing to stdout, and never contains `BACKUP_RESULT`.
  - `compose-backup.sh` marker contract:

    ```ts
    it.each([[0, true], [3, true], [1, false], [75, false]])(
      'db exec rc %i: tls step runs=%s, exit code unchanged, one marker at most',
      (rc, runs) => {
        const run = runComposeBackup({ dbExecRc: rc });
        expect(run.code).toBe(rc);
        expect(run.calls.some((c) => c.includes('backup/tls-snapshot.sh'))).toBe(runs);
        expect(run.stdout.match(/^BACKUP_RESULT=/gm)?.length ?? 0).toBeLessThanOrEqual(1);
      },
    );
    ```
    (The lock skip's 75 exits before the db exec, so it never reaches the TLS step.)
  - The cronjob's TLS step:
    - contains `kubectl get secret vibecarbon-tls -n vibecarbon -o json`;
    - gates on the issuer-name annotation not equal to `vibecarbon-standby-selfsigned`;
    - pipes into `kubectl exec -i -n vibecarbon statefulset/db -c db -- env WALG_S3_PREFIX="$TLS_SNAPSHOT_S3_PREFIX" wal-g st put -s -f --no-compress --no-encrypt k8s-secret.json`;
    - sits after `|| rc=$?` and before the rc-75 line, guarded on rc 0, 3 or 75;
    - never `echo`es the Secret and prints only to stderr;
    - skips when `TLS_SNAPSHOT_S3_PREFIX` is empty;
    - carries no apostrophes.
  - `renderBackupSettingsConfigMap({ ...settings, tlsSnapshotPrefix: 's3://b/backups/p/e/tls/prod' })` contains the key, and without the field it does not.
  - The bundle's `.env` carries `TLS_SNAPSHOT_S3_PREFIX` as `formatDotenvLine` renders it.
- [ ] **Step 3:** Run `pnpm vitest run tests/unit/template/tls-snapshot-script.test.ts tests/unit/template/embedded-shell-syntax.test.ts tests/unit/template/backup-cronjob-recovery-guard.test.ts` plus the marker and settings tests. Expected: FAIL.
- [ ] **Step 4: Implement.** The compose script streams `acme.json` from the traefik container into the db container's `wal-g st put -s`, with no temp file on the host. The k8s step streams over stdin, with no file on the CronJob pod. The k8s step reads the annotation with `kubectl get … -o jsonpath=…` in double quotes (no jq dependency).
- [ ] **Step 5:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(backup): tls certificate snapshot beside every base backup`.

### Task 4: Compose and compose-ha deploy restore and snapshot steps (was Task 3)

**Status:** still needed, reshaped (ctx backup config, -f set from reconcile.sh, census also orders after setup-server-files, gate on `ctx.tlsState`).

**Files:**
- Modify:
  - `src/lib/deploy/plan/steps.js`: `restoreTlsStep()` and `snapshotTlsStep()`, each one step shared by both compose tiers (the `verifyTlsReadyStep` pattern, line 102);
  - `src/lib/deploy/plan/deploy-plan.js`: compose list (lines 63-80) gets `restore-tls` right before `start-compose-stack` and `snapshot-tls` right after `verify-tls`; compose-ha list (lines 87-112) gets `restore-tls` right before `start-compose-stack` and `snapshot-tls` right after `verify-tls`;
  - `src/lib/deploy/effects/index.js`: effects `restoreTlsSnapshot` and `snapshotTls`, which read the primary's ip as `ctx.serverIp ?? ctx.primary?.ip` (the `verifyTlsReady` pattern), so compose-ha needs no separate effect;
  - `src/lib/deploy/orchestrator.js:1639`: `deployCtx` gains `backupS3Config`; the compose-ha ctx's own copy (line 1758) goes.
- Create:
  - `src/lib/deploy/compose/tls-restore.js`;
  - `tests/unit/deploy/compose-tls-restore.test.ts`;
  - `tests/unit/deploy/plan/tls-step-order-census.test.ts`;
  - `tests/unit/deploy/_no-key-leak.ts`, a shared spy helper.
- Modify: `tests/unit/deploy/plan/deploy-plan.snapshot.test.ts` and `deploy-plan.test.ts`, updated for the new steps.

**Interfaces:**
- Consumes Task 1's `readTlsSnapshot`, `inspectComposeAcme`, `isSnapshotBetter` and `tlsSnapshotKey`; Task 2's `ctx.tlsState`; Task 3's `backup/tls-snapshot.sh`; `scpUpload` and `sshRunScript` (src/lib/ssh.js:488, 355); `RECONCILE_FLAGS_SED` (bundle.js:61).
- Produces:
  - `restoreComposeTls({ ip, sshKeyPath, projectName, domain, envName, ca, s3Config, deps? }): Promise<{ restored: boolean, reason: string }>`. Task 5 reuses it. It never throws.
  - `snapshotComposeTlsNow({ ip, sshKeyPath, projectName, deps? }): Promise<void>`, which runs `cd /opt/<p> && bash backup/tls-snapshot.sh` remotely and is best-effort.
  - Step names `restore-tls` and `snapshot-tls`.

- [ ] **Step 1: Write the failing census test.**

  ```ts
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
    const names = planDeploy(tier, {}).map((s) => s.name);
    if (!names.includes('start-compose-stack')) continue;
    it(`${tier}: restore-tls after setup-server-files and before start-compose-stack; snapshot-tls after verify-tls`, () => {
      expect(names.filter((n) => n === 'restore-tls')).toHaveLength(1);
      expect(names.filter((n) => n === 'snapshot-tls')).toHaveLength(1);
      expect(names.indexOf('restore-tls')).toBeGreaterThan(names.indexOf('setup-server-files'));
      expect(names.indexOf('restore-tls')).toBeLessThan(names.indexOf('start-compose-stack'));
      expect(names.indexOf('snapshot-tls')).toBeGreaterThan(names.indexOf('verify-tls'));
    });
  }
  ```
  The walk drafts any future compose tier automatically. A guard `it` asserts at least two tiers were checked, so the census cannot go hollow.
- [ ] **Step 2: Write the failing behavioural tests** for `restoreComposeTls`, with injected `deps` for `read`, `ssh` and `scp`.
  - When the live `acme.json` check reports the apex is present (remote script exit 0 from `grep -Eq '"main": ?"<domain>"'` inside the traefik volume), there is no read, no scp, and the result is `restored:false`, `reason:'live certificate present'`.
  - When the live certificate is absent and the snapshot is valid:
    - one scp goes to `/opt/<project>/.tls-restore/acme.json`, from a local `mkdtempSync` file of mode 0o600 that is gone afterwards;
    - one remote script runs under `umask 077`, takes its `-f` set with `sed -n '<RECONCILE_FLAGS_SED>' reconcile.sh`, runs `docker compose $FLAGS run --rm --no-deps -v /opt/<p>/.tls-restore/acme.json:/restore/acme.json:ro --entrypoint sh traefik -c …` that copies it to `/letsencrypt/acme.json` and runs `chmod 600 /letsencrypt/acme.json`, and `rm -rf`s `.tls-restore` on exit with `trap`;
    - the result is `restored:true`.
  - When the traefik container is running, the remote script also runs `docker compose restart traefik` after the write.
  - When the snapshot is absent, invalid or for the wrong CA, nothing is written, and the result is `restored:false` with the reason from `readTlsSnapshot` or `inspectComposeAcme`.
  - With `s3Config` null, or no bucket, the result is `restored:false`, `reason:'no backup bucket'`.
  - `snapshotTls` runs only when `ctx.tlsState?.state === 'trusted'`.
  - **No-leak test:** run a full restore with a real fixture through `_no-key-leak.ts`, which spies on `p.log.*`, `console.*`, `process.stdout.write`, `process.stderr.write` and `progressLog`. No captured string contains `BEGIN`, `PRIVATE KEY` or the fixture's base64 key. The helper exports `expectNoKeyLeak(fixture, fn)` for Tasks 5 to 7.
- [ ] **Step 3:** Run `pnpm vitest run tests/unit/deploy/compose-tls-restore.test.ts tests/unit/deploy/plan/`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Effect `restoreTlsSnapshot` builds `s3Config` as `{ ...ctx.s3Config, bucket: ctx.backupS3Config?.bucket }` and `ca` from `caSlug(readOperatorVar('ACME_CA_SERVER').value)`, the value the bundle wrote. It prints the one info line and never throws.
  - Effect `snapshotTls` calls `snapshotComposeTlsNow` and warns on failure without failing the deploy.
- [ ] **Step 5:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(deploy): compose restores the last issued certificate before traefik starts`.

### Task 5: Compose-ha failover and compose scale reuse the certificate

**Status:** still needed, reshaped (scale restore placement and live-check wipe under the journaled cutover; failover credentials and CA from the record; line numbers).

**Files:**
- Modify:
  - `src/lib/deploy/acme-role.js:132-163`: `armComposeAcme` takes an optional `restore` dep and calls it before running `composeTraefikRecreateShell`. The recreate then starts Traefik on the restored file, so no separate restart is needed.
  - `src/lib/deploy/compose/ha.js:2337`: pass `restore: () => restoreComposeTls({ … })`. `s3Config` comes from `resolveS3Config({ isCompose: true, envName, projectName, envConfig, skipPrompts: true })` (restore-base.js:101), `ca` from `envConfig.tls?.ca` and `domain` from `envConfig.domain`. With no `tls.ca`, no restore is attempted and one info line says why.
  - `src/scale.js`: `prepareReplacementServer` (line 1009) calls `restoreComposeTls` just before step 6's `startComposeStack` (line 1245), for a primary target only. It uses the `backupS3` that `scaleServers` already resolved (lines 1351-1373, threaded through ctx) and `envConfig.tls?.ca`.
  - `src/scale.js:672-683` (inside `finishComposeCutover`'s `recreate` step): the HTTP-01 wipe runs only when a live check on the new server finds no apex `main` in `acme.json`. The decision is made on the server, so `resumeComposeCutover` (line 778) needs no new journal field.
- Test:
  - `tests/unit/deploy/compose-ha-acme-role.test.ts`, extended;
  - `tests/unit/scale/compose-scale-tls-restore.test.ts`.

**Interfaces:** consumes `restoreComposeTls` and `_no-key-leak.ts` (Task 4), `envConfig.tls.ca` (Task 2) and `resolveS3Config` (existing).

- [ ] **Step 1: Write the failing tests.**
  - `armComposeAcme`, with deps recording the call order: the restore runs after the `.env` merge and before the recreate script.
  - A restore that throws still leads to the recreate and to `true`, so a DR path never throws over certificates.
  - Failover with no `envConfig.tls.ca`: `restoreComposeTls` is never called, and `resolveS3Config` is called with `skipPrompts: true` or not at all.
  - Scale, primary target: `restoreComposeTls` is called after `pullComposeImages` and before `startComposeStack`. A standby-only scale never calls it.
  - Scale `recreate`, HTTP-01, with the live check finding the apex: no `echo "{}" > /letsencrypt/acme.json` is sent.
  - Scale `recreate`, HTTP-01, with the live check finding nothing: the wipe is sent exactly as today.
  - Scale `recreate` resumed from the journal (`resumeComposeCutover`) makes the same live-check decision.
  - The no-leak helper wraps a scale restore.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(failover): compose-ha promotion and scale serve the existing certificate`.

### Task 6: k8s deploy: no placeholder window, Secret restore, shorter backoff, non-blocking probe

**Status:** still needed, reshaped (render via `renderK8sBase`'s new argument; Flux de-ownership; dead patch removed; backoff merged into step 1c; probe lines; operator-side post-trusted snapshot; `tls` via deployResult).

**Files:**
- Modify:
  - `src/lib/deploy/k8s/k3s.js`:
    - `renderK8sBase(dir, values, backupConfig, tls)` (line 2888) overwrites the rendered copy's `traefik/certificate.yaml` with `renderTlsCertificateManifest(tls)`, and refuses a rendered tree that still contains `app.example.com` (the existing leftover-check loop);
    - `applyK3sManifests` computes `dnsNames` and `effectiveIssuer` beside the `issuerName` Task 3 hoisted, and passes them to `renderK8sBase` (line 3986);
    - `restoreK8sTlsSecret` runs after `applyVibecarbonSecrets` (line 3901, so the namespace exists) and before `apply -k base` (line 4006), for role `primary` and single-cluster only;
    - step 1c (lines 3615-3666) adds `--certificate-request-minimum-backoff-duration=5m` to its flag list, so it stays one read and at most one patch;
    - the `vibecarbon-tls` patch (lines 4256-4278) is deleted, and the `[pilot-standby]` log line stays.
  - `carbon/k8s/base/traefik/certificate.yaml`: the header comment says the deploy renders it and Flux does not own it, and it gains `kustomize.toolkit.fluxcd.io/prune: disabled`.
  - `carbon/k8s/flux/clusters/primary/vibecarbon.yaml` and `carbon/k8s/flux/clusters/standby/vibecarbon.yaml`: a `$patch: delete` for `Certificate` `vibecarbon-tls`, with the same comment shape as the CronJob's.
  - `src/lib/deploy/orchestrator.js:1944-2000`: split the probe into an app phase and a TLS phase, set `deployResult.tls`, and (primary trusted only) take the post-deploy snapshot.
- Create:
  - `src/lib/deploy/k8s/tls-restore.js`;
  - `tests/unit/deploy/k8s-tls-restore.test.ts`;
  - `tests/unit/deploy/k8s-certificate-render.test.ts`;
  - `tests/unit/deploy/flux-deploy-owned-census.test.ts`, or an extension of `gitops-cert-webhook-wiring.test.ts`.
- Modify tests: `tests/unit/deploy/cert-manager-recursive-ns.test.ts` (the flag list), `tests/unit/deploy/cert-manager-issuer-selection.test.ts` (it pins the deleted patch; move its issuer assertions onto the rendered manifest).

**Interfaces:**
- Consumes Task 1, Task 2's `TLS_FIRST_LOOK_BUDGET_MS` and the final save's `tls` field, Task 4's `_no-key-leak.ts`, and `certificateDnsNames` and `pickIssuerName` (existing).
- Produces:
  - `renderTlsCertificateManifest({ dnsNames, issuerName, effectiveIssuer }): string`, as YAML, with the promote annotation and `prune: disabled`;
  - `restoreK8sTlsSecret({ s3Config, projectName, envName, ca, issuerName, dnsNames, runKubectl }): Promise<{ restored: boolean, reason: string }>`;
  - `snapshotK8sTlsSecret({ s3Config, projectName, envName, ca, runKubectl }): Promise<{ ok: boolean, reason?: string }>`, which reads the live Secret, refuses a standby-issued or non-covering one, and calls `writeTlsSnapshot`;
  - `CERT_MANAGER_MIN_BACKOFF = '5m'`.
  - Task 7 reuses `renderTlsCertificateManifest` and the Secret helpers.

- [ ] **Step 1: Write the failing tests.**
  - `renderTlsCertificateManifest` output parsed with `yaml` has:
    - `spec.dnsNames` deep-equal to the input;
    - `spec.issuerRef.name === effectiveIssuer`;
    - `metadata.annotations['vibecarbon.dev/promote-issuer'] === issuerName` (import `PROMOTE_ISSUER_ANNOTATION`);
    - `metadata.annotations['kustomize.toolkit.fluxcd.io/prune'] === 'disabled'`;
    - no `app.example.com`.
  - `renderK8sBase`'s rendered tree contains that file, and no rendered file in the base tree still contains `app.example.com`. A `tls` argument that is missing throws.
  - Flux census: both cluster Kustomizations delete `Certificate/vibecarbon-tls` from the `vibecarbon-base` build, and the base `certificate.yaml` carries `prune: disabled`.
  - `restoreK8sTlsSecret`, with `runKubectl` recording argv and options:
    - with the live Secret valid and better, there is no S3 read, no apply, and `restored:false`;
    - with the live Secret absent (NotFound) and the snapshot valid, there is exactly one `apply -f -` whose `input` is the `buildRestoredTlsSecret` JSON, `argv` contains no certificate data, the live read passed `captureStdout: true`, and the result is `restored:true`;
    - with the snapshot for a different `dnsNames`, there is no apply;
    - an apply that throws with key material in its `stderr` produces a reason that contains none of it;
    - on a pilot standby (`role: 'standby'`), the function isn't called. Assert at the `applyK3sManifests` call site via the existing k3s test harness: restore precedes `apply -k <baseDir>` for primary and single-cluster, and is absent for a standby.
  - The cert-manager step 1c: with neither flag present, one `--type=json` patch adds all three flags; with all present, no patch runs.
  - Orchestrator probe:
    - an app phase with TLS verification off, pinned SNI, still public DNS, budget unchanged at 1,200,000 ms, failure still hard;
    - then a TLS phase running `probePublicHealth` with verification and the ACME watchdog, budget `TLS_FIRST_LOOK_BUDGET_MS`;
    - TLS-phase failure or a watchdog `abort` gives `deployResult.tls.state='pending'` with the watchdog reason, a `TLS pending` warning, and exit 0;
    - TLS-phase success gives `deployResult.tls.state='trusted'`, and one `snapshotK8sTlsSecret` call for the primary cluster only;
    - `deployResult.tls.ca === caSlug(issuerName)`;
    - the no-leak helper wraps a restore run and a snapshot run.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-tls-restore.test.ts tests/unit/deploy/k8s-certificate-render.test.ts tests/unit/deploy/cert-manager-recursive-ns.test.ts tests/unit/deploy/cert-manager-issuer-selection.test.ts` plus the Flux census. Expected: FAIL.
- [ ] **Step 3: Implement.** The live Secret is read with `kubectl get secret vibecarbon-tls -n vibecarbon -o json` through `runKubectlWithRetry(…, { captureStdout: true })`; NotFound gives live `{ok:false}`. `probePublicHealth` gains a `verifyTls` option (default `true`); the app phase passes `false`, and the comment says the trust verdict is the TLS phase's, recorded, never silently passed.
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`. Expected: PASS. Commit: `feat(k8s): restore the issued certificate and stop waiting out the CA`.

### Task 7: k8s-ha promotion serves the primary's certificate

**Status:** still needed (lines moved; DNS names from the live Certificate; CA from the annotation).

**Files:**
- Modify: `src/failover.js:499-541` (`promoteAcmeIssuer`) gains optional `snapshot` inputs (`{ s3Config, projectName, envName }`). Its caller (line 2246, dep `promoteIssuer` injected at line 1751) passes them, with `s3Config` from `resolveS3Config({ isCompose: false, envName, projectName, envConfig, skipPrompts: true })`.
- Test: `tests/unit/failover/promote-acme-issuer.test.ts`, extended.

**Interfaces:** consumes `readTlsSnapshot`, `inspectK8sTlsSecret`, `buildRestoredTlsSecret`, `caSlug` and `tlsSnapshotKey` (Task 1), `renderTlsCertificateManifest` (Task 6) and `_no-key-leak.ts` (Task 4). `kubectl` is `sshKubectl(ip, key, argv, { input })` (ssh.js:514).

- [ ] **Step 1: Write the failing tests** with an injected `kubectl` recorder.
  - **Valid snapshot for `vibecarbon-tls`** (`ca = caSlug(target)`, `dnsNames` from the live Certificate's `spec.dnsNames`). The calls, in order:
    1. `delete certificate vibecarbon-tls -n vibecarbon --ignore-not-found`;
    2. `apply -f -` with the restored Secret on `input`, with annotation issuer equal to the promote annotation's target;
    3. `apply -f -` of the Certificate rendered with `effectiveIssuer = target`.
    No `patch certificate` call is made for `vibecarbon-tls`, and no argv carries certificate data.
  - **No or invalid snapshot, or no `s3Config`.** Today's patch behaviour, byte-identical argv.
  - **`grafana-tls`.** Always today's patch path; snapshots are out of scope for it.
  - **Any throw in the snapshot path.** It falls back to the patch path and warns once. It never throws, since a DR path never throws over certificates.
  - The no-leak helper wraps the valid-snapshot run.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `pnpm test:unit`, including `tests/unit/failover/failover-step-order-census.test.ts`. Expected: PASS. Commit: `feat(failover): k8s-ha promotion restores the primary certificate instead of re-issuing`.

### Task 8: `vibecarbon status` TLS row and e2e proof of reuse

**Status:** still needed, reshaped (status module placement, both deploy docs, hollow-pass census).

**Files:**
- Modify:
  - `src/lib/deploy/tls-ready.js`: `probeTlsTrustOnce` also returns `validTo` and `serialNumber` on a trusted handshake.
  - `src/status.js`: a `checkTls(domain)` call beside `checkRemoteHealth` (line 1660), and `formatTlsLines` rendered right after the Health block in `renderEnvironment` (line 1420).
  - `tests/e2e/checks/health.ts:595`: `checkSslValid` budget.
  - `tests/e2e/scenarios/_run-lifecycle.ts`: record and compare serials at `verify-deploy`, `verify-restore`, `verify-failover`, and the CertificateRequest count around `warm-redeploy-change`.
  - `docs/deploy-hetzner.md` and `docs/deploy-digitalocean.md`: one short "Certificates" paragraph each.
- Create:
  - `src/lib/status/tls-row.js` (the `backup-health.js` pattern: `checkTls`, `formatTlsLines`);
  - `tests/e2e/checks/tls-reuse.ts`;
  - `tests/unit/e2e/tls-reuse-check.test.ts`;
  - `tests/unit/status/tls-row.test.ts`.

**Interfaces:**
- Consumes `envConfig.tls` (Tasks 2 and 6) and `probeTlsTrustOnce`.
- Produces:
  - e2e check `tls_reused`;
  - `checkTlsReused(previousSerial: string, domain: string): Promise<VerificationResult>`.

- [ ] **Step 1: Write the failing tests.**
  - The status row:
    - trusted renders `● trusted  expires <YYYY-MM-DD>`;
    - untrusted with `envConfig.tls.state==='pending'` renders `● pending` plus the stored reason and the hint `issuance retries in the background`;
    - untrusted and not pending renders `● untrusted` plus the reason.
    - `probeTlsTrustOnce`'s existing tests stay green.
  - `checkTlsReused`: the same serial passes; a different serial fails, with a message naming both serials and `re-issued instead of reused`; an empty `previousSerial` fails (never a hollow pass), and the check is registered with `tests/unit/e2e/hollow-pass-census.test.ts`'s expectations.
  - The lifecycle:
    - records the served serial at verify-deploy;
    - asserts `tls_reused` at verify-restore (after the plain mid-run `destroy` and re-deploy; the mid-run destroy has no `-purge`) and at verify-failover, the promoted node or cluster;
    - on k8s and k8s-ha, `warm-redeploy-change` also asserts that `kubectl get certificaterequest -n vibecarbon` gained no item.
    - `checkSslValid` uses 32 × 15 s (480 s) when the CLI's project config shows `tls.state==='pending'` after deploy, else today's 12 × 15 s.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/status/tls-row.test.ts tests/unit/e2e/tls-reuse-check.test.ts tests/unit/deploy/tls-ready.test.ts`. Expected: FAIL.
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

- **Lifetimes.** Let's Encrypt's default lifetime is still 90 days in 2026, and its announced move to shorter certificates makes the scheduled snapshot necessary rather than nice. It runs on the backup schedule (default every 6 hours, `DEFAULT_BACKUP_SCHEDULE`).
- **A hidden reissue on every k8s redeploy.** Today `apply -k base` resets `vibecarbon-tls` to the `app.example.com` placeholder, and the patch then follows; on GitOps environments Flux does the same every 10 minutes (Refresh item 9). Task 6's render and Flux de-ownership remove both windows, and Task 8's CertificateRequest-count assertion proves it.
- **Flux upgrade window.** A project that pulls the new Flux patch before its next CLI deploy lets Flux prune the live Certificate once (the live object lacks `prune: disabled` until a CLI deploy stamps it). The Secret stays and keeps serving; renewal resumes at the next `vibecarbon deploy`. The Compatibility note says to deploy once after upgrading.
- **Failover when the backup bucket's region is down too.** Restore degrades to today's behaviour: fresh issuance, now pending instead of failing.
- **Failover without object-storage credentials in the operator's shell.** `resolveS3Config` returns null without prompting, so the promoted node issues fresh, and `status` shows pending if that is slow.
- **First traefik recreate after upgrade.** Adding `TLS_SNAPSHOT_S3_PREFIX` to the traefik service recreates Traefik once on the first deploy that carries it (a sub-second TLS blip, served from `acme.json`).
