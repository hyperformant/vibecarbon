# Orphaned local stacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vibecarbon project that is deleted, moved, or renamed while its local Docker stack exists never turns into a crash-looping zombie, a rename keeps the local database, and leftover stacks are easy to find and remove.

**Architecture:** Four layers. (1) Dev-only restart policy `on-failure:5` so a dead dev stack neither loops forever nor auto-starts at boot. (2) One read-only probe module, `src/lib/local-stacks.js`, that lists every vibecarbon compose stack on the Docker host from `docker inspect` labels and classifies it. (3) `vibecarbon up` pins `COMPOSE_PROJECT_NAME` in `.env` so the compose project (and so its volumes) no longer follows the folder name, adopts a stack whose folder moved, and refuses to hijack a stack whose folder still exists elsewhere (a copy). Deploy strips the pin so servers keep deriving the name from `/opt/<project>`. (4) `create`, `up`, `status` print a one-line warning about orphaned stacks, and `vibecarbon down -orphans` removes them, with volume deletion behind its own default-No prompt.

**Tech Stack:** Node ESM, `@clack/prompts`, vitest (unit + `DOCKER_INTEGRATION` tier), js-yaml, Docker Compose v2.

**Spec:** No separate spec file. The design was agreed in conversation on 2026-10-12 and is restated in the Background section below; executors treat Background + Global Constraints as the spec.

## Background (the incident this fixes)

Two local stacks crash-looped for three weeks on the maintainer's machine, churning ~350 virtual interfaces/hour and breaking Chrome (`ERR_NETWORK_CHANGED`):

- `~/repos/yippy` was deleted while its stack existed. At the next boot Docker tried to start the `unless-stopped` containers, auto-created every missing bind-mount source as an empty root-owned directory, `db` died ("not a directory"), and `auth`/`realtime`/`storage` restarted every ~30s forever (2,000+ restarts).
- The `carbon/` dev stack was created from a previous checkout at the same path. The current checkout lacked the untracked `docker-compose.dev-init.yml` + `volumes/db/super-admin.generated.sql`, so the same thing happened.

Today's compose project name is the folder basename (`deriveComposeProjectName(basename(cwd))` in `src/lib/subnet.js`), volumes are `<compose-project>_db_data`, and container names are `${PROJECT_NAME}-<service>`. So renaming `my-app` to `my-app2` today: the old stack is orphaned (same failure as a delete), and `vibecarbon up` in the new folder collides on container names/ports/subnet with the old stack, and past that would start an EMPTY database under `my-app2_db_data`.

## Global Constraints

- Flags are single-dash only (`down -orphans`, `-y`). `--long` is rejected by the parser (AGENTS.md "CLI conventions").
- User-facing strings: friendly second person, say why, lowercase informational hints, **no em dashes**, no emoji.
- Never parse or write `.env` text by hand: read with `parseDotenv` from `src/lib/dotenv.js`, write lines with `formatDotenvLine`. `tests/unit/lib/dotenv-dialect-census.test.ts` enforces this.
- Pinned name goes in `.env` (NOT `.env.local`): compose interpolates only `.env`, same reasoning as `setSubnetPrefix` in `src/up.js`.
- Deployed servers must keep their current compose project name. No change may alter what `docker compose` on a server resolves as the project name.
- Never delete a Docker volume without an explicit interactive "yes". Non-interactive runs keep volumes.
- Only stacks attached to a network named `<project>_vibecarbon-network` are vibecarbon stacks. Never list, warn about, or remove anything else.
- Docker probes in `create`/`up`/`status` are best-effort: any error, missing binary, or daemon down means "no stacks", silently, with a ≤3s timeout per docker call.
- Commit messages: conventional `fix(cli):` / `fix(template):` / `test:`. Never `!:` or a `BREAKING CHANGE` footer. Commit with pathspecs (`git commit -- <files>`); the checkout is shared.
- Gate before push: `pnpm test:prepush` (lint + unit + integration).

## Review Focus

