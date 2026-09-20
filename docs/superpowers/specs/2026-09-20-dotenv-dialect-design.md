# One dotenv dialect — design

**Date:** 2026-09-20
**Status:** approved in chat 2026-09-20 (Brandon: "Fix this across our entire project and template"; unrepresentable values are refused, not approximated)
**Follows:** `2026-09-19-operator-config-hygiene-design.md` (that spec validates *what* a value is; this one fixes *how* it is stored and read)

## Problem

Seven readers and one writer disagree about what a `.env` line means.

| Consumer | Parser | Single quotes | `\"` in `"…"` | `$X` |
|---|---|---|---|---|
| CLI `parseDotenv` (`src/lib/shell.js`) | hand-rolled state machine | POSIX `'\''` decoded | kept | literal |
| template `scripts/dev.js`, `docker-up.js` | regex `^KEY=["']?([^"'\n]+)["']?` | stops at first quote | stops | literal |
| template `scripts/generate-{rss,seo,sitemap}.ts` | regex `^(VITE_PUBLIC_URL\|SITE_URL)=["']?(.+?)["']?` | mangled | mangled | literal |
| template API (`tsx --env-file`) | Node `util.parseEnv` | literal | terminates the string | literal |
| Vite `import.meta.env` / `loadEnv` | dotenv + dotenv-expand | literal | escaped | **expanded** |
| server `docker compose` (`env_file`, `${…}` interpolation) | Compose | literal, no interpolation | escaped | interpolated unless single-quoted |
| e2e `tests/e2e/sweep-project.ts`, `runner.ts`, `scripts/iter-step.js` | hand-rolled | varies | varies | literal |

The only writer for user-supplied values is `escapeDotenv` = `shEscape`, which emits POSIX `'it'\''s'`. Node, Vite, and Compose all read that as `it`. Every user whose password or token contains a `'` has been shipping a truncated secret to their server since `configure` first wrote one. The generated-secret path (`create`) emits `KEY="…"`, a second grammar in the same file.

## Decision

**One dialect: the intersection of Node `util.parseEnv` and Docker Compose.** Every process we run reads `.env*` through `util.parseEnv` (we are on Node ≥ 24.15 in both the CLI and the template). Compose is the one reader we cannot change, so the writer emits only what both read identically. Vite (dotenv-expand) is honoured for the keys it exposes: `VITE_*` values may not contain `$`.

### Writer grammar (`encodeDotenvValue(key, value)`)

Evaluated in order; the first matching form is emitted.

