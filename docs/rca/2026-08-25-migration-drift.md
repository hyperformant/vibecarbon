# RCA: prod deploy failed applying migrations the repo never had (2026-08-25)

## Incident

`vibecarbon deploy` (vibecarbon.com, compose/Hetzner) failed at
`run-migrations`:

```
ERROR:  schema "cron" does not exist
[migrate] FAILED applying 00008_crawler_hits.sql
```

`00008_crawler_hits.sql` (AI Visibility feature) depends on pg_cron and
`public.log_cron_job()` from template migration `00003_pg_cron.sql` — which,
along with `00002_theme_settings` and `00004`–`00007`, had never reached the
project: its `supabase/migrations/` held only `00001_init.sql` and a local
`00002_purchases.sql`. The failure also left `00008` **partially applied**
(its tables and policies were created; the `cron.schedule` calls were not),
because the runner applied statements without a transaction.

## Impact

- One failed prod deploy; app image was already reconciled, so the site stayed
  up on the new code. Crawler tracking worked (its table existed); the nightly
  rollup/prune jobs did not.
- Latent, worse than the incident: the shipped code referenced schema
  (`cron_job_history`, contact/newsletter tables, theme/docs-visibility
  settings) that the repo's migrations never created. Any fresh restore or
  re-provision from the repo would have produced a database missing objects
  the app requires.

## Root-cause chain

1. **Schema delivery has no path to existing projects (structural).**
   `supabase/**` is in `NEVER_PATTERNS` (`src/lib/upgrade-policy.js`), so
   `vibecarbon upgrade` never delivers new template migrations. Correct for
   *existing* files (user schema is user code); wrong for template migrations
   the project has never seen — those are pure additions.
2. **Hand-mirroring is partial by nature.** vibecarbon-web's `src/` tracks the
   template via mirror commits, but nobody mirrors `supabase/migrations/` —
   code and schema advanced independently for six template migrations, and
   nothing detects the divergence.
3. **No dependency preflight.** The runner applies whatever files exist in
   filename order; a migration whose dependencies are absent fails at apply
   time, in prod, as the first signal.
4. **Non-atomic application.** Each file streamed to psql with
   `ON_ERROR_STOP=1` but no transaction — a mid-file failure leaves partial
   schema. Idempotency-by-convention (IF NOT EXISTS etc.) limited the damage,
   but that is a convention, not a guarantee.

## What limited the damage

- Migrations are written idempotent (the runner re-applies every file on
  every deploy), so the partial `00008` state was resumable, not corrupt.
- The runner fails loudly and aborts the deploy (deliberate: a silent empty
  schema is worse than a visible failure) — the gap was found on deploy, not
  in an incident weeks later.

## Actions

**Done (this incident):**

- vibecarbon-web `5ce1c39`: back-filled template migrations `00002_theme` –
  `00007` (all idempotent; verified no filename collision with the local
  `00002_purchases.sql`). Deploy unblocked.
- All three migration runners now pass `--single-transaction` so each
  migration file is atomic: compose deploy
  (`src/lib/deploy/compose/index.js`), k8s deploy
  (`src/lib/deploy/k8s/k3s.js` `applyMigrations`), local dev
  (`carbon/scripts/db-migrate.js`). Pinned by unit tests. Constraint this
  imposes on migration authors: no statements that refuse to run in a
  transaction (`CREATE INDEX CONCURRENTLY`, `ALTER SYSTEM`, `VACUUM`) —
  none exist in the template's migrations today.

**Queued (the hardening this class deserves, in priority order):**

1. **`vibecarbon upgrade` delivers missing template migrations** — refine
   `supabase/migrations/**` from `never` to add-only: offer template
   migration files the project lacks (never modify or overwrite ones it has,
   never touch non-template files). Kills the whole class for every
   generated project.
2. **Migration gap detection in `status` and the deploy summary** — the CLI
   knows `templateVersion`; comparing template migration filenames against
   the project's is one readdir. Surface "template has N migrations this
   project lacks" before the deploy applies anything.
3. **Applied-migrations ledger** — a `schema_migrations` table (filename,
   sha256, applied_at) written by the runner: makes application exact
   instead of idempotency-by-convention, detects post-application file
   edits, and gives `status` ground truth about the live DB.
4. **CI apply-gate** — the template job already builds a generated project;
   applying its migrations against a throwaway Postgres from the template's
   own db image (the recipe used to validate `00008` pre-commit) would catch
   dependency breaks before any deploy.
