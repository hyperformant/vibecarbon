# Self-documenting CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every command's `SPEC` becomes the single source for help output and command/flag documentation. The top-level help, the `cli.mdx` flag tables, the README Commands tables and the AGENTS.md command block are generated from it, and a test makes drift unmergeable. Context-sensitive CLI messages become a written standard.

**Architecture:** A command registry (`src/lib/cli/command-registry.js`) lists every dispatched command with its category, usage line, and a loader for its `SPEC`. `src/cli.js`'s top-level help renders from the registry. `scripts/gen-cli-docs.js` (`pnpm docs:cli`) rewrites only marker-delimited regions in `carbon/content/docs/cli.mdx`, `README.md` and `AGENTS.md`. A unit test regenerates every region in memory and fails with "run `pnpm docs:cli`" on any difference. Hand-written prose outside the markers is never touched.

**Tech Stack:** Node ESM, vitest, existing `CommandSpec` (`src/lib/cli/parse-flags.js`) and help renderer (`src/lib/cli/help.js`).

**Spec:** No separate spec file. The design was agreed in conversation on 2026-10-13 (core project only). Background + Global Constraints below are the spec.

## Background

- Per-command `-h` is already generated from each command's `SPEC`.
- Everything else is hand-maintained and drifts:
  - the top-level `vibecarbon -h` list (`showHelp()` in `src/cli.js`);
  - the `cli.mdx` flag tables (only `deploy` has a flag census: `tests/unit/docs/deploy-flags-docs-census.test.ts`);
  - the README Commands tables;
  - the AGENTS.md "CLI Commands" block.
- On 2026-10-12, `vibecarbon down -orphans` shipped with `-h` correct, but no `cli.mdx` mention. Only README and AGENTS.md had it, and only because they were edited by hand.
- `tests/unit/docs/cli-docs-census.test.ts` checks command-level coverage and licensing statements in `cli.mdx`. It stays.
- `telemetry` has no `SPEC`. `add` builds its spec in `buildSpec()`. `activate.js` holds both `ACTIVATE_SPEC` and `DEACTIVATE_SPEC`. Several command modules don't export their `SPEC`.

## Global Constraints

- Flags are single-dash only. Help and docs render `-name`, never `--name`.
- User-facing strings: friendly second person, say why, lowercase informational hints, **no em dashes**, no emoji.
- `SPEC` is the only place a flag's name, value placeholder and description are written. Generated regions are never edited by hand.
- Marker format. Markdown: `<!-- BEGIN GENERATED: <id> -->` … `<!-- END GENERATED: <id> -->`. MDX: `{/* BEGIN GENERATED: <id> */}` … `{/* END GENERATED: <id> */}`. Content outside markers is byte-for-byte untouched.
- The generator is deterministic: same input, byte-identical output. No timestamps. Stable ordering (registry order for commands, `SPEC.flags` order for flags).
- The universal flags `-h` and `-v` appear once in a shared "Global flags" note. They are not repeated in every per-command table.
- Commit with pathspecs on the shared checkout. Conventional commits (`feat(cli):`, `docs(cli):`, `test:`). Never `!:` or BREAKING CHANGE. Gate: `pnpm test:prepush`.

## Review Focus

1. **A command whose `SPEC` is built at runtime** (`add` lists features dynamically): the registry loader must produce the same flags `-h` shows. Pinned in Task 1.
2. **Hand-written prose inside `cli.mdx`** (examples, licensing tables) must survive regeneration byte-for-byte. Pinned in Task 3 (round-trip test on a fixture with prose on both sides of the markers).
3. **A new command added to `cli.js`'s switch but not the registry** must fail a test, not silently vanish from help and docs. Pinned in Task 1.
4. **A flag with no `description`** must fail, because a blank row in help or docs is undocumented. Pinned in Task 1.
5. **Top-level help still fits an 80-column terminal** with the same group headings (Dev, Deploy, Debug, License). Pinned in Task 2.

---

### Task 1: Command registry; every command exports a complete SPEC

