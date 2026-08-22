#!/usr/bin/env node
/**
 * Propagate the repo's Node version from `.nvmrc` to every site that can't
 * read it directly.
 *
 *   pnpm node:sync          # rewrite the derived sites
 *   pnpm node:sync --check  # report drift, exit 1, write nothing
 *
 * `.nvmrc` is the ONLY file you edit to change the Node line. GitHub Actions
 * reads it natively (`node-version-file:`), so workflows are almost never
 * listed here — they need no rewriting and must never re-pin a literal. What
 * DOES need rewriting is anything that can't read a file at evaluation time:
 * Dockerfile base tags, `engines.node`, esbuild's `--target`, and the single
 * sanctioned workflow literal described in step 5 below.
 *
 * `engines.node` is not copied from `.nvmrc` — it's COMPUTED. The floor is the
 * highest minimum that any declared dependency imposes on the `.nvmrc` major,
 * read out of the lockfile. That is what stops the class of bug this script
 * was written after: `engines.node` said `>=20` while `undici` (a runtime
 * dependency, imported by every deploy path) declared `>=22.19.0` and threw on
 * import under Node 20. A hand-maintained floor drifts silently; a derived one
 * moves the moment a dependency's own floor does.
 *
 * tests/unit/lib/node-version-pins.test.ts re-derives all of this
 * INDEPENDENTLY and fails on any disagreement — deliberately not by importing
 * this file, so that breaking the script can't also disable the check on it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const nodeMajor = readFileSync(join(ROOT, '.nvmrc'), 'utf-8').trim();
if (!/^\d+$/.test(nodeMajor)) {
  console.error(`.nvmrc must contain a bare major version (e.g. "24"), got: ${nodeMajor}`);
  process.exit(1);
}

// Pending edits, keyed by path. Edits ACCUMULATE per file: carbon/package.json
// is rewritten twice (esbuild --target and engines.node), and an earlier
// version of this script re-read each file from disk per edit, so the second
// write silently discarded the first. Everything flows through this map.
const pending = new Map();
const original = new Map();

function text(relPath) {
  if (!pending.has(relPath)) {
    const disk = readFileSync(join(ROOT, relPath), 'utf-8');
    original.set(relPath, disk);
    pending.set(relPath, disk);
  }
  return pending.get(relPath);
}

/** Replace the file's whole content. */
function put(relPath, next) {
  text(relPath);
  pending.set(relPath, next);
}

/** Apply `fn` to the file's current (possibly already-edited) text. */
function edit(relPath, fn) {
  pending.set(relPath, fn(text(relPath)));
}

/** Paths whose pending text differs from what's on disk. */
function drifted() {
  return [...pending.keys()].filter((relPath) => pending.get(relPath) !== original.get(relPath));
}

// ---------------------------------------------------------------------------
// 1. Mirrors of .nvmrc itself.
// ---------------------------------------------------------------------------
// .node-version: same contract, read by fnm/nodenv/asdf instead of nvm.
// carbon/.nvmrc: shipped into generated projects, where the build workflow
// reads it via node-version-file.
put('.node-version', `${nodeMajor}\n`);
put(join('carbon', '.nvmrc'), `${nodeMajor}\n`);

