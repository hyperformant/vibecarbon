/**
 * Package manager adaptation utilities
 *
 * Shared between create.js (initial project setup) and upgrade.js
 * (re-apply adaptations after template files are replaced).
 *
 * The template in `carbon/` is npm-based (decision 2026-07-30): running
 * vibecarbon already requires `npx`, so npm is guaranteed present on every
 * machine that can scaffold a project. `-pm pnpm` / `-pm bun` are still
 * supported and adapt the template away from npm here.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './command.js';

export function getPackageManagerVersion(pm) {
  // Try to detect installed version, fall back to sensible defaults
  // The packageManager field requires full semver (e.g., "pnpm@9.0.0" not "pnpm@9")
  try {
    const version = runCommand([pm, '--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Every package-manager spawn goes through cleanEnv, including this one:
      // a wrapper's `npm_execpath` / `npm_config_*` should not decide which
      // binary answers, or how. See PM_RUN_CONTEXT_RE in lib/command.js.
      cleanEnv: true,
    }).trim();
    // Validate it looks like a semver version
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return `${pm}@${version}`;
    }
  } catch {
    // Fall through to defaults
  }

  // Default versions (full semver required)
  switch (pm) {
    case 'pnpm':
      return 'pnpm@10.32.1';
    case 'bun':
      return 'bun@1.0.0';
    default:
      return 'npm@10.0.0';
  }
}

// Anchor the package-manager bootstrap insert on the builder stage's WORKDIR
// plus the comment that follows it. `WORKDIR /app` alone appears twice (builder
// and runner), so the comment is what makes the match unique.
const BOOTSTRAP_ANCHOR = `WORKDIR /app

# Install dependencies first so the layer caches independently of source.`;

// The template's install step is a whole block (rationale comment + RUN), not
// one command, and the comment is entirely npm-specific ("npm ships with node",
// npm's lockfile semantics) — leaving it above a `pnpm install` would ship prose
// that contradicts the line under it. So the block is swapped wholesale rather
// than token-replaced. Must stay byte-identical to carbon/Dockerfile; the unit
// test in tests/unit/lib/package-manager.test.ts pins that.
const NPM_INSTALL_BLOCK = `# npm ships with node, so nothing had to be installed to get here.
#
# \`npm ci\` is the ONLY install path here, deliberately. It installs exactly what
# package-lock.json records and never re-resolves — which is the entire point of
# shipping a lockfile. An \`|| npm install\` repair branch would quietly re-resolve
# every floating range at image-build time, so the image you ship would stop
# matching the tree you reviewed and tested (the unbounded \`>=\` floors in
# \`overrides\` jump majors when re-resolved). It would also mask a genuinely
# broken lockfile until much later.
#
# If \`npm ci\` fails here, the committed lockfile is wrong, not the npm version:
# run \`npm install\` locally and commit the resulting package-lock.json.
# \`vibecarbon create\` ships this lockfile straight from the template, where CI
# has already verified it against \`npm ci\` — it is not re-resolved per project.
RUN --mount=type=cache,id=npm,target=/root/.npm \\
    npm ci --no-audit --no-fund`;

/** The install block the template ships with — exported so tests can pin it. */
export const TEMPLATE_INSTALL_BLOCK = NPM_INSTALL_BLOCK;

/**
 * Lowest pnpm that reads its settings from `pnpm-workspace.yaml`.
 *
 * SECURITY: this is a hard floor, not a recommendation. `carbon/package.json`
 * carries dependency-security pins in `overrides`; npm and bun read the
 * top-level field, pnpm does not. pnpm 11 also stopped reading the `pnpm` field
 * in package.json entirely — it prints "The following keys were ignored:
 * pnpm.overrides" and resolves as though the block were absent. Measured
 * 2026-07-30 against the template's real dependency graph:
 *
 *   pnpm 11.18.0, pins in package.json  -> fast-uri@3.1.4, unhead@2.1.16  (IGNORED)
 *   pnpm  9.x,    pins in workspace.yaml -> fast-uri@3.1.4, unhead@2.1.16  (IGNORED)
 *   pnpm 10.5.2 / 10.6.0 / 10.32.1 / 11.18.0, pins in workspace.yaml
 *                                       -> fast-uri@4.1.1, unhead@3.2.3   (APPLIED)
 *
 * The applied versions match the npm lockfile the template ships exactly, so
 * pnpm 10+ reaches full parity with the npm default. pnpm 9 has no location
 * that both it and pnpm 11 honor, so `create` refuses it rather than handing
 * someone a project whose CVE floors silently do not apply.
 */