**Files:**
- Create: `src/lib/cli/command-registry.js`
- Modify: every command module whose `SPEC` isn't exported (`up.js`, `down.js`, `reset.js`, `configure.js`, `shell.js`, `diagnose.js`, `console.js`, `access.js`, `activate.js`); `add.js` (export `buildSpec`); `telemetry.js` (add a `SPEC` and use `parseFlagsOrExit` for `-h`, keeping its `on|off|status` behavior)
- Test: `tests/unit/cli/command-registry.test.ts`

**Interfaces:**
- Produces: `COMMANDS: Array<{ name: string, aliases?: string[], category: 'dev' | 'deploy' | 'debug' | 'license', usage: string, loadSpec: () => Promise<CommandSpec> }>`, in display order. `usage` is the argument hint shown after the name, e.g. `'<project-name>'`, `'[env]'`, `''`. `next` has `aliases: ['?']`.
- Produces: `loadAllSpecs(): Promise<Array<{ entry, spec }>>`.

Category and order come from today's `showHelp()` groups:
- **Dev:** `next` (alias `?`), `create`, `up`, `down`, `status`, `reset`, `add`, `remove`, `configure`, `upgrade`, `telemetry`
- **Deploy:** `deploy`, `destroy`, `backup`, `restore`, `failover`, `scale`
- **Debug:** `shell`, `diagnose`, `console`, `access`
- **License:** `activate`, `deactivate`

Usage strings come from today's help text. Summaries are NOT in the registry; they come from `SPEC.summary`.

- [ ] **Step 1: Failing tests.**
  - The registry's command set (with aliases) equals the commands dispatched by `src/cli.js`'s switch. Reuse the extraction regex from `cli-docs-census.test.ts`.
  - Every entry's `loadSpec()` resolves to a spec whose `name` equals the entry name.
  - Every spec has a non-empty `summary`.
  - Every flag has a non-empty `description`.
  - Every spec includes `h` and `v`.
  - For `add`: the loaded spec deep-equals `buildSpec()`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm vitest run --project unit tests/unit/cli/command-registry.test.ts`
- [ ] **Step 3: Implement.**
  - Export `SPEC` (or the existing named constant) from each module.
  - Loaders use dynamic `import()`, so `src/cli.js` startup cost is unchanged.
  - Where a module's `SPEC.summary` is weaker than the README's wording for the same command, adopt the better wording into `SPEC.summary` (it's the source now), keeping it to one line. Example: `next` → "Tell me what to do next, and offer to run it".
  - Missing flag descriptions get real ones.
- [ ] **Step 4: Run, expect PASS.** Then run `pnpm vitest run --project unit tests/unit/cli tests/unit/docs` and fix anything that asserted old summary text, updating expectations to the new source wording.
- [ ] **Step 5: Commit** `feat(cli): command registry with a complete SPEC for every command`.

---

### Task 2: Top-level help renders from the registry

**Files:**
- Modify: `src/cli.js` (`showHelp`)
- Possibly modify: `src/lib/cli/help.js` (add a `renderCommandList(entriesWithSpecs)` helper)
- Test: `tests/unit/cli/top-level-help.test.ts`; update any integration snapshot of `vibecarbon -h` (`git grep -l "DEV COMMANDS" tests`)

**Interfaces:**
- Consumes: `COMMANDS`, `loadAllSpecs` (Task 1).
- Produces: `renderCommandList(rows: Array<{ name, aliases?, usage, summary }>, { width = 80 })` → string lines grouped under `DEV COMMANDS`, `DEPLOY COMMANDS`, `DEBUG COMMANDS`, `LICENSE COMMANDS`.

Keep these sections of `showHelp()` as they are: the header, `USAGE`, `GLOBAL FLAGS`, `EXAMPLES` and `DOCUMENTATION`. Only the command lists change. Name and usage are padded to one column; a summary that would pass 80 columns wraps under the summary column.

- [ ] **Step 1: Failing tests.**
  - Every registry command appears under its category heading with its `SPEC.summary`.
  - `?` and `next` share one line.
  - No line is wider than 80 visible columns (strip ANSI).
  - Pass a fake extra registry entry and it appears. This proves help is generated, not hand-written.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `showHelp` becomes async if needed; check the call sites in `main()`.
- [ ] **Step 4: Run, expect PASS.** Run `pnpm vitest run --project integration tests/integration/cli` and update help snapshots only for the regenerated list.
- [ ] **Step 5: Commit** `feat(cli): render the top-level command list from each command's SPEC`.

