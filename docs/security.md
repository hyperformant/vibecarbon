# Security Guide

Security rules for Vibecarbon contributors (human or AI) and operators.

**Part 1: Developer rules** defines the invariants every commit must uphold; `pnpm lint` enforces the mechanical subset and the named regression tests lock in the rest.

**Part 2: Operator procedures** covers secret rotation, access control, and incident response for production deployments.

---

## Part 1: Developer rules

### 1. Forbidden patterns

| Pattern | Why it's forbidden | What catches it |
|---|---|---|
| `` runCommand(`cmd ${x}`)`` / `` runCommandAsync(`cmd ${x}`)`` | Template-literal first arg means local shell interpretation of `x`. Even if `x` looks "safe today," one future caller passing a value with `` ` `` or `;` or `$()` is an injection. | `scripts/check-shell-safety.js` (pattern id `runCommand-template-literal`). Run via `pnpm lint:shell`; bundled into `pnpm lint`. |
| `child_process.exec(...)` / `execSync(...)` | Both parse a full shell string. Always route through `runCommand(argv)` (spawn/spawnSync, no shell) or `runShellScript(bashScript)` (SCP'd temp file). | `scripts/check-shell-safety.js` (per-file import analysis, pattern id `child_process-<name>`). |
| `execa(cmd, { shell: true })` | Re-enables the local shell that `execa`'s argv default disabled. | `scripts/check-shell-safety.js` (pattern id `execa-shell-true`). |
| `` `ssh ... "${var}"` `` (inline single-line shell-string SSH) | JS interpolates `var` into the ssh command line; any special char breaks out of the remote shell quote. Use `sshRun(ip, keyPath, argv)` or `sshRunScript` (both in `src/lib/ssh.js`). | `scripts/check-shell-safety.js` (pattern id `inline-ssh-shell-interp`). |
| `sshExec(ip, key, command)` | The deprecated string-form shim. Deleted in T14. Do not reintroduce. | Import will fail (symbol doesn't exist). `tests/unit/lib/ssh.test.ts` locks in the argv-only contract. |
| Any secret in argv | Anything on the command line is readable in `/proc/<pid>/cmdline`, `ps`, shell history, and CI logs. See §3. | `tests/unit/security/secrets-not-in-argv.test.ts` spies on `runCommand`/`runCommandAsync` during `push` and `deploy` and asserts no token/password ever appears as an argv element. |

**Per-match opt-out.** If a human reviewer has verified a specific call is safe (e.g., hardcoded literal + no dynamic data + no more suitable helper), place `// shell-safety-ignore: <reason>` on the same line or the line directly above. Keep reasons specific ("docker login username validated by Docker Hub regex"), never "legacy" or "refactor later."

### 2. `runCommand` / `sshRun` API contract

Every subprocess call goes through one of four helpers:

| Helper | Module | When to use |
|---|---|---|
| `runCommand(argv, opts)` | `src/lib/command.js` | Local subprocess, sync. `argv` must be an array of strings; strings are rejected at the type/runtime boundary (current code still wraps strings into `['sh','-c', str]` as a compatibility shim: treat this as deprecated and migrate call sites when touched). |
| `runCommandAsync(argv, opts)` | `src/lib/command.js` | Local subprocess, non-blocking (so spinners animate). Same argv contract. |
| `runShellScript(bashScript, opts)` | `src/lib/command.js` | When you genuinely need shell features (globs, `|`, `&&`, heredocs). Writes the script to a `mkdtempSync` file with mode 0700 and runs `bash <file>` via argv. Callers MUST inline literal values only or use `shEscape()` first. This helper does not escape. |
| `sshRun(ip, keyPath, argv, opts)` / `sshRunAsync` / `sshRunScript` | `src/lib/ssh.js` | Remote subprocess over SSH. `sshRun` accepts an argv array and passes it to ssh without local shell interpretation. `sshRunScript` SCPs a bash script to `/tmp/vb-script-<uuid>.sh` (mode 0700), executes it, deletes it. Both use per-env `known_hosts` pinning (accept-new on first-connect, strict thereafter). |

**For kubectl specifically**, use `sshKubectl(ip, keyPath, kubectlArgv)`: it prepends `env KUBECONFIG=... kubectl` and rejects string input. See `src/lib/ssh.js`.

