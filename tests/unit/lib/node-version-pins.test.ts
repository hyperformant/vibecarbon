/**
 * Drift guard for the Node version. `.nvmrc` is the single source of truth;
 * every other Node pin in the repo either reads it directly (GitHub Actions,
 * via `node-version-file`) or is written from it by `pnpm node:sync`
 * (scripts/sync-node-version.js). This test re-derives all of it
 * INDEPENDENTLY — deliberately without importing that script, so breaking the
 * writer can't also disable the check on it.
 *
 * Written after two failures that a "just keep them in sync by hand" policy
 * had already let through:
 *
 *   (a) `engines.node` claimed `>=20` while `undici` — a RUNTIME dependency,
 *       imported at module scope by src/lib/fetch-retry.js and thus by every
 *       deploy/scale/backup/destroy path — declared `>=22.19.0` and threw
 *       `webidl.util.markAsUncloneable is not a function` on import under Node
 *       20. Node 20 also reached EOL on 2026-04-30, so the floor advertised an
 *       unpatched runtime. Hence `engines.node` is checked against the
 *       DEPENDENCY GRAPH, not just against our own files: a guard that only
 *       compared our pins to each other would have called that state green.
 *
 *   (b) Nothing tested the declared floor, and nothing recorded that CI's `22`
 *       was the real requirement. Both facts now live in one file.
 *
 * The inventory assertions are the load-bearing part (same idiom as
 * tests/unit/deploy/walg-dockerfile-arch.test.ts): a NEW workflow or
 * Dockerfile that pins Node must be registered here, so it can't quietly
 * escape the sweep.
 *
 * ONE sanctioned exception to "no literals" exists, and it is registered in
 * `ENGINES_MIN_LEG` below: the CI leg that runs unit + integration on exactly
 * the `engines.node` floor. `.nvmrc` holds a bare MAJOR, so every other job
 * floats on the newest release of that line — which means the floor the
 * package advertises was itself a declared-but-unexercised claim (docs/tests.md
 * § "Failure classes", class 4). A leg that executes the floor cannot read
 * `.nvmrc`; that is the entire point of it. So the literal is allowed in
 * exactly one job, written there by `pnpm node:sync`, and pinned two-way to
 * `engines.node` by the last describe block in this file.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf-8');

/** The source of truth, as a bare major (e.g. "24"). */
const NODE_MAJOR = read('.nvmrc').trim();

// Every workflow in the repo, including the template's — carbon/.github/
// ships into generated projects, so its pins are customer-facing.
const WORKFLOWS = [
  // CodeQL runs prebuilt analysis actions only — no setup-node, no Node pin.
  join('.github', 'workflows', 'codeql.yml'),
  join('.github', 'workflows', 'dependabot-auto-merge.yml'),
  join('.github', 'workflows', 'e2e-us-perf.yml'),
  join('.github', 'workflows', 'publish-db-image.yml'),
  join('.github', 'workflows', 'publish-images.yml'),
  join('.github', 'workflows', 'release.yml'),
  // Scorecard runs prebuilt analysis actions only — no setup-node, no Node pin.
  join('.github', 'workflows', 'scorecard.yml'),
  join('.github', 'workflows', 'test.yml'),
  join('carbon', '.github', 'workflows', 'deploy.yml'),
  join('carbon', '.github', 'workflows', 'vibecarbon-build.yml'),
];

/**
 * THE one sanctioned literal `node-version:` in the repo, as workflow -> job
 * id. Scoped to a single JOB on purpose: a second literal, in another job of
 * the same file or in any other workflow, is still drift.
 */
const ENGINES_MIN_LEG = {
  workflow: join('.github', 'workflows', 'test.yml'),
  job: 'engines-min',
} as const;

/** The root project's declared floor, without the `>=`, e.g. "24.15.0". */
const ENGINES_FLOOR = (JSON.parse(read('package.json')).engines.node as string).replace(/^>=/, '');

type SetupNodeStep = { job: string; nodeVersion?: string; versionFile?: string };