// ---------------------------------------------------------------------------
// 2. Dockerfile base tags.
// ---------------------------------------------------------------------------
// Each Dockerfile carries exactly ONE `ARG NODE_IMAGE=node:<major>...` line;
// every other stage derives from it inside the build. Only the major is
// rewritten — the alpine suffix is a deliberate, separately-reasoned pin (in
// carbon/Dockerfile it must track the runner stage's `alpine:` version).
for (const relPath of [join('carbon', 'Dockerfile'), join('docker', 'carbon-autoscaler', 'Dockerfile')]) {
  edit(relPath, (text) => {
    const next = text.replace(/^(ARG NODE_IMAGE=node:)\d+/m, `$1${nodeMajor}`);
    if (next === text && !new RegExp(`^ARG NODE_IMAGE=node:${nodeMajor}\\b`, 'm').test(text)) {
      console.error(`${relPath}: no \`ARG NODE_IMAGE=node:<major>\` line to update`);
      process.exit(1);
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// 3. esbuild's --target for the template's server bundle.
// ---------------------------------------------------------------------------
edit(join('carbon', 'package.json'), (text) => text.replace(/--target=node\d+/g, `--target=node${nodeMajor}`));

// ---------------------------------------------------------------------------
// 4. engines.node — computed from each project's own dependency graph.
// ---------------------------------------------------------------------------

/**
 * npm lockfiles (carbon/) are JSON, pnpm lockfiles (root) are YAML — the two
 * scrapers below pick the right pair by extension. Same contract either way:
 * `name@version` -> engines.node range, and direct dep name -> resolved version.
 */
function npmLockEngines(lockJson) {
  const out = new Map();
  for (const [path, entry] of Object.entries(lockJson.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/');
    if (at === -1 || !entry.version) continue;
    const name = path.slice(at + 'node_modules/'.length);
    const range = entry.engines?.node;
    if (range) out.set(`${name}@${entry.version}`, String(range).trim());
  }
  return out;
}

/** Direct dependency name -> resolved version, from an npm lockfile. */
function npmLockDirectDeps(lockJson) {
  const out = new Map();
  const root = lockJson.packages?.[''] ?? {};
  for (const kind of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(root[kind] ?? {})) {
      const entry = lockJson.packages?.[`node_modules/${name}`];
      if (entry?.version) out.set(name, entry.version);
    }
  }
  return out;
}

/** Pick the scraper pair matching the lockfile format. */
function readLock(lockRel, lockText) {
  if (lockRel.endsWith('.json')) {
    const json = JSON.parse(lockText);
    return { engines: npmLockEngines(json), resolved: npmLockDirectDeps(json) };
  }
  return { engines: lockfileEngines(lockText), resolved: lockfileDirectDeps(lockText) };
}

/** `name@version` -> declared engines.node range, from a pnpm lockfile. */
function lockfileEngines(lockText) {
  const out = new Map();
  let inPackages = false;
  let current = null;
  for (const line of lockText.split('\n')) {
    if (/^packages:/.test(line)) { inPackages = true; continue; }
    if (/^snapshots:/.test(line)) { inPackages = false; continue; }
    if (!inPackages) continue;
    const head = line.match(/^ {2}'?(@?[^'\s]+?)'?:\s*$/);
    if (head) { current = head[1]; continue; }
    const engines = line.match(/^ {4}engines: \{node: '?([^',}]+)'?/);
    if (engines && current) out.set(current, engines[1].trim());
  }
  return out;
}

/** Direct dependency name -> resolved version, from the lockfile's root importer. */
function lockfileDirectDeps(lockText) {
  const out = new Map();
  let inRootImporter = false;
  let name = null;
  for (const line of lockText.split('\n')) {
    if (/^ {2}\.:\s*$/.test(line)) { inRootImporter = true; continue; }
    if (inRootImporter && /^ {2}\S/.test(line)) break;
    if (!inRootImporter) continue;
    const key = line.match(/^ {6}'?(@?[^'\s]+?)'?:\s*$/);
    if (key) name = key[1];
    const version = line.match(/^ {8}version: (\S+)/);
    if (version && name) out.set(name, version[1].replace(/\(.*/, ''));
  }
  return out;
}

/**
 * Lowest version on the `major` line that `range` admits, or null if `range`
 * excludes that major entirely. Throws on syntax it can't reason about, so an
 * unhandled range is a loud failure rather than a silently-passed check.
 */
function lowestOnMajor(range, major) {
  let best = null;
  for (const raw of range.split('||')) {
    const term = raw.trim();
    const m = term.match(/^(>=|>|\^|~)?\s*(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/);
    if (!m) throw new Error(`unsupported engines range term: "${term}" (in "${range}")`);
    const [, op, majorStr, minorStr, patchStr] = m;
    const maj = Number(majorStr);
    const min = minorStr && minorStr !== 'x' ? Number(minorStr) : 0;
    const patch = patchStr && patchStr !== 'x' ? Number(patchStr) : 0;
    let candidate = null;
    if (op === '>=' || op === '>') {
      if (major > maj) candidate = [major, 0, 0];
      else if (major === maj) candidate = [maj, min, op === '>' ? patch + 1 : patch];
    } else if (major === maj) {
      // `^X.Y.Z`, `~X.Y.Z`, bare `X`, `X.x` — all confined to major X.
      candidate = [maj, min, patch];
    }
    if (candidate && (!best || candidate[1] < best[1] || (candidate[1] === best[1] && candidate[2] < best[2]))) {
      best = candidate;
    }
  }
  return best;
}

/**
 * The honest floor for a project: the highest minimum its declared deps impose
 * on this major. Both `dependencies` and `devDependencies` count — devDeps run
 * in CI on this same Node line.
 */
function computeEnginesFloor(pkg, lockRel, lockText, major) {
  const { engines, resolved } = readLock(lockRel, lockText);
  let floor = [major, 0, 0];
  let bindingDep = null;
  const excluded = [];
  for (const kind of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[kind] ?? {})) {
      const version = resolved.get(name);
      const range = version && engines.get(`${name}@${version}`);
      if (!range) continue;
      const lowest = lowestOnMajor(range, major);
      if (!lowest) { excluded.push(`${name}@${version} requires "${range}"`); continue; }
      if (lowest[1] > floor[1] || (lowest[1] === floor[1] && lowest[2] > floor[2])) {
        floor = lowest;
        bindingDep = `${name}@${version} ("${range}")`;
      }
    }
  }
  return { floor: floor.join('.'), bindingDep, excluded };
}

/** The root project's computed floor, e.g. "24.15.0" — step 5 writes it. */
let rootFloor = null;

for (const [pkgRel, lockRel] of [
  ['package.json', 'pnpm-lock.yaml'],
  // carbon/ is an npm project (its lockfile is JSON) — see AGENTS.md.
  [join('carbon', 'package.json'), join('carbon', 'package-lock.json')],
]) {
  const pkg = JSON.parse(text(pkgRel));
  const lockText = readFileSync(join(ROOT, lockRel), 'utf-8');
  const { floor, bindingDep, excluded } = computeEnginesFloor(pkg, lockRel, lockText, Number(nodeMajor));
  if (excluded.length) {
    console.error(`${pkgRel}: these dependencies do NOT support Node ${nodeMajor}:`);
    for (const line of excluded) console.error(`  - ${line}`);
    console.error('Resolve this before moving the Node line.');
    process.exit(1);
  }
  if (pkgRel === 'package.json') rootFloor = floor;
  const want = `>=${floor}`;
  if (pkg.engines?.node !== want) {
    console.log(`${pkgRel}: engines.node ${pkg.engines?.node} -> ${want}${bindingDep ? `  (bound by ${bindingDep})` : ''}`);
  }
  edit(pkgRel, (text) => text.replace(/("engines":\s*\{\s*"node":\s*")[^"]+(")/, `$1${want}$2`));
}

// ---------------------------------------------------------------------------
// 5. The engines-minimum CI leg.
// ---------------------------------------------------------------------------
// .github/workflows/test.yml's `engines-min` job carries the repo's ONE
// literal `node-version:` — it runs unit + integration on exactly the floor
// computed above, because every other job floats on the newest release of the
// major and so would never notice code that needs a newer Node than the
// package advertises. It is the one workflow site this script owns: it must
// NOT read .nvmrc (that is the whole point of the leg), and it cannot read
// package.json at evaluation time either. Without this step, moving the Node
// line would leave the leg testing a floor that no longer exists.
const TEST_WORKFLOW = join('.github', 'workflows', 'test.yml');
edit(TEST_WORKFLOW, (text) => {
  const next = text.replace(/^(\s*node-version: ')[^']+(')/m, `$1${rootFloor}$2`);
  if (next === text && !new RegExp(`^\\s*node-version: '${rootFloor}'$`, 'm').test(text)) {
    console.error(`${TEST_WORKFLOW}: no literal \`node-version: '<x.y.z>'\` line to update`);
    console.error('The engines-minimum leg is missing or was rewritten by hand.');
    process.exit(1);
  }
  return next;
});

// ---------------------------------------------------------------------------
// 6. Human-readable prose that advertises the requirement.
// ---------------------------------------------------------------------------
// The reader-facing floor. Every site above is machine-read; these are the
// ones a person actually acts on before running `create`, and they were the
// last category still maintained by hand. They drifted exactly as you would
// expect: both getting-started pages sat at "Node.js 22+" for the whole life
// of the 24 line, telling users to install a version the package's own
// `engines.node` would reject.
//
// The advertised string is derived from the COMPUTED floor, not from .nvmrc's
// bare major, because that is the number a user's install actually has to
// clear. A trailing ".0" is dropped ("24.15.0" reads as "24.15+"); any other
// patch level is spelled in full, so a floor of 24.15.3 cannot be advertised
// as the lower 24.15.
const proseVersion = rootFloor.replace(/\.0$/, '');
const PROSE_SITES = [
  'README.md',
  join('carbon', 'content', 'docs', 'getting-started.mdx'),
  join('carbon', 'content', 'blog', 'getting-started.mdx'),
];
// Matches the bolded requirement in any of its phrasings:
//   **Node.js 24.15+** and **Docker** for ...      (README)
//   **Node.js 24.15+** ([Download](...)), ...      (docs)
//   **Node.js 24.15+** installed, ...              (blog)
const PROSE_PIN = /(\*\*Node\.js )\d+(?:\.\d+)*(\+\*\*)/g;
for (const relPath of PROSE_SITES) {
  edit(relPath, (text) => {
    if (!PROSE_PIN.test(text)) {
      console.error(`${relPath}: no \`**Node.js <version>+**\` requirement to update`);
      console.error('Reword it back, or drop the file from PROSE_SITES if it no longer states one.');
      process.exit(1);
    }
    PROSE_PIN.lastIndex = 0;
    return text.replace(PROSE_PIN, `$1${proseVersion}$2`);
  });
}

// ---------------------------------------------------------------------------
const changed = drifted();
if (!changed.length) {
  console.log(`Node pins are in sync with .nvmrc (${nodeMajor}).`);
  process.exit(0);
}
if (check) {
  console.error(`Node pins are OUT OF SYNC with .nvmrc (${nodeMajor}):`);
  for (const relPath of changed) console.error(`  - ${relPath}`);
  console.error('Run `pnpm node:sync` to fix.');
  process.exit(1);
}
for (const relPath of changed) {
  writeFileSync(join(ROOT, relPath), pending.get(relPath));
  console.log(`updated ${relPath}`);
}
console.log(`\nNode pins synced to ${nodeMajor}. Re-run \`pnpm install\` and commit.`);