**Rule of thumb.** Reach for argv first. Only use `runShellScript` / `sshRunScript` when the behaviour genuinely requires shell parsing (a pipeline, a glob, a heredoc). If you find yourself reaching for `runShellScript` to inject a variable, stop and use argv with a positional `sh -c 'script "$1"' _ value` pattern instead.

### 3. Credential handling

**Never put a secret in argv.** `/proc/<pid>/cmdline` is world-readable on Linux; `ps -ef` is world-readable on macOS; CI log lines are retained indefinitely; shell history is kept on every developer's laptop.

The approved channels, in order of preference:

1. **Environment variable**: `runCommand(argv, { env: { ...process.env, TOKEN: value } })`. Not visible in argv; reachable by the child only.
2. **Stdin**: `runCommand(argv, { silent: true, input: token })`. SSH forwards stdin to the remote command, so `ssh host some-cmd --from-stdin` with `input:` works through to the remote binary (e.g. `docker login --password-stdin`). This is how `dockerLoginOnServer` (`src/lib/deploy/compose/index.js`) ships the Docker Hub token.
3. **Temp file with mode 0600**: write the secret to `mkdtempSync(...)+'/name'` with `{ mode: 0o600 }`, pass the *path* via argv, delete in `finally`. This is how `kubectlCreateSecret` and `kubectlPatch` in `src/lib/deploy/k8s/index.js` handle secret YAML/JSON.

Same rules apply to environment names like `GITHUB_TOKEN` or `CLOUDFLARE_API_TOKEN`: never `-H "Authorization: Bearer ${token}"` in a `curl` call. Use Node's built-in `fetch()` (`k8s/index.js:1117` does this for the Hetzner API).

### 4. Template-placeholder escaping

One escaper per sink: `src/lib/shell.js` for shell, SQL and YAML; `src/lib/dotenv.js` for `.env` files. Match the sink to the helper (cross-sink escaping is unsafe):

