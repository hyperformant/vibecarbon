# Security Guide

Security rules for Vibecarbon contributors (human or AI) and operators.

**Part 1 — Developer rules** defines the invariants every commit must uphold; `pnpm lint` enforces the mechanical subset and the named regression tests lock in the rest.

**Part 2 — Operator procedures** covers secret rotation, access control, and incident response for production deployments.

---

## Part 1 — Developer rules

### 1. Forbidden patterns

| Pattern | Why it's forbidden | What catches it |
|---|---|---|
| `` runCommand(`cmd ${x}`)`` / `` runCommandAsync(`cmd ${x}`)`` | Template-literal first arg means local shell interpretation of `x`. Even if `x` looks "safe today," one future caller passing a value with `` ` `` or `;` or `$()` is an injection. | `scripts/check-shell-safety.js` (pattern id `runCommand-template-literal`). Run via `pnpm lint:shell`; bundled into `pnpm lint`. |
| `child_process.exec(...)` / `execSync(...)` | Both parse a full shell string. Always route through `runCommand(argv)` (spawn/spawnSync, no shell) or `runShellScript(bashScript)` (SCP'd temp file). | `scripts/check-shell-safety.js` (per-file import analysis, pattern id `child_process-<name>`). |
| `execa(cmd, { shell: true })` | Re-enables the local shell that `execa`'s argv default disabled. | `scripts/check-shell-safety.js` (pattern id `execa-shell-true`). |
| `` `ssh ... "${var}"` `` (inline single-line shell-string SSH) | JS interpolates `var` into the ssh command line; any special char breaks out of the remote shell quote. Use `sshRun(ip, keyPath, argv)` or `sshRunScript` (both in `src/lib/ssh.js`). | `scripts/check-shell-safety.js` (pattern id `inline-ssh-shell-interp`). |
| `sshExec(ip, key, command)` | The deprecated string-form shim. Deleted in T14 — do not reintroduce. | Import will fail (symbol doesn't exist). `tests/unit/lib/ssh.test.ts` locks in the argv-only contract. |
| Any secret in argv | Anything on the command line is readable in `/proc/<pid>/cmdline`, `ps`, shell history, and CI logs. See §3. | `tests/unit/security/secrets-not-in-argv.test.ts` spies on `runCommand`/`runCommandAsync` during `push` and `deploy` and asserts no token/password ever appears as an argv element. |

**Per-match opt-out.** If a human reviewer has verified a specific call is safe (e.g., hardcoded literal + no dynamic data + no more suitable helper), place `// shell-safety-ignore: <reason>` on the same line or the line directly above. Keep reasons specific ("docker login username validated by Docker Hub regex") — never "legacy" or "refactor later."

### 2. `runCommand` / `sshRun` API contract

Every subprocess call goes through one of four helpers:

| Helper | Module | When to use |
|---|---|---|
| `runCommand(argv, opts)` | `src/lib/command.js` | Local subprocess, sync. `argv` must be an array of strings; strings are rejected at the type/runtime boundary (current code still wraps strings into `['sh','-c', str]` as a compatibility shim — treat this as deprecated and migrate call sites when touched). |
| `runCommandAsync(argv, opts)` | `src/lib/command.js` | Local subprocess, non-blocking (so spinners animate). Same argv contract. |
| `runShellScript(bashScript, opts)` | `src/lib/command.js` | When you genuinely need shell features (globs, `|`, `&&`, heredocs). Writes the script to a `mkdtempSync` file with mode 0700 and runs `bash <file>` via argv. Callers MUST inline literal values only or use `shEscape()` first — this helper does not escape. |
| `sshRun(ip, keyPath, argv, opts)` / `sshRunAsync` / `sshRunScript` | `src/lib/ssh.js` | Remote subprocess over SSH. `sshRun` accepts an argv array and passes it to ssh without local shell interpretation. `sshRunScript` SCPs a bash script to `/tmp/vb-script-<uuid>.sh` (mode 0700), executes it, deletes it. Both use per-env `known_hosts` pinning (accept-new on first-connect, strict thereafter). |

**For kubectl specifically**, use `sshKubectl(ip, keyPath, kubectlArgv)` — it prepends `env KUBECONFIG=... kubectl` and rejects string input. See `src/lib/ssh.js`.

**Rule of thumb.** Reach for argv first. Only use `runShellScript` / `sshRunScript` when the behaviour genuinely requires shell parsing (a pipeline, a glob, a heredoc). If you find yourself reaching for `runShellScript` to inject a variable, stop and use argv with a positional `sh -c 'script "$1"' _ value` pattern instead.

### 3. Credential handling