/**
 * Every `actions/setup-node` step in a workflow or composite action, tagged
 * with the job it belongs to. PARSED, not grepped: the exception above is
 * scoped to one job, and a regex over file text cannot tell which job a
 * `with:` block belongs to.
 */
function setupNodeSteps(relPath: string): SetupNodeStep[] {
  const doc = loadYaml(read(relPath)) as {
    jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
    runs?: { steps?: Array<Record<string, unknown>> };
  };
  // A workflow keys its steps under `jobs.<id>`; a composite action has a
  // single flat `runs.steps` list and no job ids at all.
  const jobs: Array<[string, { steps?: Array<Record<string, unknown>> }]> = doc.jobs
    ? Object.entries(doc.jobs)
    : [['runs', doc.runs ?? {}]];
  const out: SetupNodeStep[] = [];
  for (const [job, body] of jobs) {
    for (const step of body.steps ?? []) {
      if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/setup-node@')) continue;
      const withMap = (step.with ?? {}) as Record<string, string>;
      out.push({
        job,
        nodeVersion: withMap['node-version'],
        versionFile: withMap['node-version-file'],
      });
    }
  }
  return out;
}

/** Every `run:` script in one job of a workflow, in order. */
function jobRunCommands(relPath: string, jobId: string): string[] {
  const doc = loadYaml(read(relPath)) as {
    jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
  };
  const job = doc.jobs?.[jobId];
  if (!job) throw new Error(`${relPath}: no job "${jobId}"`);
  return (job.steps ?? []).flatMap((step) => (typeof step.run === 'string' ? [step.run] : []));
}

// Dockerfiles that pin a `node:` base image, and those that deliberately
// don't (both DB images are FROM supabase/postgres). Listing the second group
// is what makes the inventory meaningful: adding Node to one of them, or
// adding a new Dockerfile entirely, has to be triaged here.
const NODE_DOCKERFILES = [
  join('carbon', 'Dockerfile'),
  join('docker', 'carbon-autoscaler', 'Dockerfile'),
];
const NON_NODE_DOCKERFILES = [
  join('carbon', 'db', 'Dockerfile'),
  join('docker', 'postgres-walg', 'Dockerfile'),
];

// Only genuinely irrelevant trees are skipped. Dot-directories are NOT
// skipped wholesale: `.devcontainer/Dockerfile` and `.github/actions/*/
// action.yml` are exactly the kind of file that pins a Node version, and an
// earlier version of this guard walked past both. `worktrees` and `.worktrees`
// are excluded because .claude/worktrees and <repo>/.worktrees hold entire
// checkouts of this repo — walking either would re-discover every workflow and
// Dockerfile under an agent's copy.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'worktrees', '.worktrees']);

/**
 * Any reference to a `node` base image, WHATEVER the tag shape. Matching only
 * `node:\d` was a hole: `FROM node:lts-alpine` (or `node:current`, or the
 * `node:jod` codename) slipped past both Dockerfile checks below, and unlike
 * the other discovery gaps that one needed no new file — appending such a
 * stage to carbon/Dockerfile was enough. The negative lookbehind keeps
 * `ghcr.io/acme/node:1` and similar suffixed paths from matching.
 */
const NODE_IMAGE_REF = /(?<![\w./-])node:[A-Za-z0-9][\w.-]*/;

function walk(dir: string, visit: (full: string, name: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, visit);
    } else {
      visit(full, entry.name);
    }
  }
}

/** Every Dockerfile in the repo, as ROOT-relative paths. */
function findDockerfiles(): string[] {
  const out: string[] = [];
  walk(ROOT, (full, name) => {
    if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) out.push(relative(ROOT, full));
  });
  return out;
}

/**
 * Every file that can set up Node in CI: workflows under any
 * `.github/workflows/`, plus composite actions (`action.yml`) anywhere — a
 * composite action runs `actions/setup-node` just like a workflow does, and
 * lives outside `workflows/`.
 */
function findWorkflows(): string[] {
  const out: string[] = [];
  const workflowsDir = join('.github', 'workflows');
  walk(ROOT, (full, name) => {
    if (!/\.ya?ml$/.test(name)) return;
    const isWorkflow = relative(ROOT, full).includes(workflowsDir);
    const isCompositeAction = name === 'action.yml' || name === 'action.yaml';
    if (isWorkflow || isCompositeAction) out.push(relative(ROOT, full));
  });
  return out;
}