| Sink | Helper | Notes |
|---|---|---|
| POSIX shell | `shEscape(value)` | Returns a single-quoted form, escaping `'` as `'\''`. Use for anything that lands in a shell command, including inside a bash script passed to `runShellScript`. Never for a `.env` line: Node, Docker Compose and Vite all read `'it'\''s'` as `it`. |
| `.env` / dotenv | `formatDotenvLine(key, value)` | Emits the one form Node `util.parseEnv`, Docker Compose and Vite all read identically (bare, `"…"` or `'…'`), and throws `DotenvValueError` (naming the key, never the value) for a value no such form can hold. Round-trip is covered by `tests/unit/security/dotenv-roundtrip.test.ts`. |
| PostgreSQL SQL literal | `escapeSql(value)` | Returns a single-quoted SQL literal (`'` doubled). **Only for static SQL templates.** Anything truly dynamic must use parameterised queries (`psql -v` or the driver's bind parameters), not this helper. |
| YAML / JSON | `escapeYaml(value)` | JSON-encodes the value. YAML is a JSON superset for primitives so the result parses as valid YAML. |

**When in doubt, the sink decides.** A value that flows into *both* a dotenv file and a kubectl YAML needs to go through `formatDotenvLine` at the dotenv write site and through `escapeYaml` at the YAML write site, independently. Trying to pick one escaper that covers both sinks gets you neither.

### 5. Gitignore invariants

`vibecarbon create` must produce a project whose `.gitignore` excludes, at minimum:

```
.vibecarbon/
.env
.env.local
.env.*.local
*.pem
*.key
```

`.vibecarbon/` holds the deploy SSH key, kubeconfigs, per-env `known_hosts`, and deployment-state metadata: anything with `.vibecarbon/` in its path is assumed sensitive. (Pulumi stack state lives in the project's Hetzner S3 bucket, not here.)

Enforcement:
- `src/create.js` asserts at startup that the bundled `.gitignore` contains these patterns; a missing pattern fails the CLI before it touches the filesystem.
- `tests/unit/security/gitignore-invariants.test.ts` asserts the same list against the generated project.
- Every `git add` call in `src/` uses an explicit allowlist rather than `git add .` (see `src/add.js` / `src/deploy.js` / `src/push.js`).

### 6. Operator-safety prompts

Destructive operations must require a type-to-confirm even when `-y` is passed:

| Command | Confirmation |
|---|---|
| `vibecarbon destroy prod` (or `production`) | Type the literal environment name. `-y` does *not* skip this. `tests/unit/security/destroy-prod-confirm.test.ts` locks the behaviour in. |
| `vibecarbon failover` | Pre-flight probe + explicit confirmation (split-brain prevention: see H-13 in the remediation spec). |
| `vibecarbon restore` on a prod env | Type-to-confirm before overwriting the production database. |

When adding a new destructive command, follow the `destroyEnv` pattern in `src/destroy.js` and add a regression test next to `destroy-prod-confirm.test.ts`.

---

## Part 2: Operator procedures

### Secret inventory

Vibecarbon uses several types of secrets. Rotate on the cadence below or immediately on suspected compromise.

**Application secrets** (`.env.local` + K8s Secret `vibecarbon-secrets`):

| Secret | Purpose | Rotation |
|---|---|---|
| `BETTER_AUTH_SECRET` | Signs the app's session cookies and auth tokens | Yearly or on compromise |
| `DB_PASSWORD` / `POSTGRES_PASSWORD` | PostgreSQL superuser (the app's connection role) | Yearly or on compromise |
| `METABASE_DB_PASSWORD` / `N8N_DB_PASSWORD` | The `metabase` and `n8n` roles' own database passwords, when the add-on is installed. Generated by `vibecarbon add`, added by `vibecarbon upgrade` if missing. Never the superuser's | Yearly or on compromise |
| `ADMIN_PASSWORD` | The first super admin's password, read at startup to create the account | Change it in the app after first sign-in |
| `REPL_PASSWORD` | HA replication auth (generated per-deploy from `crypto.randomBytes`) | Regenerated automatically on every `vibecarbon deploy` to a `compose-ha` or `k8s-ha` env |

**Infrastructure secrets**:

| Secret | Location | Rotation |
|---|---|---|
| `HETZNER_API_TOKEN` | `HCLOUD_TOKEN` env at deploy time (read by the Pulumi hcloud provider); also stored in the project's `.env.local` | Quarterly |
| `CLOUDFLARE_API_TOKEN` | Project `.env.local`; passed to Pulumi as plain config at deploy time | Quarterly |
| `REDIS_PASSWORD` | `.env.local`, K8s secret | Yearly |
| Docker Hub token | Operator-level env vars only (`DOCKER_HUB_USERNAME`/`DOCKER_HUB_TOKEN`), shell or CI. Never written to a project's `.env.local` | Per Docker Hub policy |
| GHCR token | Piped via stdin to `kubectl apply`, never stored in argv or committed | Per GitHub Actions policy |

**Third-party**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`. Rotate per each provider's recommendation.

### Rotation procedures

#### `BETTER_AUTH_SECRET` (high impact: everyone is signed out)

It signs the app's session cookies and auth tokens (email verification, password reset, magic links). Rotating it invalidates every session and every link already sent.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Update deployment:
   - Compose: update `.env.local`, then `vibecarbon deploy <env>` (the deploy ships the server `.env` and recreates the app).
   - Kubernetes: `vibecarbon deploy <env>` re-renders `vibecarbon-secrets` from `.env.local` and rolls the app; or recreate the Secret by hand (`kubectl create secret generic ... --dry-run=client -o yaml | kubectl apply -f -`, argv form on both halves) and `kubectl rollout restart deployment/app -n vibecarbon`.
3. Verify sign-in works and watch the app log for session errors.

#### `DB_PASSWORD`

`DB_PASSWORD` / `POSTGRES_PASSWORD` is the `postgres` superuser's password, and only the app and the db container use it. The add-ons have their own (next section), so rotating this one does not touch them.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64').replace(/[+/=]/g, 'x'))"`
2. Set it on the role with psql's `\password`, which sends a SCRAM verifier and never the password itself, so it cannot reach `pg_stat_activity`, the server log or pg_stat_statements. From the project directory on the server (Kubernetes: `kubectl exec -it -n vibecarbon <db-pod> -- psql -U postgres`):
   ```bash
   docker compose exec db psql -U postgres -c '\password postgres'
   ```
   It prompts for the new value twice. Avoid `ALTER ROLE ... PASSWORD '...'`: the literal travels in plain text, a superuser sees it in `pg_stat_activity` while it runs, and if the statement fails (a typo, or a quote in the password breaking the literal), the server log records the whole statement, literal included (`log_min_error_statement = error`), and with the observability add-on that log reaches Loki. If you must script it, run `SET log_min_error_statement = panic;` and `SET log_min_duration_statement = -1;` first in the same session (a slow statement is logged with its literal too), and read the value with psql's `\getenv pw MY_ENV_VAR` and `:'pw'` rather than `psql -v pw=...`, which puts it in the process list. The add-on init scripts do all three.
3. Update `DB_PASSWORD` / `POSTGRES_PASSWORD` in `.env.local` and `.env`, then `docker compose up -d` so the app is recreated with the new value (Kubernetes: update `vibecarbon-secrets` as above and `kubectl rollout restart deployment -n vibecarbon`).
4. Verify the app reconnects (`/api/health/ready`).

#### `METABASE_DB_PASSWORD` / `N8N_DB_PASSWORD`

Each add-on's role has its own password, so a leaked add-on credential is that role's reach only (below), never the superuser's.

1. Generate one as above.
2. Set it on the role: `docker compose exec db psql -U postgres -c '\password metabase'` (or `n8n`). Locally, `vibecarbon up` does this for you from `.env.local`: it reruns the add-on's init script on every start.
3. Update the key in `.env.local` and `.env`, then `docker compose up -d` so the add-on is recreated with it (Kubernetes: update `vibecarbon-secrets` and restart the add-on's Deployment).

#### `HETZNER_API_TOKEN`

1. Create a new token in the Hetzner Cloud Console.
2. Test: `curl -H "Authorization: Bearer NEW" https://api.hetzner.cloud/v1/servers`.
3. Update the token in the project's `.env.local` (or export `HCLOUD_TOKEN` for the deploy session).
4. `vibecarbon deploy <env>`: Pulumi `preview` runs first; expect no drift on the resource graph.
5. Revoke the old token in the console.

#### `REDIS_PASSWORD`

1. Generate (same command as `DB_PASSWORD`).
2. `CONFIG SET requirepass '…' && CONFIG REWRITE` inside the Redis container.
3. Update `REDIS_PASSWORD` / `REDIS_URL` in `.env.local`.
4. `docker compose restart app` (or `kubectl rollout restart deployment/app -n vibecarbon`).

### Access control

- **Database**: every table is RLS-protected by default. The server's `adminDb` handle bypasses RLS; only census-listed files may use it, and the database has no public port.
- **SSH / k8s API**: both ports are locked to a project-level operator-CIDR allowlist persisted in `.vibecarbon.json` under `operatorCidrs`. There is no default: a deploy with no CIDRs configured fails loudly rather than silently provisioning an open firewall. See [Operator-IP firewall lock](#operator-ip-firewall-lock-h-2) below.
- **Admin role**: the server-controlled `"user".role` column set to `super_admin`. Audit assignments quarterly.

#### Operator-IP firewall lock (H-2)

Every interactive vibecarbon command that needs SSH or k8s API access (`deploy`, `shell`, `diagnose`, `scale`, `failover`, `backup`, `restore`) auto-detects the operator's public IP, persists it under `operatorCidrs`, and patches the live Hetzner firewall via the Cloud API. Subsequent commands from the same IP are silent.

The list lives in `.vibecarbon.json`:

```json
{
  "operatorCidrs": [
    { "cidr": "1.2.3.4/32", "addedAt": "2026-04-28T18:30:00Z", "lastUsedAt": "2026-04-28T19:15:00Z" }
  ]
}
```

Manage the list with `vibecarbon access`:
- `vibecarbon access`: list current CIDRs
- `vibecarbon access add <cidr>`: add and push to the firewall
- `vibecarbon access remove <cidr>`: remove and push to the firewall
- `vibecarbon access prune`: drop entries with `lastUsedAt > 90d`

**CI / non-interactive (`-y`)**: auto-detect is suppressed (CI runners have ephemeral IPs that would pollute the list). Either bootstrap with `ALLOWED_SSH_IPS="1.2.3.4/32,5.6.7.8/32"` once, or commit a populated `operatorCidrs` to `.vibecarbon.json`.

**Lockout escape**: if you can't add your IP through the normal flow (no Hetzner API token, API unreachable), use `vibecarbon console <node>`: Hetzner's web VNC bypasses the firewall entirely. As a last resort, edit firewall rules in the Hetzner Cloud Console UI.

**Caveat on shared NATs**: an IP behind a corporate office, café, or mobile hotspot is technically shared with strangers: the `/32` is a brute-force-noise reduction, not auth. SSH still requires a valid key for connection establishment.

### Network security

- **Firewall defaults**: 22 (SSH) and 6443 (K8s API) locked to `operatorCidrs`. 80 (HTTP → HTTPS) and 443 (HTTPS) open to the internet.
- **NetworkPolicies** (K8s): default-deny, explicit service-to-service allowlists, DB reachable only from authorised services, egress restricted to HTTPS.
- **TLS**: Let's Encrypt certificates, auto-renewed 30 days before expiry.

### Database connections

The app is the database's only client on the public path. Each app replica
connects to Postgres **directly** on `db:5432` over the private network with
its own `pg` pool (`max: 10`, `carbon/src/server/db/client.ts`), with a 5 s
checkout timeout so an unreachable database fails `/api/health/ready`
promptly, and server-side statement and idle-transaction timeouts so a stuck
request cannot hold a connection indefinitely.

**Connection budget.** `db` runs with an explicit `max_connections=200`
(`carbon/docker-compose.yml`, `carbon/k8s/base/db/statefulset.yaml`): ten per
app replica, plus replication, the WAL-G backup, add-ons such as n8n or
Metabase when installed, and `superuser_reserved`, with plenty of room for
scale-ups.

**Add-ons connect as their own role, with their own password.** Metabase's
"Application Data" connection and n8n's `APP_DB_*` credential are driven by
whoever can use Metabase's SQL editor or edit an n8n workflow, so each
connects as its own role (`metabase`, `n8n`) with its own password
(`METABASE_DB_PASSWORD`, `N8N_DB_PASSWORD`), never as `postgres` and never
with the superuser's password. That second half matters as much as the
first: the db accepts password logins for any role from the compose network
(the app itself logs in as `postgres` over it), so an add-on that shared the
superuser's password would hand anyone who obtained it (an RCE in the add-on
container, which carries it in its env) a superuser login, `COPY ... TO
PROGRAM`, a shell in the db container and the backup bucket's keys.

The add-on's init script (`volumes/db/metabase-init.sh`,
`volumes/db/n8n-init.sh`) runs at the volume's first boot, and again on
every `vibecarbon up` in local development (a server never reruns it). It
makes its role `NOSUPERUSER BYPASSRLS`: it sees every business row,
`metabase` with SELECT only and `n8n` with SELECT, INSERT, UPDATE and DELETE,
including tables a later migration adds (default privileges). n8n's writes
reach tables that steer security, such as `app_settings` (`mfa_enabled`) and
`memberships.role`, so treat a workflow as trusted code.

Neither role can touch a server-only table: any public table with row-level
security on and no policies (the Better Auth tables `"user"`, `session`,
`account`, `verification` and `two_factor`, and `failed_login_attempts`),
because bypassing RLS would otherwise read straight through it.
`app.revoke_server_only_tables()` (`0002_baseline_post.sql`) derives that set
from the catalog and revokes it from every role but superusers and the
owner. The migration runner calls it after every run (every app start and
deploy), and the init scripts call it in the same transaction as their
grants, so the order they run in does not matter, and a no-policy table a
later migration adds is covered with nothing to write. Proven against a real
database by `carbon/tests/db/addon-init-grants.test.ts` and
`carbon/tests/db/server-only-tables.test.ts`.

**No public database port.** No firewall rule in any mode or provider opens
5432 or 6543 to the internet or to the operator CIDRs; `deploy` and `access`
remove any such rule an older deploy left behind. To run SQL, a migration
check or a BI query by hand, use `vibecarbon shell` (SSH to the server, then
`psql` inside the db container). The compose-ha replication port (5433)
travels only over the WireGuard tunnel between the two servers.

**Loopback trust inside the db container.** The db image keeps the official
Postgres `pg_hba.conf`: the local socket and `127.0.0.1`/`::1` are `trust`,
every other address needs `scram-sha-256`. Anything already running inside
the db container (on k8s, the db pod, which runs nothing else) is superuser
without a password; nothing outside it is. pg_cron, the WAL archive script
and the CLI's `docker compose exec db` / `kubectl exec statefulset/db` paths
(backups, audits, HA probes, restore) depend on it. Treat a shell in the db
container as database superuser, and never add a sidecar to the db pod.
Details and what tightening it would take: `docker/postgres-walg/README.md`.

### Incident response

**Suspected credential compromise**:
1. Revoke the credential immediately.
2. Rotate the affected secret (see procedures above).
3. Review access logs for unauthorised activity.

**Database breach**:
1. Rotate `DB_PASSWORD`.
2. Block external DB access if exposed.
3. Review `pg_stat_activity` and PostgreSQL logs.
4. Restore from backup if data was tampered with.
5. Notify affected users per legal requirements.

**Session secret exposure**:
- `BETTER_AUTH_SECRET`: rotate it (signs everyone out, see above). Audit the app log and the `session` table for sessions you did not expect.

### Pre-deployment checklist

- [ ] All secrets generated with cryptographically secure random (`crypto.randomBytes`).
- [ ] No secrets committed to git (`git log -p -- '.env*'` returns nothing).
- [ ] `.env.local` has mode 0600.
- [ ] Production secrets differ from development secrets.
- [ ] SSH and K8s API access restricted to known CIDRs.
- [ ] `pnpm lint` passes (shell-safety guard + biome).

### Post-deployment checklist

- [ ] HTTPS certificate valid.
- [ ] Rate limiting enabled.
- [ ] NetworkPolicies applied (K8s).
- [ ] Firewall rules verified.
- [ ] Admin dashboard reachable only over HTTPS.

### Quarterly review checklist

- [ ] Rotate infrastructure secrets.
- [ ] Audit super-admin user list.
- [ ] Check certificate expiration dates.
- [ ] Review access logs for anomalies.
- [ ] Update dependencies for security patches.

---

## Part 3: Application security controls (generated app)

### MFA assurance-level gating (aal2)

Destructive and financial API endpoints in the generated app require an `aal2`
(MFA-validated) session when MFA is enabled application-wide:

- `DELETE /api/v1/me`: account deletion
- `DELETE /api/v1/organizations/:orgId`: organization deletion
- `PATCH /api/v1/organizations/:orgId/members/:userId`: only when promoting a
  member to `OWNER` (ownership transfer)
- `POST /api/v1/billing/checkout`, `/portal`, `/setup`

The public, unauthenticated `POST /api/v1/billing/license-checkout` is **not**
gated by design (it has no session to elevate).

**Inert by default.** The gate activates only when `app_settings.mfa_enabled` is
`{ "enabled": true }` (seeded to `false`). While MFA is globally disabled the
gate is a no-op, so existing deployments are unaffected until an operator turns
MFA on.

**Client contract.** An `aal1` request to a gated endpoint receives:

```
403 { "error": "mfa_required", "current_aal": "aal1", "aal_required": "aal2" }
```

The body also carries `mfa_enrolled`. With an authenticator, the client
verifies a code from the same session (`POST /api/auth/two-factor/verify-totp`
or `/verify-backup-code`) and retries; without one, it enrolls first
(`POST /api/auth/two-factor/enable`). `apiFetch` in `src/client/lib/api.ts`
does this for every call: it asks the user for a code, or sends them to
enroll, then retries once. aal2 is a property of the session
(`session.twoFactorVerified`), read from the database on every request.
An impersonation session gets `403 impersonation_not_allowed` instead.

**Fail-open.** The global flag is read through `adminDb` and cached
for 60s. If the read fails, the gate falls back to the last-known value (or
inert) and logs a warning. Because this control is opt-in and defaults off,
failing open only restores pre-feature behavior, and a held `aal2` session is
always honored regardless. Flipping the toggle takes up to 60s to take effect.

Implementation: `carbon/src/server/middleware/requireAal2.ts`,
`carbon/src/server/lib/mfa-settings.ts`, `carbon/src/server/auth/assurance.ts`.

---

## Reference

- Shell-safety guard source: `scripts/check-shell-safety.js`.
- Escape helpers: `src/lib/shell.js`.
- SSH / kubectl helpers: `src/lib/ssh.js` and `src/lib/command.js`.
- Regression tests: `tests/unit/security/`.
- MFA aal2 gating (app-side tests): `carbon/tests/integration/server/{middleware/require-aal2,routes/billing-aal2,routes/v1-aal2}.test.ts`.