---

### Task 3: `pnpm docs:cli` generator + drift test

**Files:**
- Create: `scripts/gen-cli-docs.js` (CLI wrapper) and `src/lib/cli/docs-gen.js` (pure functions, unit-testable)
- Modify: `package.json` (add a `"docs:cli": "node scripts/gen-cli-docs.js"` script)
- Modify: `carbon/content/docs/cli.mdx`, `README.md`, `AGENTS.md` (insert markers, then generate)
- Create: `tests/unit/docs/cli-docs-generated.test.ts`
- Delete: `tests/unit/docs/deploy-flags-docs-census.test.ts`. The generated-region test covers every command's flags, `deploy` included. Note this justification in the commit body.

**Interfaces:**
- Consumes: Task 1 registry.
- Produces (in `docs-gen.js`):
  - `renderFlagTable(spec) → string`: markdown table `| Flag | Description |`. A flag renders as `` `-name <value>` `` when `spec.flags[i].value` is set, otherwise `` `-name` ``. `h` and `v` are excluded. An empty table renders `_No flags beyond -h and -v._`.
  - `renderCommandTable(rows, category) → string`: README style `| Command | What it does |`, with `` **`name usage`** `` in the first column. Flags marked `featured: true` in a SPEC get their own row (`` **`down -orphans`** ``) under their command. Add `featured: true` to `down`'s `orphans` flag.
  - `renderAgentsBlock(rows) → string`: the fenced `bash` block, one line per command, `vibecarbon <name> <usage>` padded to a comment column, then `# <summary>`. Featured flags get a line too.
  - `replaceRegion(text, id, body, style: 'md' | 'mdx') → string`: throws if a marker is missing or duplicated.
  - `generateAll(files) → Map<path, newText>`

Regions:
- `cli.mdx`: one `flags <command>` region in each command's section, replacing the hand-written flag table where one exists. Where a section has no table, insert the region after the section's first paragraph. Leave prose and examples alone.
- `cli.mdx`: also one `global-flags` region near the top.
- `README.md`: `commands dev`, `commands deploy`, `commands license` regions replacing the three tables. The headings and intro lines stay outside the markers.
- `AGENTS.md`: a `commands` region wrapping the fenced block.

- [ ] **Step 1: Failing unit tests for `docs-gen.js`.**
  - Flag table, both value and no-value cases.
  - `h`/`v` excluded.
  - Featured flag row.
  - `replaceRegion` keeps the bytes before and after a region, and throws on missing or duplicate markers.
  - Determinism: two runs give identical output.
- [ ] **Step 2: Failing drift test** (`cli-docs-generated.test.ts`): for each target file, `generateAll` output must equal the file on disk. On failure the message names the file and says `run pnpm docs:cli`. Also assert every registry command has a `flags <name>` region in `cli.mdx`.
- [ ] **Step 3: Run both, expect FAIL.**
- [ ] **Step 4: Implement** `docs-gen.js` and the script. Insert markers into the three files. Run `pnpm docs:cli`. Review the diff by eye: prose outside the markers must be unchanged. New flags that were missing from the docs (e.g. `down -orphans`) now appear in `cli.mdx`.
- [ ] **Step 5: Run, expect PASS.** Run `pnpm vitest run --project unit tests/unit/docs` (the `cli-docs-census` licensing checks must still pass), then `pnpm lint`.
- [ ] **Step 6: Commit** `feat(cli): generate command and flag docs from SPEC, and fail on drift`.

---

### Task 4: Hand-written docs for 2026-10-12 behavior

**Files:**
- Modify: `carbon/content/docs/cli.mdx` (prose in the `up` and `down` sections, outside the markers)
- Modify: `carbon/content/docs/development.mdx`, `carbon/content/docs/getting-started.mdx`