describe('.nvmrc is the single source of truth', () => {
  it('is a bare major version', () => {
    // A bare major means "newest release on that line" to nvm, fnm, asdf and
    // setup-node alike, so CI picks up security patches without a commit.
    // A full x.y.z here would freeze CI on one patch release.
    expect(NODE_MAJOR).toMatch(/^\d+$/);
  });

  it('.node-version matches (fnm / nodenv / asdf read this one)', () => {
    expect(read('.node-version')).toBe(read('.nvmrc'));
  });

  it('the template ships the same line to generated projects', () => {
    // carbon/.nvmrc lands at the generated project's root, where its
    // vibecarbon-build.yml resolves `node-version-file: .nvmrc`.
    expect(read('carbon', '.nvmrc')).toBe(read('.nvmrc'));
  });
});

describe('workflows read .nvmrc instead of repeating a literal', () => {
  const workflows = findWorkflows().sort();

  it('knows about every workflow and composite action in the repo', () => {
    expect(workflows).toEqual([...WORKFLOWS].sort());
  });

  it.each(WORKFLOWS)('%s uses no NODE_VERSION indirection', (relPath) => {
    // The env-var form that used to hold '22' in test.yml / e2e-us-perf.yml.
    // Banned outright rather than merely sanctioned-with-a-value: an env var
    // is invisible to the parsed sweep below, which reads `with:` maps only.
    expect(read(relPath), `${relPath}: NODE_VERSION env var re-pins Node`).not.toMatch(
      /NODE_VERSION/,
    );
  });

  it('exactly ONE literal node-version: exists across every workflow', () => {
    // Text-level twin of the parsed sweep below (idiom borrowed from
    // pnpm-version-pins.test.ts's literal inventory). The parsed sweep reads
    // setup-node `with:` maps, so a version smuggled into a `run:` line, an
    // `env:` block, or a reusable-workflow call would never reach it. This
    // one counts the literals themselves, wherever they sit.
    const literals = WORKFLOWS.flatMap((relPath) =>
      [...read(relPath).matchAll(/^\s*node-version:\s*'?([^'\s#]+)'?/gm)].map(
        (m) => `${relPath}: ${m[1]}`,
      ),
    );
    expect(literals).toEqual([`${ENGINES_MIN_LEG.workflow}: ${ENGINES_FLOOR}`]);
  });

  it('every setup-node step reads .nvmrc, except the registered engines-minimum leg', () => {
    const violations: string[] = [];
    for (const relPath of WORKFLOWS) {
      for (const step of setupNodeSteps(relPath)) {
        const where = `${relPath} [job: ${step.job}]`;
        const sanctioned = relPath === ENGINES_MIN_LEG.workflow && step.job === ENGINES_MIN_LEG.job;
        if (sanctioned) {
          if (step.nodeVersion !== ENGINES_FLOOR) {
            violations.push(
              `${where}: pins "${step.nodeVersion}" but engines.node's floor is ${ENGINES_FLOOR} — run \`pnpm node:sync\``,
            );
          }
          if (step.versionFile !== undefined) {
            // setup-node warns and uses `node-version` when both are set, so
            // the leg would keep passing while reading nothing — and a later
            // deletion of the literal would silently return it to the float.
            violations.push(`${where}: must NOT also set node-version-file`);
          }
          continue;
        }
        if (step.nodeVersion !== undefined) {
          violations.push(`${where}: pins node-version — use node-version-file: .nvmrc`);
        }
        if (step.versionFile !== '.nvmrc') {
          violations.push(
            `${where}: node-version-file is ${JSON.stringify(step.versionFile)}, want ".nvmrc"`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the parsed sweep really reaches setup-node steps', () => {
    // Guards the parser: a js-yaml shape change, or a typo in the `uses:`
    // prefix, that returned [] would make the sweep above vacuously green.
    const all = WORKFLOWS.flatMap((relPath) => setupNodeSteps(relPath));
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((step) => step.job === ENGINES_MIN_LEG.job)).toHaveLength(1);
  });

  it('the template workflow resolves .nvmrc in a GENERATED project, not this repo', () => {
    // setup-node resolves node-version-file against the workspace root. In a
    // generated project that root is where carbon/'s contents were copied, so
    // the path is bare `.nvmrc` (NOT `carbon/.nvmrc`) and the file must be
    // shipped there. create.js writes it; ci-setup.js re-installs it for
    // projects predating it (the workflow is copy-on-demand, so an upgraded
    // workflow could otherwise reference a file that was never written).
    const workflow = read('carbon', '.github', 'workflows', 'vibecarbon-build.yml');
    expect(workflow).toMatch(/node-version-file:\s*\.nvmrc/);
    expect(workflow).not.toMatch(/node-version-file:\s*carbon\//);
    expect(read('src', 'create.js')).toMatch(/copyTemplate\('\.nvmrc'/);

    // The three assertions below are source greps, so they are kept
    // whitespace- and layout-insensitive on purpose: an earlier version
    // spelled out the exact spacing of a destructuring assignment and broke
    // the moment biome reflowed the line. The BEHAVIOR they stand in for is
    // covered directly by tests/unit/lib/ci-setup-nvmrc.test.ts against a real
    // temp dir and a real git repo; these only pin that the wiring still
    // exists, so they should stay coarse.
    const ciSetup = read('src', 'lib', 'ci-setup.js');
    expect(ciSetup).toMatch(/installNodeVersionFile/);
    // The pushed commit must carry .nvmrc, or the very run it triggers dies
    // at setup-node with a missing file.
    expect(ciSetup).toMatch(/'add'[\s,]+PROJECT_WORKFLOW_PATH[\s,]+PROJECT_NODE_VERSION_PATH/);
    // The auto-commit path must gate on needsCommit, not on the workflow
    // alone — otherwise a .nvmrc written for a pre-.nvmrc project is left
    // untracked.
    expect(ciSetup).toMatch(/needsCommit[\s\S]{0,80}installCiFiles\(cwd\)/);
    expect(ciSetup).toMatch(/if\s*\(needsCommit\)/);
  });
});

describe('Dockerfiles pin the same Node major', () => {
  const dockerfiles = findDockerfiles().sort();

  it('knows about every Dockerfile in the repo', () => {
    // A new Dockerfile must be triaged into NODE_DOCKERFILES or
    // NON_NODE_DOCKERFILES rather than silently escaping the sweep below.
    expect(dockerfiles).toEqual([...NODE_DOCKERFILES, ...NON_NODE_DOCKERFILES].sort());
  });

  it.each(NODE_DOCKERFILES)('%s declares exactly ONE Node pin', (relPath) => {
    const dockerfile = read(relPath);
    // One `ARG NODE_IMAGE=` line; every other stage derives from it. Keeping
    // it to one is what makes a bump a single-line edit.
    const argLines = dockerfile.match(/^ARG NODE_IMAGE=\S+/gm) ?? [];
    expect(argLines).toHaveLength(1);

    const otherRefs = dockerfile
      .split('\n')
      .filter(
        (line) =>
          NODE_IMAGE_REF.test(line) && !/^ARG NODE_IMAGE=/.test(line) && !/^\s*#/.test(line),
      );
    expect(otherRefs, `${relPath}: derive from \${NODE_IMAGE} instead`).toEqual([]);
  });

  it.each(NODE_DOCKERFILES)('%s pins the .nvmrc major', (relPath) => {
    const tag = read(relPath).match(/^ARG NODE_IMAGE=node:(\d+)/m)?.[1];
    expect(tag, `${relPath}: no ARG NODE_IMAGE=node:<major>`).toBe(NODE_MAJOR);
  });

  it.each(NON_NODE_DOCKERFILES)('%s still pins no Node image', (relPath) => {
    expect(read(relPath)).not.toMatch(NODE_IMAGE_REF);
  });

  it('carbon/Dockerfile keeps its node base and runner stage on the SAME alpine', () => {
    // The runner is a bare `alpine:X` that the node binary is COPY'd into.
    // A mismatch builds fine and dies at runtime on musl/libstdc++.
    const dockerfile = read('carbon', 'Dockerfile');
    const nodeAlpine = dockerfile.match(/^ARG NODE_IMAGE=node:\d+-alpine([\d.]+)/m)?.[1];
    const runnerAlpine = dockerfile.match(/^FROM alpine:([\d.]+) AS runner/m)?.[1];
    expect(nodeAlpine).toBeDefined();
    expect(runnerAlpine).toBe(nodeAlpine);
  });
});

interface NpmLock {
  packages?: Record<
    string,
    {
      version?: string;
      engines?: { node?: string };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

describe('engines.node is honest about the floor', () => {
  const PROJECTS = [
    { label: 'root', pkg: 'package.json', lock: 'pnpm-lock.yaml' },
    {
      // carbon/ is an npm project — its lockfile is JSON, not pnpm YAML.
      label: 'carbon',
      pkg: join('carbon', 'package.json'),
      lock: join('carbon', 'package-lock.json'),
    },
  ];

  /** `name@version` -> declared engines.node range, scraped from an npm lockfile. */
  function npmLockEngines(lockJson: NpmLock): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, entry] of Object.entries(lockJson.packages ?? {})) {
      const at = path.lastIndexOf('node_modules/');
      if (at === -1 || !entry.version) continue;
      const range = entry.engines?.node;
      if (range)
        out.set(`${path.slice(at + 'node_modules/'.length)}@${entry.version}`, range.trim());
    }
    return out;
  }

  /** Direct dependency name -> resolved version, from an npm lockfile. */
  function npmLockDirectDeps(lockJson: NpmLock): Map<string, string> {
    const out = new Map<string, string>();
    const root = lockJson.packages?.[''] ?? {};
    for (const kind of ['dependencies', 'devDependencies'] as const) {
      for (const name of Object.keys(root[kind] ?? {})) {
        const version = lockJson.packages?.[`node_modules/${name}`]?.version;
        if (version) out.set(name, version);
      }
    }
    return out;
  }

  /** Pick the scraper pair matching the lockfile format. */
  function readLock(lockPath: string, lockText: string) {
    if (lockPath.endsWith('.json')) {
      const json = JSON.parse(lockText) as NpmLock;
      return { engines: npmLockEngines(json), resolved: npmLockDirectDeps(json) };
    }
    return { engines: lockfileEngines(lockText), resolved: lockfileDirectDeps(lockText) };
  }

  /** `name@version` -> declared engines.node range, scraped from a pnpm lockfile. */
  function lockfileEngines(lockText: string): Map<string, string> {
    const out = new Map<string, string>();
    let inPackages = false;
    let current: string | null = null;
    for (const line of lockText.split('\n')) {
      if (/^packages:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (/^snapshots:/.test(line)) {
        inPackages = false;
        continue;
      }
      if (!inPackages) continue;
      const head = line.match(/^ {2}'?(@?[^'\s]+?)'?:\s*$/);
      if (head) {
        current = head[1];
        continue;
      }
      const engines = line.match(/^ {4}engines: \{node: '?([^',}]+)'?/);
      if (engines && current) out.set(current, engines[1].trim());
    }
    return out;
  }

  /** Direct dependency name -> resolved version, from the lockfile's root importer. */
  function lockfileDirectDeps(lockText: string): Map<string, string> {
    const out = new Map<string, string>();
    let inRootImporter = false;
    let name: string | null = null;
    for (const line of lockText.split('\n')) {
      if (/^ {2}\.:\s*$/.test(line)) {
        inRootImporter = true;
        continue;
      }
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
   * Lowest version on the `major` line that `range` admits, or null if the
   * range excludes that major. Throws on syntax it can't reason about, so an
   * unhandled range fails loudly instead of passing by default.
   */
  function lowestOnMajor(range: string, major: number): [number, number, number] | null {
    let best: [number, number, number] | null = null;
    for (const raw of range.split('||')) {
      const term = raw.trim();
      const m = term.match(/^(>=|>|\^|~)?\s*(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/);
      if (!m) throw new Error(`unsupported engines range term: "${term}" (in "${range}")`);
      const [, op, majorStr, minorStr, patchStr] = m;
      const maj = Number(majorStr);
      const min = minorStr && minorStr !== 'x' ? Number(minorStr) : 0;
      const patch = patchStr && patchStr !== 'x' ? Number(patchStr) : 0;
      let candidate: [number, number, number] | null = null;
      if (op === '>=' || op === '>') {
        if (major > maj) candidate = [major, 0, 0];
        else if (major === maj) candidate = [maj, min, op === '>' ? patch + 1 : patch];
      } else if (major === maj) {
        candidate = [maj, min, patch];
      }
      if (
        candidate &&
        (!best || candidate[1] < best[1] || (candidate[1] === best[1] && candidate[2] < best[2]))
      ) {
        best = candidate;
      }
    }
    return best;
  }

  describe.each(PROJECTS)('$label', ({ pkg: pkgPath, lock: lockPath }) => {
    const pkg = JSON.parse(read(pkgPath));
    const lockText = read(lockPath);
    const { engines, resolved } = readLock(lockPath, lockText);
    const declared = pkg.engines?.node as string;

    // Every declared dep that states an engines.node range, as
    // [name@version, range, kind] — the sweep set for the checks below.
    const constraints: Array<[string, string, string]> = [];
    for (const kind of ['dependencies', 'devDependencies']) {
      for (const name of Object.keys(pkg[kind] ?? {})) {
        const version = resolved.get(name);
        const range = version ? engines.get(`${name}@${version}`) : undefined;
        if (range) constraints.push([`${name}@${version}`, range, kind]);
      }
    }

    it('declares a plain >= floor', () => {
      expect(declared).toMatch(/^>=\d+\.\d+\.\d+$/);
    });

    it('is on the .nvmrc major', () => {
      expect(declared.replace(/^>=/, '').split('.')[0]).toBe(NODE_MAJOR);
    });

    it('resolves at least one dependency constraint from the lockfile', () => {
      // Guards the scrapers above: a lockfile format change that broke
      // parsing would otherwise make every check below vacuously pass.
      expect(constraints.length).toBeGreaterThan(5);
    });

    it('no declared dependency excludes the .nvmrc major', () => {
      const excluded = constraints
        .filter(([, range]) => !lowestOnMajor(range, Number(NODE_MAJOR)))
        .map(([id, range, kind]) => `${id} [${kind}] requires "${range}"`);
      expect(excluded, `these do not support Node ${NODE_MAJOR}`).toEqual([]);
    });

    it('floor is >= every declared dependency floor', () => {
      // THE undici CHECK. `engines.node` said `>=20` while a runtime dep
      // required `>=22.19.0`; nothing in the repo compared the two.
      const [, declaredMinor, declaredPatch] = declared.replace(/^>=/, '').split('.').map(Number);
      const violations: string[] = [];
      for (const [id, range, kind] of constraints) {
        const lowest = lowestOnMajor(range, Number(NODE_MAJOR));
        if (!lowest) continue;
        const [, minor, patch] = lowest;
        if (minor > declaredMinor || (minor === declaredMinor && patch > declaredPatch)) {
          violations.push(
            `${id} [${kind}] needs >=${lowest.join('.')} but engines.node says ${declared} ("${range}")`,
          );
        }
      }
      expect(violations, 'run `pnpm node:sync` to recompute engines.node').toEqual([]);
    });
  });
});

describe('the engines.node floor is EXECUTED in CI, not merely declared', () => {
  /**
   * docs/tests.md § "Failure classes", class 4 — declared-but-unexercised
   * claims: every support claim maps to a leg that executes it, or the claim
   * gets deleted. `engines.node` is such a claim, and until this leg existed
   * nothing ran it: `.nvmrc` holds a bare major, so every job floats on the
   * newest release of the line (v24.18.1 while this was written, three minors
   * above the advertised floor of 24.15.0). Any file in src/ or tests/ could
   * start depending on a 24.16+ API and CI would stay green while the package
   * promised 24.15.0 would do — which is class 4's own worked example ("new
   * tests crashed on the project's own minimum Node").
   */
  const leg = (): SetupNodeStep => {
    const steps = setupNodeSteps(ENGINES_MIN_LEG.workflow).filter(
      (step) => step.job === ENGINES_MIN_LEG.job,
    );
    expect(
      steps,
      `${ENGINES_MIN_LEG.workflow}: no "${ENGINES_MIN_LEG.job}" job setting Node up`,
    ).toHaveLength(1);
    return steps[0];
  };

  it('a CI job pins exactly the declared floor', () => {
    // The two-way pin. Raising engines.node without moving the leg fails
    // here; moving the leg off the floor fails here too.
    expect(leg().nodeVersion).toBe(ENGINES_FLOOR);
  });

  it('the floor is a full x.y.z, so the pin resolves to one release', () => {
    // `node-version: 24` would resolve to the newest 24.x and the leg would
    // silently duplicate the floating jobs — green, and worth nothing.
    expect(ENGINES_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the leg is on the .nvmrc major', () => {
    expect(ENGINES_FLOOR.split('.')[0]).toBe(NODE_MAJOR);
  });

  it('the leg runs BOTH unit and integration', () => {
    // The claim being executed is "this package runs on 24.15.0", and the
    // only evidence for it is the suites actually running there. A leg that
    // installed Node and stopped would pin a version and prove nothing.
    const runs = jobRunCommands(ENGINES_MIN_LEG.workflow, ENGINES_MIN_LEG.job).join('\n');
    expect(runs, 'the engines-minimum leg must run pnpm test:unit').toMatch(/pnpm test:unit/);
    expect(runs, 'the engines-minimum leg must run pnpm test:integration').toMatch(
      /pnpm test:integration/,
    );
  });

  it('the leg asserts the Node it actually got', () => {
    // setup-node does NOT fail a job when it cannot resolve the requested
    // version — it logs and leaves the runner's preinstalled Node in place.
    // Without an assertion the leg would then quietly re-run what `unit`
    // already covers and report green: escape class 3 (silent success)
    // nesting inside the guard for class 4. The step re-reads the floor from
    // package.json rather than repeating the literal a second time.
    const check = jobRunCommands(ENGINES_MIN_LEG.workflow, ENGINES_MIN_LEG.job).find((run) =>
      run.includes('process.version'),
    );
    expect(check, 'add a step asserting process.version is the engines.node floor').toBeDefined();
    expect(check, 'that step must read the floor from package.json, not a second literal').toMatch(
      /engines/,
    );
    expect(check).not.toMatch(new RegExp(ENGINES_FLOOR.replace(/\./g, '\\.')));
  });

  it('carbon declares the same floor, so this one leg covers both projects', () => {
    // The leg runs the ROOT suites only. That is honest coverage for the
    // whole repo exactly while carbon's computed floor equals root's — which
    // it does today (both >=24.15.0; `node:sync` computes each from its own
    // lockfile). If a carbon dependency ever raises carbon's floor above
    // root's, this fails, and the remedy is a decision rather than a bump:
    // either raise the root floor too, or give carbon's Template Tests job
    // its own minimum leg. Silently under-covering is the one option this
    // removes.
    const carbonFloor = (JSON.parse(read('carbon', 'package.json')).engines.node as string).replace(
      /^>=/,
      '',
    );
    expect(carbonFloor).toBe(ENGINES_FLOOR);
  });

  it('`pnpm node:sync` writes the leg, so a Node bump stays one command', () => {
    // The literal cannot read .nvmrc and cannot read package.json at
    // evaluation time, so it is the one workflow site the sync script owns.
    // Without this, `echo 26 > .nvmrc && pnpm node:sync` would leave the leg
    // on the old floor and only the assertion above would catch it — after
    // the fact, with no writer to fix it.
    const script = read('scripts', 'sync-node-version.js');
    expect(script).toMatch(/workflows.{0,3}, 'test\.yml'/);
    expect(script).toMatch(/node-version/);
  });
});

describe('other Node pins track .nvmrc', () => {
  it("the template's esbuild --target matches", () => {
    // Bundling for an older target than the image runs is silently
    // pessimal; bundling for a newer one silently ships syntax the runtime
    // may not accept.
    const targets = [...read('carbon', 'package.json').matchAll(/--target=node(\d+)/g)].map(
      (m) => m[1],
    );
    expect(targets.length).toBeGreaterThan(0);
    expect([...new Set(targets)]).toEqual([NODE_MAJOR]);
  });

  it('the sync script and this guard agree on the source file', () => {
    // If someone renames the source of truth, both halves must move.
    expect(read('scripts', 'sync-node-version.js')).toMatch(
      /readFileSync\(join\(ROOT, '\.nvmrc'\)/,
    );
  });
});

describe('the advertised requirement matches the enforced one', () => {
  // The prose sites are what a human reads before installing anything, and
  // they were the last category still maintained by hand. Both getting-started
  // pages sat at "Node.js 22+" for the entire life of the 24 line, telling
  // users to install a runtime that `engines.node` (>=24.15.0) rejects. A
  // guard that only compared machine pins to each other called that green.
  //
  // Derived here from package.json's own `engines.node` rather than from
  // .nvmrc's bare major, because the advertised number has to be the one a
  // user's install actually clears.
  const declared = JSON.parse(read('package.json')).engines.node as string;
  const floor = declared.replace(/^>=/, '');
  const expected = floor.replace(/\.0$/, '');

  /**
   * Every file that states the Node requirement in prose. A new user-facing
   * page that advertises a version must be registered here, so it cannot
   * quietly escape the sweep the way these two did.
   */
  const PROSE_SITES = [
    'README.md',
    join('carbon', 'content', 'docs', 'getting-started.mdx'),
    join('carbon', 'content', 'blog', 'getting-started.mdx'),
  ];

  const PROSE_PIN = /\*\*Node\.js (\d+(?:\.\d+)*)\+\*\*/g;

  for (const relPath of PROSE_SITES) {
    it(`${relPath} advertises ${expected}+`, () => {
      const found = [...read(relPath).matchAll(PROSE_PIN)].map((m) => m[1]);
      // A site that stopped stating a requirement is drift too: the reader
      // loses the prerequisite, and `pnpm node:sync` would have hard-failed.
      expect(found.length).toBeGreaterThan(0);
      expect([...new Set(found)]).toEqual([expected]);
    });
  }

  it('no other tracked file advertises a stale Node requirement', () => {
    // Catches a *new* page that states a version without being registered
    // above. Scoped to tracked, human-facing markdown; historical plans and
    // specs under docs/superpowers/ record what was true when written and are
    // deliberately not rewritten.
    const tracked = execFileSync('git', ['ls-files', '--', '*.md', '*.mdx'], {
      cwd: ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.startsWith('docs/superpowers/'))
      .filter((f) => !PROSE_SITES.includes(f));

    // If the walk ever finds nothing, the assertion below is vacuous.
    expect(tracked.length).toBeGreaterThan(0);

    const offenders = tracked.flatMap((relPath) => {
      const found = [...readFileSync(join(ROOT, relPath), 'utf-8').matchAll(PROSE_PIN)].map(
        (m) => m[1],
      );
      return found.filter((v) => v !== expected).map((v) => `${relPath}: ${v}`);
    });

    expect(
      offenders,
      `These files advertise a Node version other than ${expected}. Register them in ` +
        `PROSE_SITES here and in scripts/sync-node-version.js so \`pnpm node:sync\` ` +
        `maintains them:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the sync script owns exactly the sites this guard checks', () => {
    // Two-way pin. If one half gains a site and the other does not, the
    // unlisted half stops being maintained without anything going red.
    const script = read('scripts', 'sync-node-version.js');
    for (const relPath of PROSE_SITES) {
      const asJoin = relPath.includes('/')
        ? `join(${relPath
            .split('/')
            .map((p) => `'${p}'`)
            .join(', ')})`
        : `'${relPath}'`;
      expect(script).toContain(asJoin);
    }
  });
});
