# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the nine deploy-path and security findings, plus the database-superuser finding (H10), from the 2026-10-20 architecture review. Every fix ships a census that covers its whole bug class, not just the one instance.

**Architecture:** The plan fixes four classes:
1. **Secrets reaching processes that don't need them.** Each process gets an explicit runtime env from one shared allowlist instead of the whole server `.env`. Each environment's app gets its own object-storage key, limited to that environment's app bucket, wherever the provider can scope keys (measured live on 2026-10-20, see R2).
2. **Overlay merge drift.** The prod Traefik's socket mount is removed with `!override`, and a check on the rendered compose config pins it.
3. **Single-layer network exposure.** hostPorts are bound to specific interfaces, and NetworkPolicies give pods that call the Kubernetes API the egress they need.
4. **Fail-open gates and log leaks.** Request logs are redacted, the MFA check fails closed, and stale WireGuard firewall rules are removed.

**Tech Stack:** Node ESM CLI (`src/`), template app (Hono, Better Auth 1.7.10, pino) in `carbon/`, Docker Compose v5 (`docker compose config --format json` for rendered checks), k3s manifests, vitest.

**Spec:** the review report `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/arch-review/deploy-security.md`. It was re-verified on 2026-10-20 against `feat/project-app-bucket` @ 7de7f0d (see "Verification of findings" below). The object-storage scoping evidence is the real-account spike `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/arch-review/s3-scoping-spike.md`, including its "Hetzner second key" section. Task 4 commits a copy as `docs/research/2026-10-object-storage-key-scoping.md`.