**Never put a secret in argv.** `/proc/<pid>/cmdline` is world-readable on Linux; `ps -ef` is world-readable on macOS; CI log lines are retained indefinitely; shell history is kept on every developer's laptop.

The approved channels, in order of preference:

1. **Environment variable** — `runCommand(argv, { env: { ...process.env, TOKEN: value } })`. Not visible in argv; reachable by the child only.
2. **Stdin** — `runCommand(argv, { silent: true, input: token })`. SSH forwards stdin to the remote command, so `ssh host some-cmd --from-stdin` with `input:` works through to the remote binary (e.g. `docker login --password-stdin`). This is how `dockerLoginOnServer` (`src/lib/deploy/compose/index.js`) ships the Docker Hub token.
3. **Temp file with mode 0600** — write the secret to `mkdtempSync(...)+'/name'` with `{ mode: 0o600 }`, pass the *path* via argv, delete in `finally`. This is how `kubectlCreateSecret` and `kubectlPatch` in `src/lib/deploy/k8s/index.js` handle secret YAML/JSON.

Same rules apply to environment names like `GITHUB_TOKEN` or `CLOUDFLARE_API_TOKEN`: never `-H "Authorization: Bearer ${token}"` in a `curl` call — use Node's built-in `fetch()` (`k8s/index.js:1117` does this for the Hetzner API).

### 4. Template-placeholder escaping

`src/lib/shell.js` exposes one escaper per sink. Match the sink to the helper — cross-sink escaping is unsafe:

| Sink | Helper | Notes |
|---|---|---|
| POSIX shell | `shEscape(value)` | Returns a single-quoted form, escaping `'` as `'\''`. Use for anything that lands in a shell command, including inside a bash script passed to `runShellScript`. |
| `.env` / dotenv | `escapeDotenv(value)` | Returns the single-quoted dotenv form. Round-trip is covered by `tests/unit/security/dotenv-roundtrip.test.ts`. |
| PostgreSQL SQL literal | `escapeSql(value)` | Returns a single-quoted SQL literal (`'` doubled). **Only for static SQL templates.** Anything truly dynamic must use parameterised queries (`psql -v` or the driver's bind parameters) — not this helper. |
| YAML / JSON | `escapeYaml(value)` | JSON-encodes the value. YAML is a JSON superset for primitives so the result parses as valid YAML. |

**When in doubt, the sink decides.** A value that flows into *both* a dotenv file and a kubectl YAML needs to go through `escapeDotenv` at the dotenv write site and through `escapeYaml` at the YAML write site — independently. Trying to pick one escaper that covers both sinks gets you neither.

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

`.vibecarbon/` holds the deploy SSH key, kubeconfigs, per-env `known_hosts`, and deployment-state metadata — anything with `.vibecarbon/` in its path is assumed sensitive. (Pulumi stack state lives in the project's Hetzner S3 bucket, not here.)

Enforcement:
- `src/create.js` asserts at startup that the bundled `.gitignore` contains these patterns; a missing pattern fails the CLI before it touches the filesystem.
- `tests/unit/security/gitignore-invariants.test.ts` asserts the same list against the generated project.
- Every `git add` call in `src/` uses an explicit allowlist rather than `git add .` — see `src/add.js` / `src/deploy.js` / `src/push.js`.

### 6. Operator-safety prompts

Destructive operations must require a type-to-confirm even when `-y` is passed:

| Command | Confirmation |
|---|---|
| `vibecarbon destroy prod` (or `production`) | Type the literal environment name. `-y` does *not* skip this — `tests/unit/security/destroy-prod-confirm.test.ts` locks the behaviour in. |
| `vibecarbon failover` | Pre-flight probe + explicit confirmation (split-brain prevention — see H-13 in the remediation spec). |
| `vibecarbon restore` on a prod env | Type-to-confirm before overwriting the production database. |

When adding a new destructive command, follow the `destroyEnv` pattern in `src/destroy.js` and add a regression test next to `destroy-prod-confirm.test.ts`.

---

## Part 2 — Operator procedures

### Secret inventory

Vibecarbon uses several types of secrets. Rotate on the cadence below or immediately on suspected compromise.

**Application secrets** (`.env.local` + K8s Secret `vibecarbon-secrets`):

| Secret | Purpose | Rotation |
|---|---|---|
| `JWT_SECRET` | Signs Supabase JWTs | Yearly or on compromise |
| `DB_PASSWORD` | PostgreSQL superuser | Yearly or on compromise |
| `ANON_KEY` | Public API key (derived from `JWT_SECRET`) | When `JWT_SECRET` rotates |
| `SERVICE_ROLE_KEY` | Server-side API key (bypasses RLS) | When `JWT_SECRET` rotates |
| `REALTIME_SECRET` | Realtime service encryption | Yearly |
| `VAULT_ENC_KEY` | Vault encryption key | Yearly |
| `REPL_PASSWORD` | HA replication auth (generated per-deploy from `crypto.randomBytes`) | Regenerated automatically on every `vibecarbon deploy` to a `compose-ha` or `k8s-ha` env |

**Infrastructure secrets**:

| Secret | Location | Rotation |
|---|---|---|
| `HETZNER_API_TOKEN` | `HCLOUD_TOKEN` env at deploy time (read by the Pulumi hcloud provider); also stored in the project's `.env.local` | Quarterly |
| `CLOUDFLARE_API_TOKEN` | Project `.env.local`; passed to Pulumi as plain config at deploy time | Quarterly |
| `REDIS_PASSWORD` | `.env.local`, K8s secret | Yearly |
| Docker Hub token | Operator-level env vars only (`DOCKER_HUB_USERNAME`/`DOCKER_HUB_TOKEN`), shell or CI — never written to a project's `.env.local` | Per Docker Hub policy |
| GHCR token | Piped via stdin to `kubectl apply` — never stored in argv or committed | Per GitHub Actions policy |

**Third-party**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` — rotate per each provider's recommendation.

### Rotation procedures

#### `JWT_SECRET` (high impact — all sessions invalidated)

1. Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"`
2. Re-derive `ANON_KEY` and `SERVICE_ROLE_KEY` with the new secret (a 10-year-expiring JWT signed with `role: 'anon'` / `role: 'service_role'`).
3. Update deployment:
   - Compose: update `.env.local`, then `docker compose down && docker compose up -d`.
   - Kubernetes: recreate the `vibecarbon-secrets` Secret (`kubectl create secret generic ... --dry-run=client -o yaml | kubectl apply -f -` — argv form on both halves) and `kubectl rollout restart deployment -n vibecarbon`.
4. Rebuild the frontend with the new `VITE_SUPABASE_ANON_KEY` and redeploy.
5. Verify auth works and watch error logs for JWT validation failures.

#### `DB_PASSWORD`

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64').replace(/[+/=]/g, 'x'))"`
2. `ALTER USER postgres WITH PASSWORD '…'` for each Supabase role (`postgres`, `supabase_admin`, `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`).
3. Update `DB_PASSWORD` / `POSTGRES_PASSWORD` in `.env.local` and restart services.
4. Verify every service reconnects.

#### `HETZNER_API_TOKEN`

1. Create a new token in the Hetzner Cloud Console.
2. Test: `curl -H "Authorization: Bearer NEW" https://api.hetzner.cloud/v1/servers`.
3. Update the token in the project's `.env.local` (or export `HCLOUD_TOKEN` for the deploy session).
4. `vibecarbon deploy <env>` — Pulumi `preview` runs first; expect no drift on the resource graph.
5. Revoke the old token in the console.

#### `REDIS_PASSWORD`

1. Generate (same command as `DB_PASSWORD`).
2. `CONFIG SET requirepass '…' && CONFIG REWRITE` inside the Redis container.
3. Update `REDIS_PASSWORD` / `REDIS_URL` in `.env.local`.
4. `docker compose restart app` (or `kubectl rollout restart deployment/app -n vibecarbon`).

### Access control

- **Database** — every table is RLS-protected by default. The `service_role` key bypasses RLS and must never leak to clients.
- **SSH / k8s API** — both ports are locked to a project-level operator-CIDR allowlist persisted in `.vibecarbon.json` under `operatorCidrs`. There is no default — a deploy with no CIDRs configured fails loudly rather than silently provisioning an open firewall. See [Operator-IP firewall lock](#operator-ip-firewall-lock-h-2) below.
- **Admin role** — assigned via `app_metadata.role = 'super_admin'`. Audit assignments quarterly.

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
- `vibecarbon access` — list current CIDRs
- `vibecarbon access add <cidr>` — add and push to the firewall
- `vibecarbon access remove <cidr>` — remove and push to the firewall
- `vibecarbon access prune` — drop entries with `lastUsedAt > 90d`

**CI / non-interactive (`-y`)**: auto-detect is suppressed (CI runners have ephemeral IPs that would pollute the list). Either bootstrap with `ALLOWED_SSH_IPS="1.2.3.4/32,5.6.7.8/32"` once, or commit a populated `operatorCidrs` to `.vibecarbon.json`.

**Lockout escape**: if you can't add your IP through the normal flow (no Hetzner API token, API unreachable), use `vibecarbon console <node>` — Hetzner's web VNC bypasses the firewall entirely. As a last resort, edit firewall rules in the Hetzner Cloud Console UI.

**Caveat on shared NATs**: an IP behind a corporate office, café, or mobile hotspot is technically shared with strangers — the `/32` is a brute-force-noise reduction, not auth. SSH still requires a valid key for connection establishment.

### Network security

- **Firewall defaults**: 22 (SSH) and 6443 (K8s API) locked to `operatorCidrs`. 80 (HTTP → HTTPS) and 443 (HTTPS) open to the internet.
- **NetworkPolicies** (K8s): default-deny, explicit service-to-service allowlists, DB reachable only from authorised services, egress restricted to HTTPS.
- **TLS**: Let's Encrypt certificates, auto-renewed 30 days before expiry.

### Database connection pooling

The internal Supabase stack (`auth`, `rest`, `realtime`, `storage`, `meta`)
connects to Postgres **directly** on `db:5432` — required, because a
transaction pooler breaks realtime's replication slot, PostgREST's
`NOTIFY pgrst 'reload schema'`, and migration advisory locks.

**Connection budget.** `db` runs with an explicit `max_connections=200`
(`carbon/docker-compose.yml`). The real consumers (PostgREST pool + auth +
storage + realtime + meta + Supavisor's server pool + replication +
`superuser_reserved`) sum to ~65, leaving headroom for the HA standby and
scale-ups. PostgREST's own pool is capped explicitly (`PGRST_DB_POOL`) with a
fail-fast acquisition timeout so a saturated pool errors clearly instead of
hanging.

**Supavisor (external pooler).** Provisioned in `docker-compose.prod.yml` for
**external** direct-DB clients (BI tools, scripts, serverless) — not the
internal stack. Session mode on `:5432`, transaction mode on `:6543`
(Supavisor's defaults, pinned explicitly via `PROXY_PORT_SESSION` /
`PROXY_PORT_TRANSACTION` so config and docs can't drift); the client username
carries the tenant id (`postgres.<PROJECT_NAME>`). The cloud firewall scopes
both ports to the operator CIDR allowlist (same list as SSH; managed by
`vibecarbon access`) — they are never world-open, and `access
add/remove/prune` rewrites the pooler rules in lockstep with the SSH rule. Its `VAULT_ENC_KEY` and
`REALTIME_SECRET` are auto-generated into `.env.local` by `vibecarbon create`
(like `JWT_SECRET`), and the prod overlay requires them with `${VAR:?}` syntax
— a missing secret aborts `docker compose` loudly instead of booting a service
on a blank value. A structural test (`tests/structural/supavisor-config.test.ts`
in the template) pins the port/mode mapping and the fail-closed requirement.
The pooler is exercised end-to-end by the compose e2e scenario
(`supavisor_*` verification checks: tenant-routed queries through both pooler
modes from inside the rig, plus external dials proving the operator-scoped
firewall path).

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

**API key exposure**:
- `SERVICE_ROLE_KEY` — rotate `JWT_SECRET` (invalidates all keys). Audit API logs.
- `ANON_KEY` — low severity (public by design); verify RLS policies are correct and monitor for abuse.

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

## Part 3 — Application security controls (generated app)

### MFA assurance-level gating (aal2)

Destructive and financial API endpoints in the generated app require an `aal2`
(MFA-validated) Supabase session when MFA is enabled application-wide:

- `DELETE /api/v1/me` — account deletion
- `DELETE /api/v1/organizations/:orgId` — organization deletion
- `PATCH /api/v1/organizations/:orgId/members/:userId` — only when promoting a
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

The client elevates via the Supabase MFA SDK (`auth.mfa.listFactors()`, then
challenge/verify) and retries with the elevated token.

**Fail-open.** The global flag is read via the service-role client and cached
for 60s. If the read fails, the gate falls back to the last-known value (or
inert) and logs a warning — because this control is opt-in and defaults off,
failing open only restores pre-feature behavior, and a held `aal2` session is
always honored regardless. Flipping the toggle takes up to 60s to take effect.

Implementation: `carbon/src/server/middleware/requireAal2.ts`,
`carbon/src/server/lib/mfa-settings.ts`, `carbon/src/server/lib/jwt.ts`.

---

## Reference

- Shell-safety guard source: `scripts/check-shell-safety.js`.
- Escape helpers: `src/lib/shell.js`.
- SSH / kubectl helpers: `src/lib/ssh.js` and `src/lib/command.js`.
- Regression tests: `tests/unit/security/`.
- MFA aal2 gating — app-side tests: `carbon/tests/integration/server/{middleware/require-aal2,routes/billing-aal2,routes/v1-aal2}.test.ts`.
