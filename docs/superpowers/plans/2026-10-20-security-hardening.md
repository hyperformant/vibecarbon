# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the nine deploy-path and security findings, plus the database-superuser finding (H10), from the 2026-10-20 architecture review. Every fix ships a census that covers its whole bug class, not just the one instance.

**Architecture:** The plan fixes four classes:
1. **Secrets reaching processes that don't need them.** Each process gets an explicit runtime env from one shared allowlist instead of the whole server `.env`. The app's object-storage key is split from the infra key wherever the provider can scope keys.
2. **Overlay merge drift.** The prod Traefik's socket mount is removed with `!override`, and a check on the rendered compose config pins it.
3. **Single-layer network exposure.** hostPorts are bound to specific interfaces, and NetworkPolicies give pods that call the Kubernetes API the egress they need.
4. **Fail-open gates and log leaks.** Request logs are redacted, the MFA check fails closed, and stale WireGuard firewall rules are removed.

**Tech Stack:** Node ESM CLI (`src/`), template app (Hono, Better Auth 1.7.10, pino) in `carbon/`, Docker Compose v5 (`docker compose config --format json` for rendered checks), k3s manifests, vitest.

**Spec:** the review report `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/arch-review/deploy-security.md`. It was re-verified on 2026-10-20 against `feat/project-app-bucket` @ 7de7f0d (see "Verification of findings" below). Stacks on branch `feat/project-app-bucket`.

## Verification of findings (done while planning)

All nine findings hold. None were dropped. Two were corrected or extended:

| # | Finding | Re-verification |
|---|---|---|
| C1 | The compose app gets the full cloud and DNS token | **Confirmed by render.** Base + prod with `HETZNER_API_TOKEN=SENTINELTOK` in `.env`: the sentinel appears in `app`'s environment (`carbon/docker-compose.yml:70-71` `env_file: .env`). Extended: on k8s the app's `envFrom: vibecarbon-secrets` (`carbon/k8s/base/app/deployment.yaml:58`) also carries `REPL_PASSWORD`, `METABASE_DB_PASSWORD` and `N8N_DB_PASSWORD` (`k3s.js` `INFRA_SECRET_KEYS`), which the app never reads. This is the same class, so it is fixed in Task 1. |
| H2 | The app's S3 key is the account-wide infra key | Confirmed (`bundle.js:354-358`, `k3s.js` `buildVibecarbonSecretData`, `iac/index.js:196`). **Corrected scope:** per-bucket keys can protect the backups and the Pulumi state from the app. They cannot separate environments inside the one shared app bucket, because no provider here supports per-prefix keys through its API. That gap stays as a stated residual risk (Task 5). |
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
- **R2. App and infra object-storage credentials are separate roles everywhere. Where they can be distinct keys depends on the provider, as measured below.**

  | Provider | How a key can be scoped (research, 2026-10-20) | Plan |
  |---|---|---|
  | Linode | Limited-access keys with `bucket_access` (read_only or read_write per bucket) can be **created through the API** ([Akamai: create a key](https://techdocs.akamai.com/linode-api/reference/post-object-storage-keys), [manage access keys](https://techdocs.akamai.com/cloud-computing/docs/manage-access-keys)). | Deploy mints a read_write key for the app bucket, using the Linode token already held. Destroy of the last env deletes it. |
  | Scaleway | IAM application, plus a policy with ObjectStorage permission sets, plus an API key for that application ([Scaleway IAM concepts](https://scaleway.com/en/docs/iam/concepts), [bucket policy](https://www.scaleway.com/en/docs/object-storage/api-cli/bucket-policy/)). Whether a policy can be scoped to **one bucket**, and whether our token has IAM write, is unconfirmed. | Task 4 spike. If confirmed, mint as for Linode. If not, treat as DigitalOcean. |
  | DigitalOcean | Per-bucket limited keys exist, but they **cannot be created through the API or CLI**, only in the control panel ([DO Spaces: manage access](https://docs.digitalocean.com/products/spaces/how-to/manage-access/index.html.md)). | `vibecarbon configure` offers an optional "app storage key" paste with instructions to create a limited key for the app bucket. Without it, the env runs at the shared tier. |
  | Hetzner | Every access key works on every bucket in its **Cloud project** ([Hetzner FAQ](https://docs.hetzner.com/de/storage/object-storage/faq/buckets-objects)). Bucket policies may restrict individual keys, but that is only reported second-hand ([blog](https://jsteuernagel.de/posts/hetzner-object-storage)), and keys cannot be created through the API. | Task 4 spike tests a bucket policy that denies a second key everything except the app bucket. If that works, `configure` offers the same paste as DigitalOcean, plus the policy, which deploy applies. If not, the documented isolation is an app bucket in a **separate Hetzner project** with its own key. |
  | Vultr | Keys are scoped to the **subscription** ([Vultr security guide](https://docs.vultr.com/platform/security-best-practices/vultr-object-storage)). No bucket scoping was found. | Shared tier only. The residual risk is stated in docs and in `status`. |

  - Cost if wrong: an env believed to be isolated is not. The Task 5 invariant test, plus `status` naming each env's tier, keep it visible.
- **R3. Backup immutability:** out of scope for this plan. Object lock or versioning on the backup bucket is a separate decision (cost, and how retention interacts with WAL-G deletes). Task 4's spike records whether each provider supports it, so the decision has data.
- **R4. Residual risk, said plainly.** Even at the best tier, environments of one project share the app bucket, so a compromised app in one env can read and write the other envs' uploads. The bucket-per-project design (`2026-10-20-project-app-bucket.md`) traded that isolation for not creating buckets on every redeploy. Getting it back means an app bucket per env (stable, created once per env), which a later plan can do. Task 5 states this in `docs/` and in the PR.
- **R5. Registry hostIP.** The registry binds the master's private IP (`hostIP: <masterPrivateIp>`, rendered at apply time like `registries.yaml`). The operator push tunnel then forwards to `<masterPrivateIp>:5000` instead of `localhost:5000` on the far side. The local end stays `localhost:5000`, so Docker's loopback insecure-registry rule still applies. Coordinate with `2026-10-20-cold-deploy-speed.md` and `2026-10-20-k8s-ha-registry-copy.md`, which also push to or relay from that registry, by naming the same `masterPrivateIp:5000` target.
- **R6. The db hostPort binds `127.0.0.1`.** `repl-gateway` already dials `127.0.0.1:5433`. A portmap DNAT from loopback needs `route_localnet`, which the CNI portmap plugin enables for its loopback hostIP case. The k8s-ha replication checks in e2e are the proof (Task 7 Step 5).
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

- No retry ladders. A failed security step fails the deploy with a one-line cause, except the DO and Hetzner app-key paste, which is optional (R2).
- No customers: no migration code. Old single-Secret k8s envs are re-applied on the next deploy (the k3s-apply inputs change). Ship with a Compatibility note and no `!:` footer.
- dotenv writes go only through `formatDotenvLine`. `app.env` is a new write site and gets added to `tests/unit/lib/dotenv-dialect-census.test.ts`.
- Never print secret values: not in logs, tests, the PR or census failure messages. Censuses use sentinels like `SENTINEL_<NAME>`.
- Traefik's public 80/443 are the only hostPorts without a hostIP.
- Conventional commits, pathspec commits, never `--no-verify`. Root uses pnpm; `carbon/` uses npm.
- Copy follows the CLI help voice: lowercase informational hints, no em dashes.

## Review Focus

1. **A configure-managed key added later** (for example a new billing provider's secret): the app must still receive it in compose and k8s with no hand edit. Test in Task 1 (census: every key the app reads is delivered).
2. **compose-ha and scale write the server `.env` through the same bundle:** both nodes, and a scaled-in server, get `app.env`. Test in Task 1.
3. **An add-on overlay that adds env to `app`** (redis adds `REDIS_URL`): it still reaches the app after `env_file: !override`. Test in Task 1, with the rendered config for base + prod + each add-on.
4. **The k8s push tunnel after R5:** a cold k8s deploy still pushes to the registry, and kubelets still pull. Test in Task 7 (unit test on the tunnel target), plus a real-infra k8s run.
5. **A table added by a later migration:** the app (`app_service`) can still read and write it, and server-only tables stay revoked from the add-on roles. Test in Task 2 (default privileges plus the revoke rerun).
6. **A transient database error on the first MFA read in a fresh process:** the aal2 gate refuses (403 or 503), never lets the request through. Test in Task 9.

---

### Task 1: The app gets only its own runtime keys (C1 and its k8s member)

**Files:**
- Create: `src/lib/deploy/app-runtime-env.js`.
- Modify: `src/lib/deploy/bundle.js` (write `app.env` beside `.env`), `carbon/docker-compose.prod.yml` (`app: env_file: !override [app.env]`), `src/lib/deploy/k8s/k3s.js` (`buildVibecarbonSecretData` splits into `buildAppSecretData` and `buildInfraSecretData`, and `applyK3sManifests` applies both), `carbon/k8s/base/app/deployment.yaml` (`envFrom: vibecarbon-app-secrets`), every manifest that reads `vibecarbon-secrets` by key (db statefulset, backup cronjob, add-ons; grep `vibecarbon-secrets`), `src/lib/deploy/k8s/gitops-deploy.js` if it builds the same Secret, and `tests/unit/lib/dotenv-dialect-census.test.ts` (allow the `app.env` writer).
- Test: `tests/unit/deploy/app-runtime-env-census.test.ts` (new), `tests/integration/docker/compose-secret-reach.test.ts` (new, rendered config).

**Interfaces:**
- Produces:
  - `APP_RUNTIME_KEYS: readonly string[]`.
  - `buildAppRuntimeEnv(envLocal: Record<string,string>, extras: Record<string,string>) -> Record<string,string>`, which keeps only `APP_RUNTIME_KEYS` plus the explicit `extras` (S3 app credentials, `S3_KEY_PREFIX`, `VC_ENV`, `REDIS_URL`).
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
- [ ] **Step 3: Implement** the files listed above. compose-ha ships the same bundle (verify `effects/compose-ha.js` uses `ctx.bundlePath`). Scale replays the old server `.env`, so make it also replay or regenerate `app.env`.
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

### Task 3: Prod Traefik uses only the socket proxy (H3)

**Files:**
- Modify: `carbon/docker-compose.prod.yml` traefik `volumes: !override` (the dynamic dir and `letsencrypt_data` only). Also restore the `--providers.docker.constraints=Label(...)` project-scoping flag that prod's `command:` drops (the same overlay-drift class).
- Test: extend `tests/integration/docker/compose-secret-reach.test.ts`, or add `compose-socket-reach.test.ts`.

- [ ] **Step 1: Write the failing test.** Over the same rendered matrix, assert:
  - the only services binding `/var/run/docker.sock` are `docker-socket-proxy`, and `promtail` when the observability overlay is present (it reads container logs; note it in the test with the reason);
  - Traefik's rendered command contains `--providers.docker.constraints=` and `--providers.docker.endpoint=tcp://docker-socket-proxy:2375`.
- [ ] **Step 2: Run it.** Expected: FAIL (traefik binds the socket).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS. Then run `pnpm test:unit`.
- [ ] **Step 5: Commit** `fix(security): production Traefik reaches Docker only through the socket proxy`.

### Task 4: Spike: what object-storage key scoping each provider really supports (input to Task 5)

**Needs Brandon's OK before Steps 2 and 3.** They create and delete test access keys, an IAM application and a test bucket in his provider accounts. No servers are created.

**Files:**
- Create: `docs/research/2026-10-object-storage-key-scoping.md`. It is committed and is the evidence Task 5 cites.

- [ ] **Step 1: Desk research** (context7 or the providers' API references through `gh`/web). For each provider, record:
  - can a key be scoped to one bucket?
  - can it be created through the API, and with which token scope?
  - can a key be scoped to a prefix?
  - does the provider support bucket policies, object lock or versioning?
- [ ] **Step 2: Linode and Scaleway, through the API.** Create a key limited to the test bucket, then show that a request with it to a second bucket gets `AccessDenied` and a request to the test bucket succeeds. For Scaleway, also check that the deploy token can create the IAM application and policy.
- [ ] **Step 3: Hetzner.** With a second key from the console, apply a bucket policy on the test bucket and show what it can deny:
  - (a) another bucket, as a deny on the backup bucket;
  - (b) a prefix.

  Record the exact policy JSON that worked, or the error.
- [ ] **Step 4: Write the decision table** into the research doc, updating R2's table cell by cell. Then delete every test key, application and bucket, and record that.
- [ ] **Step 5: Commit** `docs(research): object storage key scoping per provider`.

### Task 5: Separate app and infra object-storage credentials (H2)

**Files:**
- Create: `src/lib/deploy/app-storage-credential.js`.
- Modify:
  - `src/lib/providers/s3-base.js`: `static appKeyScoping: 'mint' | 'paste' | 'none'` on each S3 class, set from Task 4's table;
  - `src/lib/providers/{linode-objectstorage,scaleway-objectstorage}.js`: `mintAppKey(bucket)` and `revokeAppKey(id)`, as Task 4 confirmed;
  - `src/lib/deploy/prompts.js` and `configure` (the optional paste for `'paste'` providers);
  - `src/lib/deploy/bundle.js` and `k3s.js`: the app gets the app credential; WAL-G and the CLI keep the infra one;
  - `src/destroy.js`: revoke the minted key when the last env goes;
  - `src/status.js`: a row `storage access: isolated | shared (reason)`;
  - `docs/deploy-*.md`: the R4 residual risk and the per-provider steps.
- Test: `tests/unit/deploy/app-storage-credential.test.ts` (new) and `tests/unit/providers/app-key-scoping-census.test.ts` (new).

**Interfaces:**
- Consumes: `APP_RUNTIME_KEYS` and `buildAppRuntimeEnv` (Task 1); `resolveEnvStorage` (bucket branch).
- Produces: `resolveAppStorageCredential({ provider, envConfig, projectConfig, infraCredential }) -> { accessKey, secretKey, tier: 'isolated'|'shared', reason: string }`, persisted as `envConfig.s3.appKey` (id and tier only; the secret goes in `.env.local` through `formatDotenvLine`).

- [ ] **Step 1: Write the failing tests.**
  - Census: every S3 provider class declares its own `appKeyScoping`, and the base class does not.
  - Invariant: for `'mint'` and `'paste'`-with-a-key, the credential rendered into `app.env` and the app k8s Secret is never the one rendered for WAL-G (`.env` `S3_ACCESS_KEY` used by db) or for the Pulumi backend.
  - `'none'` gives `tier: 'shared'` with a reason naming the provider.
  - A mint failure fails the deploy with one line, with no fallback to the infra key.
  - Status prints the tier.
  - Destroy of the last env revokes a minted key; destroy of a non-last env does not.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/app-storage-credential.test.ts tests/unit/providers/app-key-scoping-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Task 4's table. The app needs GetObject, PutObject, HeadObject and ListBucket on the app bucket. CORS stays an infra-key operation done by the CLI.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(security): the app uses its own object storage key where the provider can scope one`.

### Task 6: Request logs never contain auth tokens (M4)

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

### Task 7: hostPorts bind specific interfaces (M5)

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

### Task 8: Prometheus can reach the Kubernetes API; observability comments corrected (M6, I9)

**Files:**
- Modify: `services/observability/k8s/network-policy.yaml` (`prometheus-policy` egress adds `10.43.0.1/32:443` and `0.0.0.0/0:6443`, the same pair as `carbon/k8s/base/traefik/network-policy.yaml`). Rewrite the "service-role key" comments in `network-policy.yaml:96` and `grafana-deployment.yaml:73,81` to name what an app pod actually holds after Task 1.
- Test: `tests/unit/deploy/apiserver-egress-census.test.ts` (new).

- [ ] **Step 1: Write the failing census.** Parse every manifest under `carbon/k8s/**` and `services/*/k8s/**`. Every workload whose ServiceAccount is the subject of a RoleBinding or ClusterRoleBinding must be selected by a NetworkPolicy in its namespace whose egress admits TCP 6443 to `0.0.0.0/0` (or wider) and TCP 443 to `10.43.0.1/32`. The census also fails on any comment containing `service-role` under `carbon/k8s` and `services`.
- [ ] **Step 2: Run it.** Expected: FAIL on prometheus.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(observability): let Prometheus reach the Kubernetes API for service discovery`.

### Task 9: The MFA gate fails closed (L8)

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

### Task 10: WireGuard firewall rules follow the current peer on every provider (L7)

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
- k8s: `vibecarbon-secrets` becomes two Secrets. The next deploy applies both, and the old Secret is deleted once nothing references it.
- Object storage: Linode (and Scaleway, if Task 4 confirms it) envs get a minted app key on their next deploy. DigitalOcean and Hetzner envs keep the shared key unless the operator pastes an app key in `vibecarbon configure`. Vultr stays shared. `vibecarbon status` shows which.
- Residual risk (R4): environments of one project share the app bucket, so an app in one env can read the others' uploads.

## Verification

- Per task: the commands listed in that task, green, with red-then-green evidence.
- End of branch:
  - `pnpm lint && pnpm test:unit && pnpm test:integration`;
  - `DOCKER_INTEGRATION=true pnpm test:docker`;
  - `cd carbon && npm run test:prepush && npm run test:db`.
- Real infra (needs Brandon's OK):
  - `hetzner/compose`: the app env holds no provider token. Check with a `docker inspect` check that reports only the key names, never values.
  - `hetzner/k8s-ha --minimal` (Task 7).