**Base:** branch `feat/project-app-bucket` @ af2897b (PR #233). On that branch:
- the app uploads bucket is **one per environment** (`deriveEnvAppBucketName`, read only through `resolveEnvStorage(envName, envConfig, projectConfig).bucket`);
- the Pulumi state bucket and the backups bucket are per project;
- `S3_KEY_PREFIX` no longer exists, and `VC_ENV` is written only into the compose `.env` for WAL-G's folder (it is not in the k8s Secret).

## Verification of findings (done while planning)

All nine findings hold. None were dropped. Two were corrected or extended:

| # | Finding | Re-verification |
|---|---|---|
| C1 | The compose app gets the full cloud and DNS token | **Confirmed by render.** Base + prod with `HETZNER_API_TOKEN=SENTINELTOK` in `.env`: the sentinel appears in `app`'s environment (`carbon/docker-compose.yml:70-71` `env_file: .env`). Extended: on k8s the app's `envFrom: vibecarbon-secrets` (`carbon/k8s/base/app/deployment.yaml:58`) also carries `REPL_PASSWORD`, `METABASE_DB_PASSWORD` and `N8N_DB_PASSWORD` (`k3s.js` `INFRA_SECRET_KEYS`), which the app never reads. This is the same class, so it is fixed in Task 1. |
| H2 | The app's S3 key is the account-wide infra key | Confirmed (`bundle.js` envOverrides, `k3s.js` `buildVibecarbonSecretData`, `iac/index.js:196`). **Scope after PR #233:** every environment now has its own app bucket, so a key limited to one bucket keeps an app away from the backups, the Pulumi state **and** the other environments' uploads. No provider supports prefix-scoped keys, and the per-env bucket makes that unnecessary. What stays is the per-provider ability to mint such a key (R2, Task 4). |
| H3 | Prod Traefik still mounts `/var/run/docker.sock` | **Confirmed by render.** Base + prod: `traefik` and `docker-socket-proxy` both bind the socket. |
| M4 | The Hono logger logs token-bearing URLs | Confirmed: `carbon/src/server/index.ts:6,118`, `app.use('*', honoLogger())`. |
| M5 | k8s-ha hostPorts 5433 and 5000 have no `hostIP` | Confirmed: `src/lib/deploy/k8s/ha/index.js:145-156` (`buildDbHostPortPatch`) and `carbon/k8s/base/registry/local-registry.yaml:68-72`. **Correction:** the registry is not k8s-ha only. It is in `carbon/k8s/base`, so plain k8s is affected too. |
| M6 | Prometheus has no egress to the Kubernetes API | Confirmed: the `prometheus-policy` egress (`services/observability/k8s/network-policy.yaml:160-181`) allows only the vibecarbon namespace and :10250. The scrape config uses `kubernetes_sd_configs` (role node and pod). |
| L7 | Old WireGuard peer rules are never removed outside Hetzner, or in UFW | Confirmed: DO `digitalocean.js:1402-1415` appends and keeps every existing rule. `openWireguardPortUfw` (`compose/ha.js:739-743`) only ever runs `ufw allow`. |
| L8 | The MFA check fails open | Confirmed: `carbon/src/server/lib/mfa-settings.ts:38-43` returns `cache?.value ?? false` on error. Its callers are `middleware/requireAal2.ts:51`, `routes/_internal/verify-role.ts:142` and `auth/assurance.ts:381`. |
| I9 | Comments still refer to the Supabase-era service-role key | Confirmed in the observability k8s manifests. |

Added by the coordinator (H10): **the template app connects to Postgres as the `postgres` superuser.**
- Verified:
  - compose sets `DB_PASSWORD=${POSTGRES_PASSWORD}` (`carbon/docker-compose.yml:92`), and `DB_USER` defaults to `postgres` (`carbon/src/server/db/client.ts:12,29`). k8s does the same (`deployment.yaml:79`).
  - `adminDb` runs as that role. `withUserDb` switches to `app_user` (`NOLOGIN`, `0000_baseline_pre.sql:70`; `GRANT app_user TO postgres` at :80).
  - `assertBypassRole` (`client.ts:140-160`, called from `startup.ts:74` `checkDbRoleAtStartup`) only checks `rolsuper OR rolbypassrls` plus membership of `app_user`, so it accepts a superuser by design.
  - Migrations run inside the app process at boot, on the same credential (`startup.ts:284`, `runMigrationsOnOwnConnection(connectionConfig)`).
  - `app.revoke_server_only_tables()` keeps server-only tables readable only by superusers, the owner and the current connection role (`migrate.ts` docstring).
- Scenario: code execution in the app, or a SQL injection on any `adminDb` path, gives full superuser. That means `COPY ... TO PROGRAM` (shell on the db host or pod), reading every role's data, and dropping the WAL-G archive settings.

## Rulings (made while planning)

- **R1. One allowlist of app runtime keys, shared by compose and k8s.**
  - A new `src/lib/deploy/app-runtime-env.js` exports `APP_RUNTIME_KEYS`, built from the core app keys plus `featureSecretKeys()` and `featureConfigKeys()`.
  - compose: the bundler writes `app.env` with only those keys, through `formatDotenvLine`, and the prod overlay sets `app: env_file: !override [app.env]`. `.env` stays as the source compose substitutes `${VAR}` values from. Local dev (base + `docker-compose.override.yml`) keeps `env_file: .env`, since a developer's own machine is not the threat model.
  - k8s: `vibecarbon-secrets` splits into `vibecarbon-app-secrets` (the app's `envFrom`) and `vibecarbon-infra-secrets` (DB superuser, replication and add-on role passwords, read by the db, backup and add-on pods by key).
  - Cost if wrong: a key the app reads but the list leaves out is missing at runtime. The Task 1 census (every key the app reads is delivered) prevents that.
- **R2. App and infra object-storage credentials are separate roles everywhere. Whether they are distinct keys depends on the provider, as measured on real accounts on 2026-10-20** (the spike file named under Spec; every test key and bucket it made was deleted). Each S3 provider class declares `static appKeyScoping: 'mint' | 'paste-fence' | 'none'`, and the resulting tier per env is `isolated`, `fenced` or `shared`.

  | Provider | Measured | `appKeyScoping` | Tier |
  |---|---|---|---|
  | Linode | `POST /v4/object-storage/keys` with `{"label","regions":[<region>],"bucket_access":[{"region","bucket_name":<env bucket>,"permissions":"read_write"}]}` returns `limited: true` plus the key pair. The key works on its bucket and gets 403 on every other bucket. Revoke: `DELETE /v4/object-storage/keys/{id}`. Region comes from `GET /v4/object-storage/endpoints`. Usable about 5 s after minting. | `mint` | `isolated` |
  | DigitalOcean | `POST /v2/spaces/keys` with `{"name","grants":[{"bucket":<env bucket>,"permission":"readwrite"}]}` returns 201 with the key pair. It works on its bucket, and gets 403 on other buckets and on ListBuckets. Revoke: `DELETE /v2/spaces/keys/{access_key}`. Usable about 10 s after minting. A prefix grant returns 400. The API also offers `fullaccess`, which the deploy must never mint. A custom-scoped DO token needs the `spaces_key` create/delete scopes. **Minting works, so no control-panel paste is needed** (this corrects the earlier plan). | `mint` | `isolated` |
  | Hetzner | Keys can only be made in the console (every Cloud API credential route returns 404). Bucket policies are enforced, and each key is its own subuser: the principal `arn:aws:iam:::user/<ownerId>:<accessKeyId>` matches exactly one key. `<ownerId>` is the `p…` ID ListBuckets reports. This works **only as a deny-list**: Deny `s3:*` for the app key on `<bucket>` and `<bucket>/*`, placed on every bucket the app must not reach. It stopped object reads, writes and listing, plus policy, ACL, versioning, lifecycle and CORS changes. Limits a policy cannot close: the app key can still list every bucket name, create buckets, fully use any bucket without the fence (new ones included), and delete an **empty** fenced bucket. Policy changes take more than 30–60 s to apply on every gateway, unevenly. | `paste-fence` | `shared` by default; `fenced` when the operator pastes an app key |
  | Scaleway | Not verified: the e2e key has no IAM permissions (`iam create application` returns 403). Docs say IAM grants are project-wide, so a one-bucket key needs either a dedicated project or a policy on every other bucket, and minting needs org-level IAM write on the deploy key. **Ruling:** that write access would let the deploy credential mint org-wide keys, which is a privilege escalation, so Scaleway stays on the shared key. | `none` | `shared` |
  | Vultr | No key API beyond regenerating the subscription's single key pair. Policies apply to everyone, so they cannot separate keys. | `none` | `shared` |

  - **Hetzner ruling:** the default is the shared key. `vibecarbon configure` offers an optional "app storage key" paste per environment, with console steps. When a key is pasted, deploy writes the deny-fence (Task 4) and verifies it with repeated probes. The documented stronger option, an app bucket in a separate Hetzner project with its own key, stays documentation only.
  - Cost if wrong: an env believed to be isolated is not. The Task 4 invariant tests, plus `status` naming each env's tier and reason, keep it visible.
- **R3. Backup immutability:** out of scope for this plan. Object lock or versioning on the backup bucket is a separate decision (cost, and how retention interacts with WAL-G deletes). Data from the spike: Hetzner accepts bucket versioning, and object lock needs a create-time flag (not tested).
- **R4. Residual risk, said plainly** (per tier, after PR #233's per-environment app buckets):
  - `isolated` (Linode, DigitalOcean): the app key reaches only its own environment's bucket. No backups, no state, no other environment.
  - `fenced` (Hetzner with a pasted key): the app key is denied on the project's state and backups buckets and on every other environment's app bucket that vibecarbon manages. It can still list bucket names, create buckets, use any bucket created outside vibecarbon, and delete a fenced bucket while it is empty.
  - `shared` (Hetzner by default, Scaleway, Vultr): the app holds the account-wide infra key, so a compromised app can read and delete every environment's uploads, all backups and the Pulumi state.
  - Task 4 states this in `docs/` and in the PR, and `vibecarbon status` shows each environment's tier.
- **R9. The app key's lifecycle is tied to the environment.**
  - **Mint:** in the deploy's `s3-setup` step, right after the env bucket is ensured, and only when the env has no usable app key. A minted key is recorded as `envConfig.s3.appKey = { id, scoping, tier }`, where `id` is the Linode key id or the DO access key id. The record holds no secret.
  - **Secret storage:** the secret pair is written through `formatDotenvLine` into the CLI's per-environment secret store, keyed so two environments never overwrite each other. The implementer first verifies how env-scoped secrets are stored today (grep `.env.local` writers and the per-env GitHub environments sync), uses that mechanism, and records the choice in the report.
  - **Reuse:** a redeploy reuses the recorded key when its secret is present locally. When the secret is missing (a fresh checkout on another machine), or the provider no longer lists the id, the deploy mints a new key, records it, and revokes the old id. That is a state reconcile, not a retry: one mint, and a failure fails the deploy.
  - **Revoke:** every destroy of the env, plain or `-purge`, revokes its minted key, because no server uses it after the servers are gone and a redeploy mints a fresh one. A revoke failure is a ledger entry (a leak), like a bucket that could not be deleted.
  - **Hetzner pasted keys** cannot be revoked by the CLI. Destroy prints the console step to delete the key, and removes that key's principal from the deny-fences it wrote.
  - **Readiness:** a new key can take about 5–10 s before it works. The deploy checks that the app key can `HeadBucket` its bucket inside the concurrent storage-finalize task that already runs beside provisioning (`startAppBucketFinalize`), awaited before the success outro. It never adds a serial wait.
  - Cost if wrong: one extra mint or revoke API call per deploy or destroy.
- **R5. Registry hostIP.** The registry binds the master's private IP (`hostIP: <masterPrivateIp>`, rendered at apply time like `registries.yaml`). The operator push tunnel then forwards to `<masterPrivateIp>:5000` instead of `localhost:5000` on the far side. The local end stays `localhost:5000`, so Docker's loopback insecure-registry rule still applies. Coordinate with `2026-10-20-cold-deploy-speed.md` and `2026-10-20-k8s-ha-registry-copy.md`, which also push to or relay from that registry, by naming the same `masterPrivateIp:5000` target.
- **R6. The db hostPort binds `127.0.0.1`.** `repl-gateway` already dials `127.0.0.1:5433`. A portmap DNAT from loopback needs `route_localnet`, which the CNI portmap plugin enables for its loopback hostIP case. The k8s-ha replication checks in e2e are the proof (Task 6 Step 5).
- **R8. Least-privilege database roles (H10).**
  - `postgres` stays the owner. It runs migrations, owns the SECURITY DEFINER functions and runs pg_cron jobs.
  - A new LOGIN role, `app_service`, is the only credential the app process holds. It is `NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION BYPASSRLS`, a member of `app_user` (so `withUserDb` can switch), and has `SELECT, INSERT, UPDATE, DELETE` on the app's tables, `USAGE` on their schemas and sequences, and `EXECUTE` on exactly the SECURITY DEFINER functions that `adminDb` calls today (the lockout and admin-unlock family in `0002_baseline_post.sql`, `get_cron_jobs`, `log_cron_job`). It owns nothing, so it cannot `ALTER` or `DROP`.
    - BYPASSRLS stays, because `adminDb` is the app's documented server-side path and must not silently become RLS-scoped.
  - Migrations move out of the app process, so the request process never holds the owner password:
    - compose: a one-shot `app-migrate` service (same image, `node dist/server/migrate-cli.js`, `restart: "no"`) gets `DB_USER=postgres` and the owner password through its own `environment:`. `app` waits for it with `depends_on: {app-migrate: {condition: service_completed_successfully}}`.
    - k8s: an init container on the app pod with the owner password from `vibecarbon-infra-secrets` (Task 1). Its env is not shared with the app container.
  - The app process runs `runMigrations` in a verify-only mode, as standbys already do. It reports `/api/health/ready` down until the ledger is current, and it never applies anything.
  - The migrate step also does, idempotently and after the migrations:
    - creates or alters `app_service` and sets its password from `APP_DB_PASSWORD`, through `pg`'s `escapeLiteral` (`log_parameter_max_length=0` and `log_statement=none` already keep it out of the logs);
    - applies the grants plus `ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... TO app_service`, so a table a later migration creates is reachable;
    - updates `app.revoke_server_only_tables()` to keep `app_service`, not just `current_user`. Otherwise the Better Auth tables would be revoked from the app the first time migrations run as `postgres`.
  - `APP_DB_PASSWORD` is generated at `create` by the existing secret machinery (`src/create.js` required secrets, healed by `upgrade`), persisted through `formatDotenvLine`, and delivered only to the app's runtime env (Task 1's `APP_RUNTIME_KEYS`) and the migrate step.
  - Replicas need nothing extra. Roles, grants and passwords replicate physically to compose-ha and k8s-ha standbys, and the migrate step is a no-op on a standby (`pg_is_in_recovery`).
  - n8n, Metabase and observability keep their own roles. `revoke_server_only_tables` still excludes them.
  - Boot check: `assertBypassRole` additionally refuses a superuser or table-owning connection role when `NODE_ENV=production`. Local dev uses `app_service` too, for parity, with migrations run by `scripts/db-migrate.js` as the owner.
  - Cost if wrong: the app misses a privilege on some path. The db test suite runs as `app_service`, which shows it as a `42501` failure in CI, not in production.
- **R7. The MFA decision fails closed only where it guards access.** `isMfaGloballyEnabled()` becomes tri-state (`true`, `false`, `null` when unknown). Gates (`requireAal2`, `verify-role`, `assurance.ts`) treat `null` as `true`. UI and informational callers may treat `null` as unknown.

## Global Constraints

- No retry ladders. A failed security step fails the deploy with a one-line cause. The one optional step is the Hetzner app-key paste (R2): not pasting means the `shared` tier, never a failure. A failed mint on a `mint` provider never falls back to the infra key.
- The app key is never minted with account-wide rights: DigitalOcean grants are `readwrite` on the env bucket only (never `fullaccess`), and Linode `bucket_access` is `read_write` on the env bucket only.
- The app bucket name always comes from `resolveEnvStorage(...).bucket`. The bucket branch's census enforces it.
- No customers: no migration code. Old single-Secret k8s envs are re-applied on the next deploy (the k3s-apply inputs change). Ship with a Compatibility note and no `!:` footer.
- dotenv writes go only through `formatDotenvLine`. `app.env` is a new write site and gets added to `tests/unit/lib/dotenv-dialect-census.test.ts`.
- Never print secret values: not in logs, tests, the PR or census failure messages. Censuses use sentinels like `SENTINEL_<NAME>`.
- Traefik's public 80/443 are the only hostPorts without a hostIP.
- Conventional commits, pathspec commits, never `--no-verify`. Root uses pnpm; `carbon/` uses npm.
- Copy follows the CLI help voice: lowercase informational hints, no em dashes.

## Review Focus

- **H11:** from the app container on compose, no request (inspect, top, stats, archive, export, attach, any POST) through any reachable proxy returns another container's env or mutates anything; only container list and logs succeed (Task 3).

1. **A configure-managed key added later** (for example a new billing provider's secret): the app must still receive it in compose and k8s with no hand edit. Test in Task 1 (census: every key the app reads is delivered).
2. **compose-ha and scale write the server `.env` through the same bundle:** both nodes, and a scaled-in server, get `app.env`. Test in Task 1.
3. **An add-on overlay that adds env to `app`** (redis adds `REDIS_URL`): it still reaches the app after `env_file: !override`. Test in Task 1, with the rendered config for base + prod + each add-on.
4. **The k8s push tunnel after R5:** a cold k8s deploy still pushes to the registry, and kubelets still pull. Test in Task 6 (unit test on the tunnel target), plus a real-infra k8s run.
5. **A table added by a later migration:** the app (`app_service`) can still read and write it, and server-only tables stay revoked from the add-on roles. Test in Task 2 (default privileges plus the revoke rerun).
6. **A transient database error on the first MFA read in a fresh process:** the aal2 gate refuses (403 or 503), never lets the request through. Test in Task 8.
7. **A second environment deployed after the first, on a `paste-fence` provider (Hetzner):** the new env's bucket must deny the first env's app key, and the first env's key must still be denied on the state and backups buckets. Otherwise a bucket created later is open to an older env's app. Test in Task 4.

---

### Task 1: The app gets only its own runtime keys (C1 and its k8s member)

**Files:**
- Create: `src/lib/deploy/app-runtime-env.js`.
- Modify: `src/lib/deploy/bundle.js` (write `app.env` beside `.env`), `carbon/docker-compose.prod.yml` (`app: env_file: !override [app.env]`), `src/lib/deploy/k8s/k3s.js` (`buildVibecarbonSecretData` splits into `buildAppSecretData` and `buildInfraSecretData`, and `applyK3sManifests` applies both), `carbon/k8s/base/app/deployment.yaml` (`envFrom: vibecarbon-app-secrets`), every manifest that reads `vibecarbon-secrets` by key (db statefulset, backup cronjob, add-ons; grep `vibecarbon-secrets`), `src/lib/deploy/k8s/gitops-deploy.js` if it builds the same Secret, and `tests/unit/lib/dotenv-dialect-census.test.ts` (allow the `app.env` writer).
- Test: `tests/unit/deploy/app-runtime-env-census.test.ts` (new), `tests/integration/docker/compose-secret-reach.test.ts` (new, rendered config).

**Interfaces:**
- Produces:
  - `APP_RUNTIME_KEYS: readonly string[]`.
  - `buildAppRuntimeEnv(envLocal: Record<string,string>, extras: Record<string,string>) -> Record<string,string>`, which keeps only `APP_RUNTIME_KEYS` plus the explicit `extras` (the app's S3 credential pair from the `appStorageCredential` seam, and `REDIS_URL`). `VC_ENV` stays only in the compose `.env`, as the substitution source for the db service's WAL-G folder. The app never reads it.
  - `buildAppSecretData(...)` and `buildInfraSecretData(...)`.

- [ ] **Step 1: Write the failing tests.**
  - Census (a): every key in the zod schema in `carbon/src/server/lib/env.ts`, except `DEV_*`, `NODE_ENV`, `PORT` and the `DB_*` keys the compose `environment:` block and the k8s `env:` set explicitly, is in `APP_RUNTIME_KEYS` or in the explicit-extras list. Read the schema keys by parsing the file.
  - Census (b): `APP_RUNTIME_KEYS` contains no `DNS01_PROVIDERS[*].tokenEnvVar`, no registered provider's `TOKEN_ENV` or `CLI_TOKEN_ENV`, and none of `REPL_PASSWORD`, `METABASE_DB_PASSWORD`, `N8N_DB_PASSWORD`, `POSTGRES_PASSWORD`.
  - k8s: `buildAppSecretData` given an `envLocal` holding every infra key returns none of them. `buildInfraSecretData` returns `DB_PASSWORD` and `REPL_PASSWORD`.
  - The rendered integration test is gated like the other docker tests. Render base + prod (+ dns01, + each `services/*/compose` overlay) with a sentinel `.env` and a generated `app.env`, then assert:
    - every DNS token sentinel appears only in `traefik`;
    - no provider token sentinel appears in `app`, `n8n`, `metabase` or `grafana`;
    - `REDIS_URL` still reaches `app` with the redis overlay.
  - The bundle test: the rendered bundle contains an `app.env` holding `BETTER_AUTH_SECRET` and not `HETZNER_API_TOKEN` (sentinel values).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/app-runtime-env-census.test.ts` and `DOCKER_INTEGRATION=true pnpm vitest run --project integration-docker tests/integration/docker/compose-secret-reach.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files listed above.
  - compose-ha ships the same bundle (verify `effects/compose-ha.js` uses `ctx.bundlePath`).
  - Scale replays the old server `.env`, so make it also replay or regenerate `app.env`.
  - Route the app's S3 pair through one seam, `appStorageCredential` (the `extras` passed to `buildAppRuntimeEnv` and `buildAppSecretData`). In this task it still carries the infra pair, which is today's behaviour. Task 4 replaces what flows into it and touches no other call site.
- [ ] **Step 4: Run** the same commands plus `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(security): the app receives only its own runtime keys, never cloud or infra credentials`.

### Task 2: The app runs as a least-privilege database role; migrations run as the owner, outside the app (H10)

**Files:**
- Create:
  - `carbon/db/migrations/<next>_app_service_role.sql`: the grants and default privileges, and the updated `app.revoke_server_only_tables()` that keeps `app_service`. Creating the role and setting its password is done by the migrate step, not in SQL, because migrations carry no secrets.
  - `carbon/src/server/db/migrate-cli.ts`: runs `runMigrations`, then `ensureAppServiceRole(client, password)`, then exits 0 or 1.
  - `carbon/src/server/db/app-service-role.ts`.
- Modify:
  - `carbon/src/server/db/startup.ts`: the app runs verify-only, with no `runMigrationsOnOwnConnection` on the request credential;
  - `carbon/src/server/db/migrate.ts`: export `verifyMigrations(client)`, the standby branch generalised;
  - `carbon/src/server/db/client.ts`: `assertBypassRole` also refuses `rolsuper` or table ownership in production;
  - `carbon/docker-compose.yml` and `docker-compose.prod.yml`: `app-migrate` service, `app` `DB_USER=app_service`, `DB_PASSWORD=${APP_DB_PASSWORD}`, `depends_on` completed;
  - `carbon/k8s/base/app/deployment.yaml`: the init container plus the app env;
  - `src/create.js`: `APP_DB_PASSWORD` in the required secrets;
  - `src/upgrade.js`: heal;
  - `src/lib/deploy/app-runtime-env.js` (Task 1): `APP_DB_PASSWORD` in `APP_RUNTIME_KEYS`, `POSTGRES_PASSWORD` and `DB_PASSWORD` not;
  - `src/lib/deploy/k8s/k3s.js`: `APP_DB_PASSWORD` into the app Secret; the owner password stays infra-only;
  - `carbon/scripts/db-migrate.js` and `dev-init.js`: local parity.
- Test: `carbon/tests/db/app-service-role.test.ts` (new, real Postgres), `carbon/tests/unit/server/startup-verify-only.test.ts` (new), `tests/unit/deploy/app-db-credential-census.test.ts` (new).

**Interfaces:**
- Consumes: `APP_RUNTIME_KEYS` and `buildAppSecretData`/`buildInfraSecretData` (Task 1).
- Produces:
  - `ensureAppServiceRole(client: pg.ClientBase, password: string) -> Promise<void>`. It is idempotent and refuses an empty password.
  - `verifyMigrations(client) -> Promise<{ upToDate: boolean }>`.

- [ ] **Step 1: Write the failing tests.**
  - db test, connected as `app_service` after the migrate step has run on the test db:
    - `select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user` is all false;
    - `alter table profiles add column x int` and `drop table notifications` fail with SQLSTATE `42501`;
    - `set role postgres` fails;
    - `copy (select 1) to program 'true'` fails;
    - `create table public.t(x int)` fails;
    - inside `withUserDb(userA)`, selecting user B's private rows returns 0 rows (RLS applies off the `adminDb` path);
    - via `adminDb`, the same select returns them (BYPASSRLS, by design);
    - the Better Auth tables are readable after `app.revoke_server_only_tables()` has run as `postgres`;
    - every SECURITY DEFINER function the app calls through `adminDb` runs (walk `grep -n "adminDb.execute(sql\`select .*(" carbon/src/server` call sites into a fixed list asserted in the test);
    - a table created by a later migration, simulated by a `create table` as `postgres`, is readable by `app_service`.
  - Startup unit test: with a ledger behind the folder, the app logs "migrations pending" and serves with ready down. It never calls `migrate`.
  - Root census:
    - the rendered compose `app` env has `DB_USER=app_service` and no value equal to the `POSTGRES_PASSWORD` sentinel, while `app-migrate` has it;
    - the k8s app container's env and envFrom never reference `DB_PASSWORD` from `vibecarbon-infra-secrets`, while only the init container does;
    - `APP_RUNTIME_KEYS` excludes `POSTGRES_PASSWORD` and `DB_PASSWORD`.
- [ ] **Step 2: Run** `cd carbon && npx vitest run tests/unit/server/startup-verify-only.test.ts && npm run test:db -- tests/db/app-service-role.test.ts`, and `pnpm vitest run tests/unit/deploy/app-db-credential-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per R8. For compose-ha, check that both nodes render `app-migrate`; on the standby it exits 0 after the standby branch.
- [ ] **Step 4: Run** `cd carbon && npm run test:prepush && npm run test:db`, plus `pnpm test:unit` and `DOCKER_INTEGRATION=true pnpm vitest run --project integration-docker`. Expected: PASS. Then run a fresh `vibecarbon create` and `vibecarbon up` and check that sign-up, sign-in, the admin Jobs page and an upload work.
- [ ] **Step 5: Commit** `fix(security): the app connects as a least-privilege role and migrations run as the owner outside the app`.

### Task 3: Prod Traefik uses only the socket proxy, and the app's Docker access can never read another container's env (H3, H11)

**Finding H11 (from the Task 2 review, verified in code):** the app reaches `docker-socket-proxy` (`DOCKER_API_PROXY`, `carbon/docker-compose.prod.yml:34`) and that proxy enables `CONTAINERS: 1` (`:105`). tecnativa/docker-socket-proxy gates by API *section*, so `CONTAINERS` also serves `GET /containers/{id}/json`, whose `Config.Env` holds db's `POSTGRES_PASSWORD`, the exited `app-migrate`'s owner `DB_PASSWORD`, and Traefik's DNS-01 cloud token. A compromised app can read all three, which defeats Task 1 (C1) and Task 2 (H10) on compose. The overlay's own comment already concedes it ("a write barrier, not a secrets boundary").

**What the app actually uses** (`carbon/src/server/lib/docker-api.ts`, `routes/_internal/services-status.ts`): exactly two GETs, `/containers/json?filters=...` (the admin Infrastructure list: name, state, health) and `/containers/{id}/logs` (the log viewer). Restart already runs `docker compose restart` and is refused in prod (no CLI, read-only access), so it needs no Docker API. The list response carries Names/State/Status/Labels and no Env (verify in Step 1 against a real daemon); labels are Traefik router rules, not secrets.

**Ruling R11, split the proxies and give the app a path-allowlisted one:**
- `docker-socket-proxy` (Traefik's) stays as is for the Traefik provider, but moves to a dedicated internal network `socket-proxy` that only `traefik` joins. The app can no longer resolve or reach it.
- New service `app-docker-proxy`: a second socket proxy whose allowlist admits only `GET ^/v[0-9.]+/containers/json` and `GET ^/v[0-9.]+/containers/[a-zA-Z0-9_.-]+/logs`, everything else 403 (inspect, top, stats, export, archive, attach, every non-GET). The app joins only its network; `DOCKER_API_PROXY=http://app-docker-proxy:2375`.
- Mechanism, decided in Step 1 with evidence (context7 or the image README plus a live probe), in this order of preference:
  1. tecnativa/docker-socket-proxy (already pinned and mirrored by the speed plan) with a mounted, path-regex `haproxy.cfg`, if the image honours a full-config override;
  2. otherwise `wollomatic/socket-proxy` (regex `-allowGET`), pinned by digest and added to the speed plan's mirror table.
- Log viewer scope: logs stay readable for the project's containers (the feature needs them). Containers' own logs are not a credential channel by design; the census below also checks no service prints a secret env at start.
- Rejected: dropping Docker access entirely (loses the admin Infrastructure page on compose) and a purpose-built status agent (new code and image for what an allowlist does).
- k8s is already narrow: the app SA can `get/list pods` and `get pods/log` in `vibecarbon` only, and pod specs carry `secretKeyRef` names, not values. Add a census so it stays that way (below).

**Files:**
- Modify: `carbon/docker-compose.prod.yml`: traefik `volumes: !override` (the dynamic dir and `letsencrypt_data` only); restore the `--providers.docker.constraints=Label(...)` project-scoping flag that prod's `command:` drops (the same overlay-drift class); the `socket-proxy` network; the new `app-docker-proxy` service; the app's `DOCKER_API_PROXY` and networks. Correct the stale "write barrier" comments.
- Modify: `carbon/docker-compose.dns01.prod.yml` if it re-points Traefik's endpoint (keep it on `docker-socket-proxy`).
- Modify: `carbon/src/server/lib/docker-api.ts` comments only (no behaviour change: same two GETs).
- Test: extend `tests/integration/docker/compose-secret-reach.test.ts`, or add `compose-socket-reach.test.ts`; add `tests/unit/deploy/k8s-app-rbac-census.test.ts`.

- [ ] **Step 1: Decide the mechanism (evidence in the report).** Check whether tecnativa/docker-socket-proxy v0.4.2 honours a mounted full `haproxy.cfg` (README/context7, then a live `docker run` probe: list 200, logs 200, inspect 403). If not, probe `wollomatic/socket-proxy` the same way. Also confirm against a live daemon that `/containers/json` carries no `Env`.
- [ ] **Step 2: Write the failing tests.** Over the rendered compose matrix (base + prod + dns01 + every `services/*/compose` overlay):
  - the only services binding `/var/run/docker.sock` are `docker-socket-proxy`, `app-docker-proxy` and, with the observability overlay, `promtail` (it reads container logs; say so in the test);
  - Traefik's rendered command contains `--providers.docker.constraints=` and `--providers.docker.endpoint=tcp://docker-socket-proxy:2375`;
  - **reachability census:** for each service, the set of socket proxies it shares a network with; `app` (and every add-on service) reaches only `app-docker-proxy`; only `traefik` reaches `docker-socket-proxy`; any new proxy-like service (one that mounts the socket) must appear in the test's table with its allowed paths;
  - `app`'s `DOCKER_API_PROXY` points at `app-docker-proxy`.
  - Docker-tier behaviour test (DOCKER_INTEGRATION): bring up `app-docker-proxy` plus a throwaway container holding a sentinel env value; from a container on the app network, `GET /containers/json` → 200 without the sentinel, `GET /containers/{id}/logs` → 200, `GET /containers/{id}/json` → 403, `POST /containers/{id}/restart` → 403; the sentinel never appears in any response body.
  - k8s census: the app ServiceAccount's Role grants only `get/list` on `pods` and `get` on `pods/log`, never `secrets`, `configmaps` or wildcard verbs/resources; no workload under `carbon/k8s/base` sets a credential-looking env (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*_KEY`) as a literal `value:` (it must be `valueFrom`).
- [ ] **Step 3: Run them.** Expected: FAIL (traefik binds the socket; the app reaches `docker-socket-proxy`; inspect returns 200).
- [ ] **Step 4: Implement** the files above.
- [ ] **Step 5: Run them.** Expected: PASS. Then `pnpm test:unit` and the docker tier for the new test. Prove each census arm bites with a temporary edit (put `app` on the `socket-proxy` network; allow inspect) and record it.
- [ ] **Step 6: Commit** `fix(security): Traefik reaches Docker only through its proxy, and the app's proxy serves list and logs only`.

### Task 4: Each environment's app gets its own object-storage key where the provider can scope one (H2)

**Files:**
- Create:
  - `src/lib/deploy/app-storage-credential.js`;
  - `src/lib/deploy/hetzner-app-key-fence.js`;
  - `docs/research/2026-10-object-storage-key-scoping.md`: a copy of the spike file named under Spec. Strip any access-key fragments, keep the API shapes, results and cleanup record. It is the evidence R2 cites.
- Modify:
  - `src/lib/providers/s3-base.js`: the base class declares no `appKeyScoping`, so a missing declaration fails the census, the same pattern as `bucketSettleWindowMs`;
  - `src/lib/providers/{linode-objectstorage,digitalocean-spaces}.js`: `static appKeyScoping = 'mint'`, plus `mintAppKey(bucket)`, `revokeAppKey(id)` and `appKeyExists(id)`, using the exact API shapes in R2;
  - `src/lib/providers/hetzner-s3.js`: `static appKeyScoping = 'paste-fence'`, plus `ownerId()` read from ListBuckets `Owner.ID`;
  - `src/lib/providers/{scaleway-objectstorage,vultr-objectstorage}.js`: `static appKeyScoping = 'none'`, with a one-line comment giving the R2 reason;
  - `src/lib/deploy/orchestrator.js` `s3-setup`: resolve or mint the app credential after the env bucket is ensured (R9). Add the app-key `HeadBucket` readiness check to `startAppBucketFinalize`;
  - `src/lib/deploy/prompts.js` and `configure`: for `paste-fence` providers, an optional per-environment "app storage key" paste with console steps. It is skippable, and skipping means the `shared` tier;
  - `src/lib/deploy/app-runtime-env.js` (Task 1 seam `appStorageCredential`): carries the app pair. `bundle.js` and `k3s.js` need no other change;
  - `src/destroy.js`: revoke the env's minted key on every destroy (R9). For a pasted Hetzner key, print the console delete step and drop its principal from the fences;
  - `src/lib/destroy/preview.js`: name the key that will be revoked;
  - `src/status.js`: a row `storage access: isolated | fenced | shared (<reason>)`;
  - `docs/deploy-*.md`: the R4 residual risk per tier, and the Hetzner paste steps.
- Test:
  - `tests/unit/deploy/app-storage-credential.test.ts` (new);
  - `tests/unit/providers/app-key-scoping-census.test.ts` (new);
  - `tests/unit/deploy/hetzner-app-key-fence.test.ts` (new).

**Interfaces:**
- Consumes:
  - `resolveEnvStorage(envName, envConfig, projectConfig) -> { bucket, backupBucket, walgPrefix, bucketPin? }` (bucket branch);
  - `startAppBucketFinalize` (bucket branch);
  - the `appStorageCredential` seam, `buildAppRuntimeEnv` and `buildAppSecretData` (Task 1).
- Produces:
  - `resolveAppStorageCredential({ provider, environment, envConfig, projectConfig, bucket, infraCredential, secrets }) -> Promise<{ accessKey, secretKey, tier: 'isolated'|'fenced'|'shared', reason: string, record: { id, scoping, tier } | null }>`;
  - `revokeAppStorageCredential({ provider, envConfig }) -> Promise<{ revoked: boolean, leak?: string }>`;
  - `renderHetznerFencePolicy({ bucket, ownerId, deniedAccessKeyIds: string[] }) -> object`. It renders one Deny statement over `arn:aws:s3:::<bucket>` and `arn:aws:s3:::<bucket>/*`, with principals `arn:aws:iam:::user/<ownerId>:<id>`;
  - `fenceTargets({ projectConfig, environment }) -> { bucket: string, deniedAccessKeyIds: string[] }[]`. Every project bucket vibecarbon manages (state, backups, each env's app bucket) gets a policy denying every **other** environment's pasted app key. An env's own bucket never denies its own key.

- [ ] **Step 1: Write the failing tests.**
  - **Census:** every S3 provider class declares its own `appKeyScoping`, and the base class does not.
    - The values are `linode: 'mint'`, `digitalocean: 'mint'`, `hetzner: 'paste-fence'`, `scaleway: 'none'`, `vultr: 'none'`.
    - A `'mint'` value without an entry in the test's `APP_KEY_EVIDENCE` map (pointing at the research doc section) fails.
    - Prove each arm bites with a temporary edit.
  - **Never account-wide:** with a stubbed HTTP layer, the DO mint body is exactly `{ name, grants: [{ bucket: <env bucket>, permission: 'readwrite' }] }`, and the string `fullaccess` never appears in any request. The Linode body has exactly one `bucket_access` entry naming the env bucket with `read_write`.
  - **Separation invariant:** for `mint`, and for `paste-fence` with a pasted key, the pair rendered into `app.env` and the app k8s Secret is never the pair rendered for the db service (WAL-G) or the Pulumi backend. Use sentinel values.
  - **R9 lifecycle:**
    - A first deploy mints once and records `s3.appKey` with no secret in `.vibecarbon.json`. The secret is written through `formatDotenvLine`, keyed per env.
    - A redeploy with the secret present makes zero mint calls.
    - A redeploy with the secret missing locally mints a new key, records it, and revokes the old id.
    - A mint failure fails the deploy with one line naming the missing permission (for example the DO `spaces_key` scope), and there is no fallback to the infra key.
    - Plain destroy and `-purge` each revoke the minted key. A revoke failure produces a leak entry.
  - **Readiness:** the `HeadBucket` check with the app key runs inside the concurrent finalize task. With a fake whose first two `HeadBucket` calls fail and the third succeeds inside the bounded window, the deploy succeeds. The orchestrator source shows no serial await of it before IaC.
  - **Hetzner fence:**
    - `renderHetznerFencePolicy` gives exactly the R2 statement shape.
    - Review Focus 7: with prod (pasted key `AK_P`) and then staging (pasted key `AK_S`), `fenceTargets` gives the state and backups buckets `[AK_P, AK_S]`, prod's bucket `[AK_S]`, and staging's bucket `[AK_P]`.
    - Destroying staging removes `AK_S` from every remaining fence.
    - The fence is written once per changed bucket. Its verification probe passes only after `N = 3` consecutive denied app-key probes, within a fixed budget of 120 s, and an exhausted budget fails the deploy with the bucket name. It is a consistency gate like the settle gate, not a retry of the write.
    - Without a pasted key, no policy is written and the tier is `shared` with reason `hetzner: no app key pasted`.
  - **`none` providers:** `tier: 'shared'`, with a reason naming the provider and the R2 cause. Zero mint or policy calls.
  - **Status** prints the tier and reason for each of the three tiers.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/app-storage-credential.test.ts tests/unit/providers/app-key-scoping-census.test.ts tests/unit/deploy/hetzner-app-key-fence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per R2 and R9.
  - The app needs GetObject, PutObject, HeadObject, DeleteObject and ListBucket on its env bucket. DO `readwrite` and Linode `read_write` cover them.
  - CORS stays an infra-key operation done by the CLI. So do the settle-gate probes and bucket creation.
  - Write the research doc.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Real accounts (cents, no servers; covered by Brandon's 2026-10-20 approval for object-storage key tests).** Run a scripted mint, use, revoke round trip for Linode and DigitalOcean through `resolveAppStorageCredential` against a throwaway bucket. Do the same for a Hetzner fence round trip using the second console key in `tests/.env.e2e` (`HETZNER_ACCESS_KEY_2`/`HETZNER_SECRET_KEY_2`) if it still exists; skip it with a note if Brandon deleted it. Delete everything created and record that in the report.
- [ ] **Step 6: Commit** `feat(security): each environment's app gets its own object storage key where the provider can scope one`.

### Task 5: Request logs never contain auth tokens (M4)

**Files:**
- Create: `carbon/src/server/middleware/access-log.ts`.
- Modify: `carbon/src/server/index.ts` (drop `hono/logger`).
- Test: `carbon/tests/unit/server/access-log.test.ts` (new) and `carbon/tests/structural/no-hono-logger.test.ts` (new).

**Interfaces:**
- Produces: `accessLog(): MiddlewareHandler`. It logs through pino with `{ method, path: redactPath(url.pathname), status, ms }` and never includes the query string. `redactPath(pathname: string) -> string` replaces the segment after `/reset-password/` and `/verify-email/` (and any segment of 32 or more URL-safe characters) with `[redacted]`.

- [ ] **Step 1: Write the failing tests.** Feed these through the middleware with a captured pino destination:
  - `/api/auth/reset-password/T0K3NT0K3NT0K3NT0K3NT0K3NT0K3N12?callbackURL=x`
  - `/reset-password?token=T0K3N`
  - `/api/auth/magic-link/verify?token=T0K3N`
  - `/api/auth/callback/google?code=T0K3N&state=S`

  Assert the output never contains `T0K3N`. The structural test asserts no file under `carbon/src/server` imports `hono/logger`.
- [ ] **Step 2: Run** `cd carbon && npx vitest run tests/unit/server/access-log.test.ts tests/structural/no-hono-logger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd carbon && npm run test:prepush`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(template): access logs redact auth tokens and drop query strings`.

### Task 6: hostPorts bind specific interfaces (M5)

**Files:**
- Modify:
  - `src/lib/deploy/k8s/ha/index.js` `buildDbHostPortPatch`: `hostIP: '127.0.0.1'` (R6);
  - `carbon/k8s/base/registry/local-registry.yaml`: `hostIP: {{MASTER_PRIVATE_IP}}`, rendered where the manifest is applied in `k3s.js`;
  - `src/lib/deploy/registry-push.js`: the remote end of the tunnel becomes `<masterPrivateIp>:5000` (R5);
  - the comments that claim localhost or private binding.
- Test: `tests/unit/deploy/hostport-binding-census.test.ts` (new); update the `registry-push` and `ha` unit tests.

- [ ] **Step 1: Write the failing tests.**
  - Census: walk every YAML under `carbon/k8s/**` and `services/*/k8s/**`, plus the output of every exported `build*Patch` in `src/lib/deploy/k8s/**`. Every `hostPort` other than Traefik's 80/443 has a `hostIP` that is not empty and not `0.0.0.0`.
  - Unit: the push tunnel's ssh `-L` spec is `5000:<masterPrivateIp>:5000`.
  - Unit: the rendered registry manifest has `hostIP` equal to the deploy's master private IP, for both the Hetzner and DO shapes.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/hostport-binding-census.test.ts tests/unit/deploy/registry-push*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Real infra (needs Brandon's OK for spend):** `pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --minimal`. Expected: replication checks green (R6), and the image pull from the registry works (R5).
- [ ] **Step 6: Commit** `fix(k8s): bind the replication and registry hostPorts to loopback and the private network`.

### Task 7: Prometheus can reach the Kubernetes API; observability comments corrected (M6, I9)

**Files:**
- Modify: `services/observability/k8s/network-policy.yaml` (`prometheus-policy` egress adds `10.43.0.1/32:443` and `0.0.0.0/0:6443`, the same pair as `carbon/k8s/base/traefik/network-policy.yaml`). Rewrite the "service-role key" comments in `network-policy.yaml:96` and `grafana-deployment.yaml:73,81` to name what an app pod actually holds after Task 1.
- Test: `tests/unit/deploy/apiserver-egress-census.test.ts` (new).

- [ ] **Step 1: Write the failing census.** Parse every manifest under `carbon/k8s/**` and `services/*/k8s/**`. Every workload whose ServiceAccount is the subject of a RoleBinding or ClusterRoleBinding must be selected by a NetworkPolicy in its namespace whose egress admits TCP 6443 to `0.0.0.0/0` (or wider) and TCP 443 to `10.43.0.1/32`. The census also fails on any comment containing `service-role` under `carbon/k8s` and `services`.
- [ ] **Step 2: Run it.** Expected: FAIL on prometheus.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(observability): let Prometheus reach the Kubernetes API for service discovery`.

### Task 8: The MFA gate fails closed (L8)

**Files:**
- Modify: `carbon/src/server/lib/mfa-settings.ts` (`isMfaGloballyEnabled(): Promise<boolean|null>`, with `null` when unknown), `middleware/requireAal2.ts`, `routes/_internal/verify-role.ts` and `auth/assurance.ts` (treat `null` as enabled, R7).
- Test: `carbon/tests/unit/server/mfa-fail-closed.test.ts` (new).

- [ ] **Step 1: Write the failing tests.** With no cache and an `adminDb` select that throws:
  - `requireAal2` with an aal1 super admin session returns 403;
  - `verify-role` returns 401 or 403;
  - `assurance.ts`'s guard denies.

  With the cache warm and `false`, an aal1 session passes (the MFA-off behaviour is unchanged).
- [ ] **Step 2: Run** `cd carbon && npx vitest run tests/unit/server/mfa-fail-closed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd carbon && npm run test:prepush`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(template): an unreadable MFA setting fails the aal2 gate closed`.

### Task 9: WireGuard firewall rules follow the current peer on every provider (L7)

**Files:**
- Modify:
  - `src/lib/providers/base.js`: a shared `replaceWireguardPeerRules(rules, peerIp, shape)`, where each provider supplies only its rule shape;
  - `src/lib/providers/{digitalocean,linode,vultr,scaleway}.js` `buildReplicationFirewallRules`, routed through it;
  - `src/lib/deploy/compose/ha.js` `openWireguardPortUfw`: delete every other `51821/udp` allow before adding the peer.
- Test: `tests/unit/providers/wireguard-peer-rules-census.test.ts` (new).

- [ ] **Step 1: Write the failing census.**
  - For every registered provider, `buildReplicationFirewallRules(firewallWith(oldPeerWgRule), newPeerIp)` returns rules where no WireGuard rule names `oldPeer`, exactly one names `newPeer`, and every non-WireGuard rule is kept.
  - The UFW command sequence for a node whose `ufw status` lists an old peer includes `ufw delete allow from <old> to any port 51821 proto udp`.
- [ ] **Step 2: Run it.** Expected: FAIL for DO, Linode, Vultr, Scaleway and UFW.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(ha): WireGuard firewall rules follow the current peer on every provider`.

---

## Compatibility (goes in the PR body)

- Database: the app connects as `app_service`, and migrations run in `app-migrate` (compose) or an init container (k8s). Existing envs get `APP_DB_PASSWORD` from `upgrade`, and the role on their next deploy.

- compose: the app now reads `app.env`. A server deployed before this change gets it on the next deploy. Until then nothing changes.
- compose: a hand-customized `DB_USER` or `DB_NAME` in `.env` no longer reaches the app container. The defaults (`postgres`) are unchanged.
- k8s: `vibecarbon-secrets` becomes `vibecarbon-app-secrets` and `vibecarbon-infra-secrets`. The next deploy applies both and, after the app rollout, deletes the old `vibecarbon-secrets` Secret.
- GitOps: the deploy workflow builds the app Secret from a positive key list. A secret seeded for anything else no longer reaches the app pod.
- Object storage:
  - Linode and DigitalOcean envs get a minted app key, limited to the env's own bucket, on their next deploy (tier `isolated`). A DigitalOcean token with custom scopes needs `spaces_key` create/delete.
  - Hetzner envs keep the shared key unless the operator pastes a console-made app key in `vibecarbon configure`, which turns on the deny-fence (tier `fenced`).
  - Scaleway and Vultr stay `shared`.
  - `vibecarbon status` shows each env's tier and reason.
- Residual risk (R4): on the `shared` tier the app holds the account-wide key, so it can reach every env's uploads, the backups and the Pulumi state. On `fenced` (Hetzner) it can still list and create buckets and delete an empty fenced bucket.

## Verification

- Per task: the commands listed in that task, green, with red-then-green evidence.
- End of branch:
  - `pnpm lint && pnpm test:unit && pnpm test:integration`;
  - `DOCKER_INTEGRATION=true pnpm test:docker`;
  - `cd carbon && npm run test:prepush && npm run test:db`.
- Real infra (needs Brandon's OK):
  - `hetzner/compose`: the app env holds no provider token. Check with a `docker inspect` check that reports only the key names, never values.
  - `hetzner/k8s-ha --minimal` (Task 6).