export const MIN_PNPM_MAJOR = 10;

/**
 * Serialize the `pnpm` settings block as YAML.
 *
 * Deliberately narrow: the template's block is string arrays, string maps, one
 * nested string map (`peerDependencyRules.allowedVersions`), and one map of
 * booleans (`allowBuilds`). Anything else throws rather than emitting YAML that
 * silently means something different — these values are security pins, so a
 * quiet mis-serialization is the exact failure this function exists to prevent.
 * Scalars go through JSON.stringify: JSON is a subset of YAML 1.2, so that
 * quotes and escapes correctly, and it keeps selectors like `postcss@<8.5.10`
 * from being read as YAML syntax. Booleans are emitted BARE — a quoted "true"
 * is the string, and pnpm rejects it where it wants a boolean.
 */
function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') throw new Error(`pnpm settings: non-string array item ${item}`);
    }
    return value.map((item) => `${pad}- ${JSON.stringify(item)}\n`).join('');
  }
  if (value && typeof value === 'object') {
    let out = '';
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string') {
        out += `${pad}${JSON.stringify(key)}: ${JSON.stringify(val)}\n`;
      } else if (typeof val === 'boolean') {
        out += `${pad}${JSON.stringify(key)}: ${val}\n`;
      } else if (Array.isArray(val) || (val && typeof val === 'object')) {
        out += `${pad}${JSON.stringify(key)}:\n${toYaml(val, indent + 1)}`;
      } else {
        throw new Error(`pnpm settings: unsupported value for "${key}" (${typeof val})`);
      }
    }
    return out;
  }
  throw new Error(`pnpm settings: unsupported top-level value (${typeof value})`);
}

/**
 * Split `key: rest` / `"quoted key": rest`, returning [key, rest].
 *
 * The quoted form matters: the selectors this file carries (`postcss@<8.5.10`)
 * are quoted precisely because they contain YAML-significant characters, so
 * splitting on the first colon would cut some of them in the wrong place.
 */
function splitYamlKey(content, lineNo) {
  if (content.startsWith('"')) {
    let i = 1;
    while (i < content.length && content[i] !== '"') i += content[i] === '\\' ? 2 : 1;
    if (i >= content.length) throw new Error(`line ${lineNo}: unterminated quoted key`);
    const key = JSON.parse(content.slice(0, i + 1));
    const rest = content.slice(i + 1);
    if (!rest.startsWith(':')) throw new Error(`line ${lineNo}: expected ":" after quoted key`);
    return [key, rest.slice(1)];
  }
  const colon = content.indexOf(':');
  if (colon <= 0) throw new Error(`line ${lineNo}: expected "key: value" or "key:"`);
  return [content.slice(0, colon), content.slice(colon + 1)];
}

/**
 * Read one scalar. Mirrors what `toYaml` emits (JSON-quoted), and additionally
 * accepts the plain and single-quoted forms a human — or `pnpm approve-builds`
 * — writes by hand. Anything with YAML meaning beyond that throws.
 */