1. **Bare** `KEY=value` when `value` matches `/^[A-Za-z0-9_./:@+=,%-]*$/` (covers empty, base64, JWTs, URLs, slugs).
2. **Double-quoted** `KEY="value"` when `value` contains none of `"` `\` `$`; a real newline is written as `\n` (Node and Compose both decode it). Covers spaces, `#`, `'`, unicode, `!*?&;` and PEM blocks.
3. **Single-quoted** `KEY='value'` when `value` contains none of `'` and no newline. Covers `"`, `\`, `$` literally in Node and Compose.
4. **Refused** otherwise, with `DotenvValueError` naming the key and the reason, never the value:
   - a `'` together with any of `"` `\` `$`, or a newline together with any of `"` `\` `$`;
   - any control character other than `\n` (tabs, `\r`);
   - `$` in a `VITE_*` value (Vite's dotenv-expand expands it even inside single quotes; the client would see a different string than the server).

Refusal happens at the earliest point: the clack `validate` callback of every prompt that writes an env var (configure, create's admin password, the guided setups) shows the reason and re-prompts; `setEnvVar` and `create`'s generator throw the same error for non-interactive paths. Brandon 2026-09-20: refusing the mixed case is acceptable, it is an edge case.

### Readers

- `src/lib/dotenv.js` exports `parseDotenv(text)` (thin wrapper over `util.parseEnv`), `readEnvFiles(dir)` (`.env` then `.env.local` layered, missing files skipped), `dotenvValueProblem`, `encodeDotenvValue`, `formatDotenvLine`, `DotenvValueError`. `shell.js` loses `parseDotenv`, `escapeDotenv`, `decodeDotenvValue`; `shEscape` stays for shell commands only.
- `carbon/scripts/lib/dotenv.js` is **byte-identical** to `src/lib/dotenv.js` (a lockstep test enforces it; template projects cannot import the CLI). `dev.js`, `docker-up.js`, `generate-*.ts`, `dev-init.js` and `vite.config.ts`'s config-side read use it. Vite keeps loading `import.meta.env.VITE_*` itself (the client uses `import.meta.env[dynamicKey]` in three places, so `envDir: false` + `define` is not an option); the `$` refusal above is what keeps that reader in agreement.
- The e2e harness and `scripts/iter-step.js` import `parseDotenv` from `src/lib/dotenv.js`.
- `bundle.js`'s `.env` rewriter keeps its line loop (it must preserve comments and order verbatim) but emits lines with `formatDotenvLine`.

### Migration

Existing projects carry `'it'\''s'` lines from the old writer. `vibecarbon upgrade` gains `healLegacyDotenvQuoting(cwd)` next to `healShortVaultEncKey`: for `.env` and `.env.local`, every single-line `KEY='…'` whose body contains `'\''` is decoded (`'\''` → `'`) and re-encoded with the new grammar; a value the grammar refuses is left in place with a warning naming the key. `setEnvVar` runs the same pure `healLegacyDotenvText(text)` on the file before replacing a line, so an un-upgraded project is repaired the first time `configure` touches it. Plain `'value'` lines from the old writer already parse identically everywhere and are left alone.

### Enumerable invariants (tests)

1. **Cross-parser oracle** (`tests/unit/lib/dotenv-oracle.test.ts`): a fixture of ~25 synthetic values (empty, spaces, `#`, each quote, backslash, `$HOME`/`${HOME}`, newline, unicode, base64, URL with `?&=`, JWT, `;*!%`, backtick, `=`, leading/trailing space) is encoded and parsed back by `util.parseEnv`, `dotenv.parse`, and `dotenv-expand`; every accepted value round-trips through all three (`$` values are asserted through expand only under a non-`VITE_` key, where Vite never reads them, and the divergence is documented in the test). Refused values are asserted refused with their reason. `dotenv` and `dotenv-expand` become root devDependencies for this test only.
2. **Compose oracle** (`tests/integration/docker/dotenv-compose-oracle.test.ts`, `DOCKER_INTEGRATION` tier): the same encoded fixture written to a temp `.env`, `docker compose config --format json` on a one-service file with `env_file: .env`, every value equal to the source.
3. **Reader/writer census** (`tests/unit/lib/dotenv-dialect-census.test.ts`, replaces `dotenv-parsers-parity.test.ts`): walks `src/**`, `carbon/scripts/**`, `carbon/vite.config.ts`, `scripts/**`, `tests/**` and asserts every file that opens a `.env*` path imports from a `lib/dotenv.js`; no file but the two dotenv modules mentions `parseEnv(`; no file writes an env line except through `formatDotenvLine`/`encodeDotenvValue` (allow-list: `bundle.js` rewriter loop, by exact path with reason); the identifiers `escapeDotenv`, `decodeDotenvValue`, `unescapeDotenv` no longer exist; `src/lib/dotenv.js` equals `carbon/scripts/lib/dotenv.js` byte for byte.

### Documented dialect difference (not fixed)

A hand-edited bare value containing `#` (`PASSWORD=abc#def`) reads as `abc` in Node and `abc#def` in Compose (Compose needs whitespace before `#`). The writer never emits that form; the `.env.example` header tells users to quote such values. No further code.

## Non-goals

- Changing which file a key lives in (`.env` ships in the bundle, `.env.local` never leaves the machine; unchanged).
- Making Compose or Vite parse anything new. We write to their intersection instead.
- Multi-line legacy single-quoted values: the migration skips them with a warning; nobody has reported one.

## Compatibility

Files written by the new CLI are readable by every older CLI (the old state machine accepts bare, `"…"` and `'…'` forms). Files written by an older CLI are repaired by `upgrade` or by the next `configure`. No `!:` footer; Compatibility note in the commit body.