1. **Docker absent or daemon stopped** during `create`/`status`/`up`: no warning, no thrown error, no multi-second hang. Pinned by `local-stacks.test.ts` "execFile throws" cases.
2. **Project copied with `cp -r`** while the original folder still exists: `up` in the copy must refuse rather than recreate the original's containers against the copy's files and share its database. Pinned in Task 4 (`resolveComposeProjectName` "folder still exists elsewhere" case).
3. **Deploy after the pin lands**: the server `.env` must not contain `COMPOSE_PROJECT_NAME`, even when the local value differs from the project name (the `carbon/` dev repo pins `carbon`, project name `vibecarbon`). Pinned in Task 4 bundle test.
4. **Non-vibecarbon compose projects on the same host** (a user's unrelated postgres stack): never shown, never removed. Pinned in Task 3 classification test.
5. **A moved project whose new folder hasn't been `up`'d yet** is indistinguishable from a deleted one when seen from another folder. The warning text and the volume prompt must both say "if you moved it, keep the data", and the volume prompt defaults to No. Pinned in Task 6 (`down -orphans` keeps volumes when the prompt is declined / off-TTY).

---

### Task 1: Dev stacks stop auto-restarting forever

**Files:**
- Modify: `carbon/docker-compose.override.yml`
- Modify: `carbon/docker-compose.n8n.override.yml`
- Modify: `carbon/docker-compose.metabase.override.yml`
- Test: `tests/unit/template/dev-restart-policy.test.ts` (create)

**Interfaces:** none consumed or produced.

Why `on-failure:5`: Docker docs (engine "start containers automatically"): `on-failure` "doesn't restart the container if the daemon restarts", and `:5` caps retries. So a dev stack whose folder vanished stays down after a reboot instead of looping. Tradeoff, accepted: after a reboot the dev stack is down until `vibecarbon up`. Servers are unaffected because `docker-compose.override.yml` and `*.override.yml` are dev-only (`getComposeFiles` in `carbon/scripts/lib/manifest.js` adds them only when `!options.prod`; deploy uses `COMPOSE_BASE_FILES` + `*.prod.yml` in `src/lib/deploy/bundle.js`).

Only override services that are `unless-stopped` in the base file. `docker-compose.metabase.yml` has a one-shot init service with `restart: "no"`; leave it alone. Never add a service to `docker-compose.override.yml` that is not defined in `docker-compose.yml` (compose errors on a partial service with no image).

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Dev stacks must not auto-restart forever. A project folder deleted or
 * moved while its stack existed left `unless-stopped` containers that
 * Docker restarted at every boot, auto-created their bind-mount sources as
 * empty directories, and crash-looped for weeks (2026-10-12 incident).
 * `on-failure:5` caps retries and is not restarted by a daemon restart.
 * The override files are dev-only; prod keeps `unless-stopped`.
 */

const ROOT = join(__dirname, '..', '..', '..');
type Compose = { services?: Record<string, { restart?: string }> };
const load = (rel: string) => yaml.load(readFileSync(join(ROOT, rel), 'utf-8')) as Compose;

const PAIRS: Array<[string, string]> = [
  ['carbon/docker-compose.yml', 'carbon/docker-compose.override.yml'],
  ['carbon/docker-compose.n8n.yml', 'carbon/docker-compose.n8n.override.yml'],
  ['carbon/docker-compose.metabase.yml', 'carbon/docker-compose.metabase.override.yml'],
];

describe('dev restart policy', () => {
  it.each(PAIRS)('every unless-stopped service in %s is on-failure:5 in %s', (base, override) => {
    const baseServices = load(base).services ?? {};
    const overrideServices = load(override).services ?? {};
    const restarting = Object.entries(baseServices)
      .filter(([, svc]) => svc.restart === 'unless-stopped')
      .map(([name]) => name);
    expect(restarting.length).toBeGreaterThan(0);
    for (const name of restarting) {
      expect(overrideServices[name]?.restart, `${override} → ${name}`).toBe('on-failure:5');
    }
  });

  it.each(PAIRS)('%s override defines no service missing from the base', (base, override) => {
    const baseNames = new Set(Object.keys(load(base).services ?? {}));
    for (const name of Object.keys(load(override).services ?? {})) {
      expect(baseNames.has(name), `${override} defines ${name}`).toBe(true);
    }
  });

  it('one-shot services keep restart "no"', () => {
    const services = load('carbon/docker-compose.metabase.override.yml').services ?? {};
    for (const [name, svc] of Object.entries(load('carbon/docker-compose.metabase.yml').services ?? {})) {
      if (svc.restart === 'no') expect(services[name]?.restart).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** on the first `it.each` (override has no `restart` keys).

Run: `pnpm vitest run --project unit tests/unit/template/dev-restart-policy.test.ts`

- [ ] **Step 3: Implement.** For each base service with `restart: unless-stopped`, add `restart: on-failure:5` under that service in the matching override file, merging into an existing service block where one exists (e.g. `db:` and `traefik:` already appear in `docker-compose.override.yml`). Add one comment at the top of each override's `services:` explaining why, e.g.:

```yaml
# Dev stacks cap restarts and don't come back on their own after a reboot:
# a project folder deleted or moved while its stack existed otherwise
# crash-loops forever. Run `vibecarbon up` after a reboot. Prod keeps
# unless-stopped (this file is never deployed).
```

- [ ] **Step 4: Run the test, expect PASS.** Then run `pnpm vitest run --project unit tests/unit/template tests/unit/create` to catch structural tests that read these files.

- [ ] **Step 5: Check upgrade reach.** Read `src/lib/upgrade-policy.js` around lines 17-21 and 82 and note in the commit body whether `vibecarbon upgrade` refreshes these override files in existing projects. Do not change upgrade policy in this task.

- [ ] **Step 6: Commit**

```bash
git add carbon/docker-compose.override.yml carbon/docker-compose.n8n.override.yml carbon/docker-compose.metabase.override.yml tests/unit/template/dev-restart-policy.test.ts
git commit -m "fix(template): cap dev stack restarts so a deleted project can't crash-loop" -- carbon/docker-compose.override.yml carbon/docker-compose.n8n.override.yml carbon/docker-compose.metabase.override.yml tests/unit/template/dev-restart-policy.test.ts
```

---

### Task 2: Ignore the dev-init outputs and correct the comment

**Files:**
- Modify: `.gitignore`
- Modify: `src/create.js:891-895` (comment only)
- Test: `tests/unit/meta/dev-init-gitignored.test.ts` (create; if `tests/unit/meta` has a different naming pattern, follow it)

**Interfaces:** none.

`carbon/scripts/dev-init.js` writes `carbon/docker-compose.dev-init.yml` and `carbon/volumes/db/super-admin.generated.sql`. They are npmignored (`carbon/.npmignore:47-48`) but not gitignored, though `src/create.js:891` says they are.

- [ ] **Step 1: Write the failing test**

```ts
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

describe('dev-init outputs are gitignored', () => {
  it.each([
    'carbon/docker-compose.dev-init.yml',
    'carbon/volumes/db/super-admin.generated.sql',
  ])('%s', (path) => {
    // --no-index: answer from .gitignore rules even if the path exists or is tracked.
    const out = execFileSync('git', ['check-ignore', '--no-index', path], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(out.trim()).toBe(path);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`git check-ignore` exits 1, execFileSync throws).

Run: `pnpm vitest run --project unit tests/unit/meta/dev-init-gitignored.test.ts`

- [ ] **Step 3: Implement.** Append to `.gitignore` next to the existing `carbon/.env` rule:

```gitignore
# Written by carbon/scripts/dev-init.js (dev admin credentials + the overlay that mounts them)
carbon/docker-compose.dev-init.yml
carbon/volumes/db/super-admin.generated.sql
```

In `src/create.js`, the comment `// generated (gitignored, npmignored) dev-repo overlay` stays accurate after this change; re-read it and leave it if so. If `git status` shows either file as tracked, stop and report rather than `git rm`.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add .gitignore tests/unit/meta/dev-init-gitignored.test.ts
git commit -m "fix(cli): gitignore the dev-init admin overlay and SQL" -- .gitignore tests/unit/meta/dev-init-gitignored.test.ts
```

---

### Task 3: `src/lib/local-stacks.js`, the read-only probe

**Files:**
- Create: `src/lib/local-stacks.js`
- Test: `tests/unit/lib/local-stacks.test.ts`

**Interfaces:**
- Produces:
  - `listVibecarbonStacks({ execFile?, timeoutMs? } = {}) → Stack[]`
  - `findOrphanStacks(stacks, { exists? } = {}) → Array<Stack & { reason: 'folder-missing' | 'files-missing' }>`
  - `type Stack = { project: string, workingDir: string, configFiles: string[], containers: Array<{ name: string, state: string }> }`
  - `formatStackPath(dir: string, home = os.homedir()) → string` (replaces a leading home dir with `~`)

Use `docker inspect`, not `docker ps --format`: `ps` flattens labels into one comma-joined string, and the `config_files` label itself contains commas.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  findOrphanStacks,
  formatStackPath,
  listVibecarbonStacks,
} from '../../../src/lib/local-stacks.js';

type Fake = { name: string; project: string; dir: string; files: string; net: string; state?: string };

function inspectJson(cs: Fake[]) {
  return JSON.stringify(
    cs.map((c) => ({
      Name: `/${c.name}`,
      State: { Status: c.state ?? 'running' },
      Config: {
        Labels: {
          'com.docker.compose.project': c.project,
          'com.docker.compose.project.working_dir': c.dir,
          'com.docker.compose.project.config_files': c.files,
        },
      },
      NetworkSettings: { Networks: { [c.net]: {} } },
    })),
  );
}

/** ps returns ids; inspect returns the JSON. */
function fakeDocker(cs: Fake[]) {
  const calls: string[][] = [];
  const fn = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') return cs.map((_, i) => `id${i}`).join('\n');
    if (args[0] === 'inspect') return inspectJson(cs);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { fn, calls };
}

const yippy: Fake = {
  name: 'yippy-db',
  project: 'yippy',
  dir: '/home/u/repos/yippy',
  files: '/home/u/repos/yippy/docker-compose.yml,/home/u/repos/yippy/docker-compose.override.yml',
  net: 'yippy_vibecarbon-network',
};

describe('listVibecarbonStacks', () => {
  it('groups containers by compose project', () => {
    const { fn } = fakeDocker([yippy, { ...yippy, name: 'yippy-auth', state: 'restarting' }]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([
      {
        project: 'yippy',
        workingDir: '/home/u/repos/yippy',
        configFiles: [
          '/home/u/repos/yippy/docker-compose.yml',
          '/home/u/repos/yippy/docker-compose.override.yml',
        ],
        containers: [
          { name: 'yippy-db', state: 'running' },
          { name: 'yippy-auth', state: 'restarting' },
        ],
      },
    ]);
  });

  it('ignores compose projects that are not on a vibecarbon network', () => {
    const other = { ...yippy, name: 'pg-1', project: 'pg', net: 'pg_default' };
    const { fn } = fakeDocker([other]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('returns [] without calling inspect when there are no compose containers', () => {
    const { fn, calls } = fakeDocker([]);
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
    expect(calls.map((a) => a[0])).toEqual(['ps']);
  });

  it('returns [] when docker is missing or the daemon is down', () => {
    const fn = () => {
      throw new Error('spawn docker ENOENT');
    };
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('returns [] on unparseable inspect output', () => {
    const fn = (_c: string, args: string[]) => (args[0] === 'ps' ? 'id0' : '{not json');
    expect(listVibecarbonStacks({ execFile: fn })).toEqual([]);
  });

  it('passes a timeout to every docker call', () => {
    const { fn, calls } = fakeDocker([yippy]);
    const seen: unknown[] = [];
    listVibecarbonStacks({
      execFile: (c: string, a: string[], o: { timeout?: number }) => {
        seen.push(o.timeout);
        return fn(c, a);
      },
      timeoutMs: 1234,
    });
    expect(calls.length).toBe(2);
    expect(seen).toEqual([1234, 1234]);
  });
});

describe('findOrphanStacks', () => {
  const stack = {
    project: 'yippy',
    workingDir: '/gone',
    configFiles: ['/gone/docker-compose.yml'],
    containers: [],
  };

  it('flags a stack whose folder is gone', () => {
    const out = findOrphanStacks([stack], { exists: () => false });
    expect(out).toEqual([{ ...stack, reason: 'folder-missing' }]);
  });

  it('flags a stack whose folder exists but a compose file it was started with is gone', () => {
    const s = {
      ...stack,
      workingDir: '/repo/carbon',
      configFiles: ['/repo/carbon/docker-compose.yml', '/repo/carbon/docker-compose.dev-init.yml'],
    };
    const exists = (p: string) => p !== '/repo/carbon/docker-compose.dev-init.yml';
    expect(findOrphanStacks([s], { exists })).toEqual([{ ...s, reason: 'files-missing' }]);
  });

  it('leaves healthy stacks alone', () => {
    expect(findOrphanStacks([stack], { exists: () => true })).toEqual([]);
  });
});

describe('formatStackPath', () => {
  it('abbreviates the home directory', () => {
    expect(formatStackPath('/home/u/repos/yippy', '/home/u')).toBe('~/repos/yippy');
    expect(formatStackPath('/srv/app', '/home/u')).toBe('/srv/app');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found).

Run: `pnpm vitest run --project unit tests/unit/lib/local-stacks.test.ts`

- [ ] **Step 3: Implement**

```js
/**
 * Every vibecarbon compose stack on this Docker host, read from the labels
 * Compose stamps on each container, and which of them have lost the folder
 * they were started from.
 *
 * A project folder deleted, moved, or renamed while its stack existed leaves
 * `unless-stopped` containers Docker restarts at every boot. It auto-creates
 * each missing bind-mount source as an empty directory, the db dies, and the
 * services that need it crash-loop forever (2026-10-12: three weeks, 2,000+
 * restarts, Chrome ERR_NETWORK_CHANGED from interface churn).
 *
 * Read-only and best-effort: any docker failure means "no stacks".
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const NETWORK_SUFFIX = '_vibecarbon-network';
const PROJECT_LABEL = 'com.docker.compose.project';
const DIR_LABEL = 'com.docker.compose.project.working_dir';
const FILES_LABEL = 'com.docker.compose.project.config_files';

/**
 * @param {{ execFile?: typeof execFileSync, timeoutMs?: number }} [options]
 * @returns {Array<{ project: string, workingDir: string, configFiles: string[], containers: Array<{ name: string, state: string }> }>}
 */
export function listVibecarbonStacks({ execFile = execFileSync, timeoutMs = 3000 } = {}) {
  const opts = { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] };
  let inspected;
  try {
    const ids = String(
      execFile('docker', ['ps', '-aq', '--filter', `label=${PROJECT_LABEL}`], opts),
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    inspected = JSON.parse(String(execFile('docker', ['inspect', ...ids], opts)));
  } catch {
    return [];
  }
  if (!Array.isArray(inspected)) return [];

  const byProject = new Map();
  for (const c of inspected) {
    const labels = c?.Config?.Labels ?? {};
    const project = labels[PROJECT_LABEL];
    const networks = Object.keys(c?.NetworkSettings?.Networks ?? {});
    if (!project || !networks.some((n) => n.endsWith(NETWORK_SUFFIX))) continue;
    if (!byProject.has(project)) {
      byProject.set(project, {
        project,
        workingDir: labels[DIR_LABEL] ?? '',
        configFiles: (labels[FILES_LABEL] ?? '').split(',').filter(Boolean),
        containers: [],
      });
    }
    byProject.get(project).containers.push({
      name: String(c.Name ?? '').replace(/^\//, ''),
      state: c?.State?.Status ?? 'unknown',
    });
  }
  return [...byProject.values()];
}

/**
 * Stacks whose folder is gone, or whose folder exists but no longer holds a
 * compose file the stack was started with (a different checkout at the same
 * path). Either way `docker compose up` from that folder can't recreate it.
 */
export function findOrphanStacks(stacks, { exists = existsSync } = {}) {
  const orphans = [];
  for (const stack of stacks) {
    if (!stack.workingDir || !exists(stack.workingDir)) {
      orphans.push({ ...stack, reason: 'folder-missing' });
    } else if (stack.configFiles.some((f) => !exists(f))) {
      orphans.push({ ...stack, reason: 'files-missing' });
    }
  }
  return orphans;
}

export function formatStackPath(dir, home = homedir()) {
  return home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
}
```

- [ ] **Step 4: Run, expect PASS.** Then `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-stacks.js tests/unit/lib/local-stacks.test.ts
git commit -m "feat(cli): probe local vibecarbon stacks and find ones whose folder is gone" -- src/lib/local-stacks.js tests/unit/lib/local-stacks.test.ts
```

---

### Task 4: Pin the compose project name so a rename keeps the database

**Files:**
- Create: `src/lib/compose-project-name.js`
- Modify: `src/up.js` (call before the port-conflict check, ~line 292)
- Modify: `src/lib/deploy/bundle.js` (~line 316-380: strip `COMPOSE_PROJECT_NAME` from the shipped `.env`)
- Test: `tests/unit/lib/compose-project-name.test.ts`, extend the existing bundle `.env` test (find it with `git grep -l "stripOperatorSecretLines\|renderBundle" tests/unit`)
- Test: `tests/integration/docker/rename-keeps-volume.test.ts` (DOCKER_INTEGRATION tier)

**Interfaces:**
- Consumes: `listVibecarbonStacks`, `formatStackPath` from Task 3; `deriveComposeProjectName` from `src/lib/subnet.js`.
- Produces: `resolveComposeProjectName({ cwd, projectName, pinned, stacks, exists? }) → { action: 'keep' | 'pin' | 'adopt' | 'refuse', name?: string, from?: string }`

Decision table (`projectName` = `PROJECT_NAME` from the env files; `pinned` = `COMPOSE_PROJECT_NAME` from `.env` or null). A stack "belongs to this project" when one of its containers is named `${projectName}-db` (container names come from `${PROJECT_NAME}` in the compose file and are globally unique on a host, so this is the reliable key):

| Owning stack | Its workingDir | Result |
|---|---|---|
| none | | `pinned` ? keep : pin `deriveComposeProjectName(basename(cwd))` |
| found | equals `cwd` | `pinned` ? keep : pin `stack.project` |
| found | does not exist | adopt: pin `stack.project` (folder was moved or renamed), `from` = old dir |
| found | exists, differs from `cwd` | refuse, `from` = that dir (this folder is a copy) |

`keep` writes nothing. `pin` and `adopt` write `COMPOSE_PROJECT_NAME` to `.env` with the same pattern as `setSubnetPrefix` (`src/up.js:214`), via `formatDotenvLine`, with the comment `# Local Docker stack name (pinned by vibecarbon up so renaming the folder keeps your data)`. Pinning to the CURRENT name for existing projects means no existing stack changes name, so no existing local database moves.

Messages in `up` (no em dashes, lowercase hints):
- adopt: `p.log.info(\`this project moved from ${formatStackPath(from)}, so vibecarbon is reusing its local database\`)`
- refuse: `p.log.error(\`${projectName} already has a local stack running from ${formatStackPath(from)}\`)` then `p.log.info('if this folder is a copy, give it its own PROJECT_NAME in .env and .env.local, or run `vibecarbon down` in the other folder first')` and `process.exit(1)`.

- [ ] **Step 1: Write the failing unit tests** for every row of the table, plus: `pinned` set and owning stack in a different existing dir still refuses; `projectName` missing (null) behaves as "no owning stack". Use `exists` injection; stacks are plain objects shaped like Task 3's `Stack`.

```ts
import { describe, expect, it } from 'vitest';
import { resolveComposeProjectName } from '../../../src/lib/compose-project-name.js';

const stack = (project: string, workingDir: string, names = ['my-app-db']) => ({
  project,
  workingDir,
  configFiles: [`${workingDir}/docker-compose.yml`],
  containers: names.map((name) => ({ name, state: 'running' })),
});

describe('resolveComposeProjectName', () => {
  const base = { cwd: '/p/my-app2', projectName: 'my-app', pinned: null };

  it('pins the folder-derived name for a fresh project', () => {
    expect(resolveComposeProjectName({ ...base, stacks: [], exists: () => true })).toEqual({
      action: 'pin',
      name: 'my-app2',
    });
  });

  it('keeps an existing pin when nothing conflicts', () => {
    expect(
      resolveComposeProjectName({ ...base, pinned: 'my-app', stacks: [], exists: () => true }),
    ).toEqual({ action: 'keep', name: 'my-app' });
  });

  it('pins the running stack name when the stack is already ours', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app2')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app' });
  });

  it('adopts a stack whose folder is gone (renamed or moved)', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app')],
      exists: (p: string) => p !== '/p/my-app',
    });
    expect(r).toEqual({ action: 'adopt', name: 'my-app', from: '/p/my-app' });
  });

  it('refuses when the stack belongs to a folder that still exists (a copy)', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'refuse', from: '/p/my-app' });
  });

  it('refuses a copy even when a pin was copied along with .env', () => {
    const r = resolveComposeProjectName({
      ...base,
      pinned: 'my-app',
      stacks: [stack('my-app', '/p/my-app')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'refuse', from: '/p/my-app' });
  });

  it('ignores stacks that belong to other projects', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('other', '/p/other', ['other-db'])],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app2' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `pnpm vitest run --project unit tests/unit/lib/compose-project-name.test.ts`

- [ ] **Step 3: Implement `src/lib/compose-project-name.js`** as a pure function per the table (`exists` defaults to `existsSync`; `basename` from `node:path`; when `pinned` is set and there is no conflict, return `{ action: 'keep', name: pinned }`).

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Bundle strip, failing test first.** In the bundle `.env` test, write a local `.env` containing `COMPOSE_PROJECT_NAME=carbon` and `PROJECT_NAME=vibecarbon`, render the bundle, assert the staged `.env` has no `COMPOSE_PROJECT_NAME=` line. Run, expect FAIL. Then in `src/lib/deploy/bundle.js`, drop any line matching `/^COMPOSE_PROJECT_NAME=/` from `envContent` right after `stripOperatorSecretLines`, with a comment: servers derive the compose project from `/opt/<project>`; a local pin from a renamed folder would move the server stack to new, empty volumes. Run, expect PASS. Also `git grep -n "'\.env'" src/lib/deploy` and confirm no other path ships the local `.env` verbatim (e.g. `src/lib/deploy/utils.js:323`); strip there too if it does, same test pattern.

- [ ] **Step 6: Wire into `up`.** In `src/up.js` after `assertDockerRunning()` and before the port check: read `PROJECT_NAME` and `COMPOSE_PROJECT_NAME` with the existing `getEnvValue`, but read the pin from `.env` only (parse `.env` with `parseDotenv`), call `listVibecarbonStacks()` and `resolveComposeProjectName`, act on the result as specified above, and set `process.env.COMPOSE_PROJECT_NAME` to the resolved name so the later subnet check (`src/up.js:337`) and `dev:start` child see it. Add a `setComposeProjectName(name, cwd)` writer beside `setSubnetPrefix`.

- [ ] **Step 7: Docker integration test (real compose, proves the assumptions).** `tests/integration/docker/rename-keeps-volume.test.ts`, gated like `docker-services.test.ts` (`DOCKER_INTEGRATION === 'true'`). In a temp dir `a/`, write a tiny compose file: one `alpine` service `sleep 3600` with `container_name: rkv-db`, network `vibecarbon-network`, named volume `data:/data`; `.env` with `COMPOSE_PROJECT_NAME=rkv`. `docker compose up -d`, write a marker into `/data`. Rename `a/` to `b/`. Assert `findOrphanStacks(listVibecarbonStacks())` includes project `rkv` with `reason: 'folder-missing'`. Run `docker compose up -d` in `b/`; assert it succeeds, the marker is still in `/data`, and the container's `working_dir` label is now `b/`. `afterAll`: `docker compose -p rkv down -v`. Run with `DOCKER_INTEGRATION=true pnpm vitest run --project integration tests/integration/docker/rename-keeps-volume.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/compose-project-name.js src/up.js src/lib/deploy/bundle.js tests/unit/lib/compose-project-name.test.ts tests/integration/docker/rename-keeps-volume.test.ts <bundle test file>
git commit -m "fix(cli): pin the local stack name so renaming a project keeps its database" -- <same paths>
```

Commit body must include a **Compatibility** note: existing projects get `COMPOSE_PROJECT_NAME` written on their next `up`, pinned to the name they already use, so nothing moves; deploy never ships it.

---

### Task 5: Warn about orphaned stacks in `create`, `up`, `status`

**Files:**
- Create: `src/lib/orphan-stack-notice.js`
- Modify: `src/create.js` (right after `introCommand`/arg parsing, before scaffolding), `src/up.js` (after Task 4's resolution), `src/status.js` (`checkLocalDev` / `renderLocalDev`)
- Test: `tests/unit/lib/orphan-stack-notice.test.ts`

**Interfaces:**
- Consumes: `listVibecarbonStacks`, `findOrphanStacks`, `formatStackPath`.
- Produces: `formatOrphanNotice(orphans, { home? }) → string[] | null` (pure; null when empty) and `warnAboutOrphanStacks({ exclude?: string[], list?, find?, log? } = {}) → void` (`exclude` = compose project names to skip). In `up`, always pass the name Task 4 resolved: whether adopted, pinned, or kept, `dev:start` is about to recreate that stack, so it must never be reported as an orphan of itself.

Text (exact):
- One stack: `found a local stack whose project folder is gone: yippy (~/repos/yippy)`
- N stacks: `found 2 local stacks whose project folders are gone: yippy (~/repos/yippy), carbon (~/repos/vibecarbon/carbon)`
- `files-missing` stacks are described with the same line; the folder-vs-files detail belongs in `down -orphans`.
- Hint lines: `if you moved a project, run \`vibecarbon up\` in its new folder to pick it back up` and `otherwise \`vibecarbon down -orphans\` removes them`

Use `p.log.warn` for the first line and `p.log.info` for the hints.

- [ ] **Step 1: Failing tests** for `formatOrphanNotice`: empty → null; one stack; two stacks; home abbreviation. For `warnAboutOrphanStacks`: `exclude` filters by project; a throwing `list` logs nothing and does not throw.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the module and wire the three call sites. In `status`, put the lines inside the Local Development note (via `renderLocalDev`) rather than as separate log lines, and fetch the stacks in `checkLocalDev`'s `Promise.allSettled` so status pays no extra serial latency. In `create`, call it once before scaffolding.
- [ ] **Step 4: Run, expect PASS.** Run `pnpm vitest run --project unit tests/unit/status tests/unit/create` and fix any snapshot or call-count expectations that the new probe disturbs by injecting a stub, not by loosening assertions.
- [ ] **Step 5: Commit** `feat(cli): warn when a local stack outlived its project folder` with pathspecs.

---

### Task 6: `vibecarbon down -orphans`

**Files:**
- Modify: `src/down.js`
- Modify: `AGENTS.md` (CLI Commands block: add `vibecarbon down -orphans   # Remove local stacks whose project folder is gone`)
- Test: `tests/unit/down/orphans.test.ts` (or the existing down test dir if one exists: `ls tests/unit | grep -i down`)

**Interfaces:**
- Consumes: Task 3 exports.
- Produces: `removeOrphanStacks({ list?, find?, run?, confirm?, isTTY?, log? }) → Promise<{ removed: string[], keptVolumes: string[] }>` exported for tests; `run` is an injected `execFileSync`-shaped function.

Behavior:
1. `SPEC.flags` gains `{ name: 'orphans', boolean: true, description: 'Remove local stacks whose project folder is gone' }` and `{ name: 'y', boolean: true, description: 'Skip the confirmation' }`. With `-orphans`, skip `assertInProjectDir()` and the `dev:stop` path entirely.
2. No orphans: `p.log.info('no orphaned local stacks found')`, exit 0.
3. List each orphan: `yippy (~/repos/yippy), folder is gone` or `carbon (~/repos/vibecarbon/carbon), started from files that are no longer there`.
4. Confirm removal of containers + network (`p.confirm`, default true) unless `-y`. Off-TTY without `-y`: use `requireTTYOrFlags` with requirement `{ flag: 'y', description: 'confirm removing the listed stacks', satisfied: false }`.
5. For each: `docker compose -p <project> down --remove-orphans` (works without the compose files; verified on 2026-10-12 against the yippy stack).
6. Volumes: `docker volume ls -q --filter label=com.docker.compose.project=<project>`. If any, and on a TTY, `p.confirm` with `initialValue: false`: message `delete <project>'s data volumes too? this can't be undone` and a preceding `p.log.info('if you moved this project, keep them: \`vibecarbon up\` in its new folder reuses them')`. Yes → `docker volume rm <names>`. No, `-y`, or off-TTY → keep, and print `p.log.info(\`kept ${names.join(', ')}; remove later with docker volume rm ${names.join(' ')}\`)`. `-y` never deletes volumes.

- [ ] **Step 1: Failing tests** with injected fakes: no orphans; containers removed with the exact compose argv; volumes kept when confirm returns false; volumes kept with `-y`; volumes kept off-TTY; volumes removed when confirm returns true; a `files-missing` stack lists the right reason; a non-orphan stack is never passed to `run`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in `src/down.js`, keeping the existing `dev:stop` path unchanged for plain `vibecarbon down`.
- [ ] **Step 4: Run, expect PASS.** Then `pnpm vitest run --project integration tests/integration/cli` for help-output tests that snapshot `down -h`; update snapshots only for the new flag lines.
- [ ] **Step 5: Commit** `feat(cli): add down -orphans to remove stacks whose project folder is gone` with pathspecs.

---

### Task 7: Gate and live check

- [ ] **Step 1:** `pnpm test:prepush`. All green, or report the failing output verbatim.
- [ ] **Step 2:** `DOCKER_INTEGRATION=true pnpm vitest run --project integration tests/integration/docker/rename-keeps-volume.test.ts`.
- [ ] **Step 3: Live check against the real leftover stack.** The maintainer's machine still has the stopped `vibecarbon-*` stack (compose project `carbon`, started from an older checkout). From the repo root: `node src/cli.js status` inside `carbon/` should show the orphan line naming `carbon (~/repos/vibecarbon/carbon)`; `node src/cli.js down -orphans` should list it with "started from files that are no longer there". **Do not confirm removal**; answer No and report the output. The maintainer decides about that stack.