function parseYamlScalar(raw, lineNo) {
  const text = raw.trim();
  if (!text) throw new Error(`line ${lineNo}: empty value`);
  if (text.startsWith('"')) {
    const parsed = JSON.parse(text); // throws on trailing junk — deliberate
    if (typeof parsed !== 'string') throw new Error(`line ${lineNo}: non-string value`);
    return parsed;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) {
      throw new Error(`line ${lineNo}: unterminated single-quoted value`);
    }
    return text.slice(1, -1).replaceAll("''", "'");
  }
  // Plain scalar. Refuse every character that would make this mean something
  // other than "this exact string" — flow collections, anchors, aliases, tags,
  // block scalars, explicit keys, directives, trailing comments.
  if (/^[-?:,[\]{}#&*!|>%@`]/.test(text) || text.includes(' #')) {
    throw new Error(`line ${lineNo}: unsupported YAML syntax in value`);
  }
  // Bare booleans are real booleans — `allowBuilds` is a map of them, and
  // reading `true` back as the STRING "true" would re-emit it quoted, which
  // pnpm does not accept there. Only the YAML 1.2 core spellings; the 1.1
  // yes/no/on/off zoo stays a string, matching what pnpm's own parser does.
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

/**
 * Parse the block of `lines` that sits at `indent`, starting at `start`.
 *
 * @returns {[unknown, number]} the parsed value and the index after the block
 */
function parseYamlBlock(lines, start, indent) {
  if (lines[start].content.startsWith('- ')) {
    const out = [];
    let i = start;
    for (; i < lines.length && lines[i].indent === indent; i++) {
      if (!lines[i].content.startsWith('- ')) break;
      out.push(parseYamlScalar(lines[i].content.slice(2), lines[i].lineNo));
    }
    return [out, i];
  }

  const out = {};
  let i = start;
  for (; i < lines.length && lines[i].indent === indent; i++) {
    const { content, lineNo } = lines[i];
    const [key, rest] = splitYamlKey(content, lineNo);
    if (rest.trim()) {
      out[key] = parseYamlScalar(rest, lineNo);
      continue;
    }
    // Bare `key:` — the value is the more-indented block beneath it.
    const next = lines[i + 1];
    if (!next || next.indent <= indent) throw new Error(`line ${lineNo}: "${key}:" has no value`);
    const [value, after] = parseYamlBlock(lines, i + 1, next.indent);
    out[key] = value;
    i = after - 1;
  }
  return [out, i];
}

/**
 * Parse a pnpm settings YAML file into a plain object.
 *
 * A deliberately tiny subset — the exact counterpart of `toYaml`. It throws on
 * anything it does not fully understand rather than guessing, for the same
 * reason the serializer does: these values are security pins, and a quiet
 * misreading here would silently drop a CVE floor. Callers treat a throw as
 * "leave the user's file alone", never as "assume it was empty".
 */
function fromYaml(text) {
  if (text.includes('\t')) throw new Error('tabs are not valid YAML indentation');
  const lines = text
    .split('\n')
    .map((line, idx) => ({
      indent: line.length - line.trimStart().length,
      content: line.trim(),
      lineNo: idx + 1,
    }))
    .filter((line) => line.content && !line.content.startsWith('#'));
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new Error('line 1: unexpected indentation');
  const [value, consumed] = parseYamlBlock(lines, 0, 0);
  if (consumed !== lines.length)
    throw new Error(`line ${lines[consumed].lineNo}: unexpected block`);
  if (Array.isArray(value)) throw new Error('expected a mapping at the top level');
  return value;
}

/**
 * Merge template settings over the user's existing ones.
 *
 * Mirrors the deep-merge an npm user's `overrides` already gets in
 * src/lib/merge-package-json.js — template values win on a shared key, user
 * keys the template says nothing about survive — with one deliberate
 * difference: ARRAYS UNION rather than replace. The array that matters is
 * `onlyBuiltDependencies`, which is where `pnpm approve-builds` records the
 * user's own build approvals; replacing it wholesale (merge-package-json's rule
 * for arrays) would revoke them on every upgrade.
 *
 * User order is preserved and template-only entries append, so the file churns
 * as little as possible between upgrades.
 */
function mergePnpmSettings(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (Array.isArray(value) && Array.isArray(current)) {
      merged[key] = [...current, ...value.filter((item) => !current.includes(item))];
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      merged[key] = mergePnpmSettings(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Restate the build-script allow/deny lists in the form pnpm 11 reads.
 *
 * SECURITY / CORRECTNESS: pnpm 11 REPLACED `onlyBuiltDependencies`,
 * `neverBuiltDependencies` and `ignoredBuiltDependencies` with a single
 * `allowBuilds` map, and it does not fall back to the old names — it silently
 * treats them as absent. Under pnpm 11 that is not a warning: unlisted
 * dependencies whose build scripts were skipped make the install EXIT NONZERO
 * with ERR_PNPM_IGNORED_BUILDS. Measured 2026-07-31 against the template's real
 * graph on pnpm 11.18.0:
 *
 *   onlyBuiltDependencies only  -> "Ignored build scripts: esbuild@0.28.1,
 *                                  vue-demi@0.14.10", install exits 1
 *   + allowBuilds               -> exits 0, esbuild's native binary is built
 *
 * That is what broke the first real-infra e2e run of the npm template: the
 * generated project's `docker build` installs pnpm from the HOST's version, so
 * a pnpm-11 host produced an image whose `pnpm install --frozen-lockfile`
 * could not complete. pnpm 10 ignored the same condition with a warning, which
 * is why it went unnoticed.
 *
 * BOTH forms are emitted rather than swapping: `MIN_PNPM_MAJOR` is 10, pnpm 10
 * reads only the old names, and pnpm 11 accepts the old names being present
 * alongside `allowBuilds` without so much as a deprecation notice (verified on
 * 10.32.1 and 11.18.0). Dropping the old names would break every pnpm-10 user.
 *
 * Derived rather than authored so the template keeps ONE list per decision —
 * a package allowed here and forgotten there is the drift this whole module
 * exists to prevent.
 */
function deriveAllowBuilds(settings) {
  const allowBuilds = {};
  for (const name of settings.onlyBuiltDependencies ?? []) allowBuilds[name] = true;
  for (const name of settings.ignoredBuiltDependencies ?? []) allowBuilds[name] = false;
  for (const name of settings.neverBuiltDependencies ?? []) allowBuilds[name] = false;
  return Object.keys(allowBuilds).length > 0 ? allowBuilds : null;
}

const PNPM_WORKSPACE_HEADER = `# pnpm settings, including the dependency-security pins under \`overrides\`.
#
# These live here rather than in package.json's \`pnpm\` field because pnpm 11
# no longer reads that field — it warns and resolves as if the pins were absent,
# which would silently drop every CVE floor below. pnpm 10.5+ and 11 both read
# this file. Keep it in sync with \`overrides\` in package.json (npm/bun read
# that one); a pin added to only one leaves that manager's users exposed.
#
# Your own entries are safe here: \`vibecarbon upgrade\` merges this file rather
# than rewriting it, so anything you add (or that \`pnpm approve-builds\` adds
# for you) survives. On a shared key the template's value wins — those are the
# security floors.
`;

/**
 * Move the `pnpm` block out of package.json and into pnpm-workspace.yaml.
 *
 * Called for `-pm pnpm` projects only. The block is deleted from package.json
 * rather than duplicated: keeping both would leave two maps of security pins to
 * drift apart, and pnpm 11 warns on every install about the one it ignores.
 *
 * No `packages:` key is emitted — pnpm reads a settings-only workspace file
 * fine (verified on 10.5.2 and 11.18.0), and adding `packages: ['.']` would
 * turn a plain project into a workspace root, where `pnpm add` starts demanding
 * `-w`. Idempotent: re-running against an already-migrated project is a no-op,
 * so `upgrade` can call it unconditionally.
 *
 * An EXISTING file is merged, not overwritten. `upgrade` re-stamps the
 * template's `pnpm` block into package.json and then calls this, so a wholesale
 * write would delete whatever the user had put in the workspace file —
 * including the build approvals `pnpm approve-builds` records there. An npm
 * user's `overrides` additions already survive upgrade via the package.json
 * deep-merge; this is the pnpm user's half of that guarantee.
 *
 * @param {string} projectDir
 * @param {{ warn?: (message: string) => void }} [options]
 * @returns {boolean} true if a pnpm-workspace.yaml was written
 */
export function writePnpmWorkspaceSettings(projectDir, { warn } = {}) {
  const pkgPath = join(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (!pkg.pnpm || Object.keys(pkg.pnpm).length === 0) return false;

  const workspacePath = join(projectDir, 'pnpm-workspace.yaml');
  let existing = {};
  if (existsSync(workspacePath)) {
    try {
      existing = fromYaml(readFileSync(workspacePath, 'utf-8'));
    } catch (err) {
      // SECURITY: bail out rather than clobber. Overwriting would destroy the
      // user's pins; proceeding blind would be worse than not refreshing ours.
      // Leave both files exactly as they are and tell the caller, so the merge
      // can be done by hand with everything still present.
      warn?.(
        `pnpm-workspace.yaml could not be parsed (${err.message}), so it was left ` +
          "untouched — this template's dependency-security pins were NOT refreshed " +
          'into it. Merge the `pnpm` block from package.json into pnpm-workspace.yaml ' +
          'by hand, then remove it from package.json.',
      );
      return false;
    }
  }

  const settings = mergePnpmSettings(existing, pkg.pnpm);

  // Restate the build lists in pnpm 11's vocabulary. Derived from the MERGED
  // settings, so a build the user approved via pnpm 10's `approve-builds`
  // (which appends to onlyBuiltDependencies) is carried into the v11 form too
  // instead of being silently revoked there.
  //
  // The user's own allowBuilds entries survive, except that non-booleans are
  // dropped: on a failed install pnpm 11 appends its own entries with the
  // literal placeholder `set this to true or false`, and round-tripping that
  // back would re-emit a string where pnpm demands a boolean — turning a
  // recoverable state into a wedged one. Derived values win on a shared key,
  // matching how the template's other floors behave.
  const derived = deriveAllowBuilds(settings);
  if (derived) {
    const userEntries = Object.entries(settings.allowBuilds ?? {}).filter(
      ([, v]) => typeof v === 'boolean',
    );
    settings.allowBuilds = { ...Object.fromEntries(userEntries), ...derived };
  }

  writeFileSync(workspacePath, `${PNPM_WORKSPACE_HEADER}${toYaml(settings)}`);

  delete pkg.pnpm;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Lockfile each package manager writes, and that the generated Dockerfile
 * COPYs into the build context. Keep in sync with adaptDockerfileForPackageManager
 * below and with detectPackageManager in lib/project.js.
 */
export const LOCKFILE_NAMES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  bun: 'bun.lock',
};

/**
 * Write the template's committed lockfile into a freshly scaffolded project.
 *
 * `create` used to produce this by running a full `npm install` in the new
 * project — ~1 minute of wall clock, plus an `npm ci --dry-run` convergence
 * loop, on every single scaffold. That work was always redundant: `create`
 * never touches `dependencies` or `devDependencies`, so a generated project's
 * tree is by definition the template's tree. Resolving it again per-user only
 * bought a DIFFERENT answer each time — every project shipped whatever the
 * floating ranges happened to resolve to that minute, a tree nothing had
 * tested. Copying the committed lock instead makes `create` near-instant AND
 * starts every project on the exact tree CI exercises.
 *
 * npm strips a lockfile from the ROOT of a published tarball, but not one
 * nested under carbon/ — verified against npm 12. The template's lock ships
 * because .npmignore no longer excludes it; tests/unit/template pins that.
 *
 * Only `name` needs patching. The root `packages[""]` block carries exactly
 * name/version/dependencies/devDependencies/engines, and `create` rewrites
 * none of the others (its `scripts` and `packageManager` edits don't appear in
 * a lockfile at all). npm's own serialization is 2-space JSON with a trailing
 * newline, so this round-trips byte-identically to what npm would have written.
 *
 * @param {string} templateDir - the carbon/ template root
 * @param {string} projectDir
 * @param {string} projectName - becomes the lockfile's root name
 * @returns {boolean} false if the template ships no lockfile (caller falls back)
 */
export function writeTemplateLockfile(templateDir, projectDir, projectName) {
  const source = join(templateDir, 'package-lock.json');
  if (!existsSync(source)) return false;

  const lock = JSON.parse(readFileSync(source, 'utf-8'));
  lock.name = projectName;
  if (lock.packages?.['']) lock.packages[''].name = projectName;

  writeFileSync(join(projectDir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return true;
}

/**
 * Guarantee the project has the lockfile its Dockerfile is about to COPY.
 *
 * The generated Dockerfile does `COPY package.json <lockfile> ./` and then a
 * strict `npm ci` / `--frozen-lockfile` install. With no lockfile on disk the
 * build dies at the COPY step with a raw BuildKit "file not found" — after the
 * operator has already answered every deploy prompt and, on the cloud paths,
 * after infrastructure exists. So this runs as a deploy preflight instead:
 * early, before any resource is created, where the failure is still free.
 *
 * A project scaffolded by `vibecarbon create` normally arrives with its
 * lockfile already committed. This covers the paths where it doesn't — a
 * `create -skip-lockfile`, a clone that gitignored it, a hand-rolled project.
 *
 * npm gets the same convergence loop `create` uses: npm's optional-peer
 * subtrees can need more than one pass before `npm ci` accepts the result, and
 * a lockfile npm itself rejects would fail the Docker build and the scaffolded
 * CI workflow (both install with a strict `npm ci`). Validating here means the
 * operator learns about it while they can still act.
 *
 * @param {string} projectDir
 * @param {'npm'|'pnpm'|'bun'} packageManager
 * @param {{ onStep?: (message: string) => void }} [options]
 * @returns {{ lockfile: string, generated: boolean, accepted: boolean }}
 */
export function ensureLockfile(projectDir, packageManager, { onStep } = {}) {
  const lockfile = LOCKFILE_NAMES[packageManager];

  // bun wrote a binary bun.lockb before 1.2; either satisfies the build.
  const candidates = packageManager === 'bun' ? ['bun.lock', 'bun.lockb'] : [lockfile];
  const present = candidates.find((name) => existsSync(join(projectDir, name)));
  if (present) return { lockfile: present, generated: false, accepted: true };

  // pnpm is the only one with a real lockfile-only mode (~2s, no node_modules).
  // npm's `--package-lock-only` writes a lock `npm ci` then rejects, and bun
  // has no such mode at all — both do a full install here.
  const generateCmd = {
    npm: ['npm', 'install', '--no-audit', '--no-fund'],
    pnpm: ['pnpm', 'install', '--lockfile-only'],
    bun: ['bun', 'install'],
  }[packageManager];

  onStep?.(`Generating ${lockfile} (required by the Docker build)`);
  runCommand(generateCmd, { cwd: projectDir, cleanEnv: true, ignoreError: true });

  if (packageManager !== 'npm') {
    return {
      lockfile,
      generated: existsSync(join(projectDir, lockfile)),
      accepted: existsSync(join(projectDir, lockfile)),
    };
  }

  const MAX_LOCKFILE_PASSES = 5;
  let accepted = false;
  for (let pass = 1; pass <= MAX_LOCKFILE_PASSES; pass++) {
    const valid = runCommand(['npm', 'ci', '--dry-run', '--no-audit', '--no-fund'], {
      cwd: projectDir,
      cleanEnv: true,
      ignoreError: true,
      silent: true,
    });
    if (valid !== null) {
      accepted = true;
      break;
    }
    if (pass === MAX_LOCKFILE_PASSES) break;
    onStep?.(`Reconciling ${lockfile} (pass ${pass + 1}/${MAX_LOCKFILE_PASSES})`);
    runCommand(generateCmd, { cwd: projectDir, cleanEnv: true, ignoreError: true });
  }

  return { lockfile, generated: existsSync(join(projectDir, lockfile)), accepted };
}

export function adaptDockerfileForPackageManager(projectDir, packageManager) {
  // The template is already npm-based — nothing to rewrite.
  if (packageManager === 'npm') return;

  const dockerfilePath = join(projectDir, 'Dockerfile');
  let content = readFileSync(dockerfilePath, 'utf-8');
  const version = getPackageManagerVersion(packageManager); // e.g. "pnpm@10.32.1"

  const lockfiles = { pnpm: 'pnpm-lock.yaml', bun: 'bun.lock' };
  const lockfile = lockfiles[packageManager];

  // Bootstrap line. npm needs none (it ships with node), so the npm-based
  // template has no such layer — pnpm/bun projects get one inserted ahead of
  // the builder stage's WORKDIR. Guarded by an `indexOf` check so re-running
  // the adapter (upgrade re-applies it) can't stack duplicate installs.
  if (!content.includes(`npm install -g ${packageManager}`)) {
    content = content.replace(
      BOOTSTRAP_ANCHOR,
      `# ${packageManager} is not in the node base image — install it before the build.
RUN npm install -g ${version}

${BOOTSTRAP_ANCHOR}`,
    );
  }

  // BuildKit cache mount path. The template hardcodes npm's cache location;
  // without this rewrite, pnpm and bun projects mount an empty cache at npm's
  // path and never read from their own caches — every install pays full
  // network cost. Fixing it is ~30-60s off warm-cache rebuilds for non-npm.
  const cacheMountTargets = {
    pnpm: '/root/.local/share/pnpm/store',
    bun: '/root/.bun/install/cache',
  };
  const cacheMount = `--mount=type=cache,id=${packageManager},target=${cacheMountTargets[packageManager]}`;

  // Whole install block (see NPM_INSTALL_BLOCK). No `|| install` repair for
  // pnpm/bun — their lockfiles install identically everywhere, so a failure
  // there is a real error the build should surface.
  const installMap = {
    pnpm: 'pnpm install --frozen-lockfile',
    bun: 'bun install --frozen-lockfile',
  };
  content = content.replace(
    NPM_INSTALL_BLOCK,
    `# ${packageManager} lockfiles install identically everywhere, so this is strict —
# a failure here is a real dependency problem, not tooling skew.
RUN ${cacheMount} \\\n    ${installMap[packageManager]}`,
  );

  // Lockfile COPY. Deliberately AFTER the install-block swap above: that
  // block's rationale comment names package-lock.json, so rewriting the string
  // first would stop the block from matching and silently leave a bare `npm ci`
  // sitting in a pnpm project's Dockerfile.
  //
  // pnpm additionally needs pnpm-workspace.yaml in the build context. It holds
  // the `overrides` security pins (see writePnpmWorkspaceSettings), and pnpm
  // records the active overrides inside the lockfile — so with the file absent
  // `--frozen-lockfile` fails outright rather than quietly dropping the pins.
  const copySources = packageManager === 'pnpm' ? `${lockfile} pnpm-workspace.yaml` : `${lockfile}`;
  content = content.replace(
    'COPY package.json package-lock.json ./',
    `COPY package.json ${copySources} ./`,
  );
  // Any other reference (a stage the line above didn't cover, or a Dockerfile
  // the user has since edited).
  content = content.replaceAll('package-lock.json', lockfile);

  // prod install (replace before general install — more specific match first)
  const prodInstallMap = {
    pnpm: 'pnpm install --frozen-lockfile --prod',
    bun: 'bun install --frozen-lockfile --production',
  };
  content = content.replaceAll('npm ci --omit=dev', prodInstallMap[packageManager]);

  // Any remaining bare install/cache-mount occurrences (a stage that doesn't
  // use the full block above, or a Dockerfile a user has since edited).
  content = content.replaceAll('npm ci', installMap[packageManager]);
  content = content.replace(/--mount=type=cache,id=npm,target=\/root\/\.npm/g, cacheMount);

  // build commands
  const run = packageManager === 'pnpm' ? 'pnpm' : 'bun run';
  content = content.replaceAll('npm run build:client', `${run} build:client`);
  content = content.replaceAll('npm run build:server', `${run} build:server`);

  writeFileSync(dockerfilePath, content);
}