Content:
- **`up`:** the stack name is pinned in `.env` as `COMPOSE_PROJECT_NAME` on first run. Renaming or moving the folder keeps the local database: `up` notices the old stack, recreates its containers from the new folder, and keeps the volumes. A copied folder is refused while the original's stack exists. The message says what to change.
- **`down`:** what `-orphans` finds ("folder is gone or changed"). Data volumes are deleted only on an explicit yes. How to reuse a moved project's data: set `COMPOSE_PROJECT_NAME=<old name>` in the new folder's `.env` before `vibecarbon up`.
- **Development and getting-started:** local dev services don't start by themselves after a reboot, so run `vibecarbon up`. One clause on why: a deleted or moved project can't crash-loop.

- [ ] **Step 1:** Write the prose. Match the voice of the surrounding docs. No em dashes.
- [ ] **Step 2:** Run `pnpm docs:cli`; it must produce no diff, which proves the prose stayed outside the markers. Run `pnpm vitest run --project unit tests/unit/docs`; the terminology and doc-fact censuses must pass.
- [ ] **Step 3: Commit** `docs(cli): document stack-name pinning, down -orphans, and the reboot change`.

---

### Task 5: Write the standard into AGENTS.md

**Files:**
- Modify: `AGENTS.md` ("CLI conventions" section), `carbon/AGENTS.md` only if it has a CLI conventions section (check first)

Add two bullets under "CLI conventions":

- **Context-sensitive messages are part of the feature.** When the CLI detects a specific scenario, its message names what happened, why it matters, and the exact command or edit that fixes it. Examples: a missing prerequisite, a conflicting stack, a refused action, or something left behind. Use the existing voice (lowercase hints via `p.log.info`, no em dashes). Unit tests assert the key strings for each scenario. A bare error with no next step is incomplete.
- **Commands and flags document themselves.** A command's `SPEC` (summary, flag descriptions, `featured` for flags worth a README row) is the only place its interface is written. After changing a `SPEC`, run `pnpm docs:cli`. That regenerates the top-level help list, the `cli.mdx` flag tables, the README Commands tables and this file's command block. `tests/unit/docs/cli-docs-generated.test.ts` fails on drift. New commands go in `src/lib/cli/command-registry.js`. Behavior that flags can't express (scenarios, data safety, migrations) still gets hand-written prose in `cli.mdx` outside the generated markers.

- [ ] **Step 1:** Add the bullets. Change the "CLI Commands" intro line so it says the block is generated.
- [ ] **Step 2:** Run `pnpm docs:cli` (no diff) and `pnpm vitest run --project unit tests/unit/docs`.
- [ ] **Step 3: Commit** `docs(agents): make scenario messages and generated CLI docs the standard`.

---

### Task 6: Gate

- [ ] `pnpm test:prepush` green.
- [ ] Sanity check by hand:
  - Add a throwaway flag to a `SPEC` in a scratch edit.
  - `pnpm vitest run --project unit tests/unit/docs/cli-docs-generated.test.ts` fails, naming `run pnpm docs:cli`.
  - `pnpm docs:cli` fixes it.
  - Revert the scratch edit (never committed).

---

## Follow-up (out of scope for this plan)

- **Migrate these updates to the marketing site** (`~/repos/vibecarbon-web`). Its `content/docs/cli.mdx` is a separate hand-maintained copy that has drifted from the template's since 2026-09-16, and it lacks `down -orphans`, the stack-name pinning notes, and the reboot note. Recommended approach: have the site copy `carbon/content/docs/cli.mdx` from the published `vibecarbon` npm package at build time (the file ships in the tarball), so it matches each release exactly instead of being re-synced by hand. Track it in the Notion roadmap.
- **v0.48.0 release page:** add a line noting the reboot behavior change (local dev stacks don't restart by themselves after a reboot; run `vibecarbon up`).
- **Audit of existing messages:** sweep `p.log.error` / `process.exit(1)` sites in user-facing commands for messages with no next step, and bring them up to the Task 5 standard. This is separate work because it touches many commands.
