# `status` Docker-native local health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Docker Services" block of `vibecarbon status` report the health of *this project's* containers, including stopped ones and `vibecarbon add` add-ons, instead of HTTP-probing whatever happens to own `localhost:8000`.

**Architecture:** `checkDockerContainers(projectName)` in `src/status.js` is rewritten to enumerate `docker ps -a` for containers prefixed `${projectName}-` and derive health from Docker's own `State`/`Status` (compose healthchecks). Only the two core services with no compose healthcheck (`rest`, `meta`) keep an HTTP probe, routed through the port that `${projectName}-kong` actually bound (`docker port`). A pure `formatDockerServiceLines(docker)` helper is split out of `renderLocalDev` so the rendering of every state is unit-testable. Both functions take a `deps` object for injection, matching `checkReplication` in the same file.

**Tech Stack:** Node ESM, vitest (unit project), `runCommand` from `src/lib/command.js`, `docker` CLI.

**Spec:** Conversation on 2026-09-18 (letsgo diagnosis). Summary of defects being fixed, all in `src/status.js:132-266`:
1. Fixed `localhost:8000` probe: any project's Kong answers, rows report on the wrong stack.
2. `docker ps` without `-a`: exited containers (the failing one) are omitted from the list.
3. Docker healthchecks ignored even though compose defines them for db, kong, auth, realtime, storage, imgproxy, studio.
4. Port resolution ignores `DEV_KONG_PORT` and stops at the first env file that exists (diverges from `src/up.js:71-76`).
5. Hardcoded 8-service list: `traefik`, `app`, `imgproxy` and every `vibecarbon add` container (`-redis`, `-n8n`, `-metabase`, `-grafana`, ...) are invisible.

## Global Constraints

- No breaking-change commit footers (`!:` / `BREAKING CHANGE`) on main. Conventional commit prefix `fix(status):`.
- Commit with pathspecs (`git commit -- <files>`), check `git diff --cached` first; this checkout is shared across sessions.
- `pnpm lint` must pass (biome). `pnpm test:unit` must pass.
- `--json` output shape: `localDev.docker[]` rows keep `name`, `container`, `health`, `latencyMs`. New fields `label` and `detail` are additive. `health` gains values `starting`, `done`, `unknown` alongside `healthy` / `unhealthy`.
- No emoji in CLI output. Icons stay `●` (`●`) / `○` (`○`).
- Only `docker` CLI invocations via `runCommand([...argv], { silent: true, timeout, ignoreError: true })`, never string shell commands.

---

## File Structure

- Modify: `src/status.js`
  - `checkDockerContainers(projectName, deps = {})` (lines 132-266): rewritten. Enumerates containers, classifies from Docker state, HTTP-probes `rest`/`meta` via the discovered Kong port.
  - New module-level constants next to it: `SERVICE_DISPLAY_NAMES`, `CORE_SERVICE_ORDER`, `GATEWAY_PROBES`.
  - New exported pure helpers: `classifyContainer(container, state, status)`, `parseKongHostPort(dockerPortOutput)`, `formatDockerServiceLines(docker)`.
  - `renderLocalDev(data)` (lines 629-671): Docker section delegates to `formatDockerServiceLines`.
  - Export list at the bottom (line 1192) gains the new helpers and `checkDockerContainers`.
- Create: `tests/unit/status/docker-services.test.ts` — unit tests for classification, port parsing, enumeration with injected `runCommand`/`fetch`, and line formatting.

The DEV_PORT_OFFSET parsing inside `checkDockerContainers` (lines 210-231) is deleted; the port now comes from Docker. `getPortConfig()` (line 274) is untouched — it serves the API/Vite rows.

---

### Task 1: Pure classification and port parsing

**Files:**
- Modify: `src/status.js:132-266` (add constants + helpers above `checkDockerContainers`; do not rewrite the function yet)
- Modify: `src/status.js:1192` (export list)
- Test: `tests/unit/status/docker-services.test.ts` (create)

**Interfaces:**
- Produces:
  ```js
  // Row shape used by every later task:
  // { name: string, container: string, health: 'healthy'|'unhealthy'|'starting'|'done'|'unknown',
  //   label: string, detail: string, latencyMs: number }
  export function classifyContainer(container, state, status) // -> { health, label, detail }
  export function parseKongHostPort(output)                    // -> number | null
  export const SERVICE_DISPLAY_NAMES                           // { db: 'PostgreSQL', ... }
  export const CORE_SERVICE_ORDER                              // ['traefik', 'db', 'kong', ...]
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/status/docker-services.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyContainer, parseKongHostPort } from '../../../src/status.js';

describe('classifyContainer', () => {
  it('maps a running container with a passing healthcheck to healthy', () => {
    expect(classifyContainer('auth', 'running', 'Up 15 minutes (healthy)')).toEqual({
      health: 'healthy',
      label: 'healthy',
      detail: '',
    });
  });

  it('maps a running container with a failing healthcheck to unhealthy', () => {
    expect(classifyContainer('auth', 'running', 'Up 15 minutes (unhealthy)')).toEqual({
      health: 'unhealthy',
      label: 'unhealthy',
      detail: '',
    });
  });

  it('maps a running container whose healthcheck is still starting to starting', () => {
    expect(classifyContainer('db', 'running', 'Up 3 seconds (health: starting)')).toEqual({
      health: 'starting',
      label: 'starting',
      detail: '',
    });
  });

  it('counts a running container with no healthcheck as healthy, labelled running', () => {
    expect(classifyContainer('traefik', 'running', 'Up 15 minutes')).toEqual({
      health: 'healthy',
      label: 'running',
      detail: '',
    });
  });

  it('reports an exited container as unhealthy with the Docker status as detail', () => {
    expect(classifyContainer('kong', 'exited', 'Exited (128) 24 minutes ago')).toEqual({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 24 minutes ago',
    });
  });

  it('treats a *-setup one-shot container that exited 0 as done', () => {
    expect(classifyContainer('metabase-setup', 'exited', 'Exited (0) 2 hours ago')).toEqual({
      health: 'done',
      label: 'done',
      detail: '',
    });
  });

  it('treats a *-setup one-shot container that exited non-zero as unhealthy', () => {
    expect(classifyContainer('n8n-setup', 'exited', 'Exited (1) 2 hours ago')).toEqual({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (1) 2 hours ago',
    });
  });

  it('does not treat a core service that exited 0 as done', () => {
    expect(classifyContainer('db', 'exited', 'Exited (0) 5 minutes ago').health).toBe('unhealthy');
  });

  it('reports restarting as unhealthy with the Docker status as detail', () => {
    expect(classifyContainer('realtime', 'restarting', 'Restarting (1) 5 seconds ago')).toEqual({
      health: 'unhealthy',
      label: 'restarting',
      detail: 'Restarting (1) 5 seconds ago',
    });
  });

  it('reports any other state (created, paused, dead) as unhealthy labelled by state', () => {
    expect(classifyContainer('app', 'created', 'Created')).toEqual({
      health: 'unhealthy',
      label: 'created',
      detail: 'Created',
    });
    expect(classifyContainer('app', 'paused', 'Up 2 minutes (Paused)').label).toBe('paused');
  });
});

describe('parseKongHostPort', () => {
  it('returns the host port from docker port output', () => {
    expect(parseKongHostPort('0.0.0.0:8000\n[::]:8000\n')).toBe(8000);
  });

  it('honours a non-default binding', () => {
    expect(parseKongHostPort('0.0.0.0:8100\n')).toBe(8100);
  });

  it('returns null for empty output (container not running)', () => {
    expect(parseKongHostPort('')).toBeNull();
    expect(parseKongHostPort(null)).toBeNull();
  });

  it('returns null for unparseable output', () => {
    expect(parseKongHostPort('Error: No such container: letsgo-kong')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/docker-services.test.ts`
Expected: FAIL — `classifyContainer` / `parseKongHostPort` are not exported from `src/status.js`.

- [ ] **Step 3: Add the constants and helpers**

In `src/status.js`, directly above `async function checkDockerContainers(projectName) {` (line 132), insert:

```js
// Display names for the core compose services. Anything not listed here
// (vibecarbon add add-ons such as redis, grafana, n8n) renders under its
// compose service name so nothing in the project's stack is ever hidden.
const SERVICE_DISPLAY_NAMES = {
  traefik: 'Traefik',
  db: 'PostgreSQL',
  kong: 'Kong Gateway',
  auth: 'Auth (GoTrue)',
  rest: 'REST (PostgREST)',
  realtime: 'Realtime',
  storage: 'Storage',
  imgproxy: 'ImgProxy',
  meta: 'Meta',
  studio: 'Studio',
  app: 'App',
};

// Core services render first, in this order; everything else follows
// alphabetically.
const CORE_SERVICE_ORDER = Object.keys(SERVICE_DISPLAY_NAMES);

// Core services whose container may carry no healthcheck. Probed through Kong only when
// Docker offers no verdict, on whichever host port THIS project's kong container bound.
const GATEWAY_PROBES = {
  rest: { path: '/rest/v1/', acceptCodes: [200, 401] },
  meta: { path: '/pg/', acceptCodes: [200, 401] },
};

/**
 * Derive a status row's health from Docker's own view of the container.
 *
 * `state` is `{{.State}}` (running / exited / restarting / created / paused /
 * dead); `status` is `{{.Status}}`, which carries the compose healthcheck
 * verdict as a suffix ("Up 2m (healthy)", "Up 3s (health: starting)").
 *
 * A running container with no healthcheck is counted healthy but labelled
 * "running" so the table doesn't overclaim. One-shot init containers
 * (`*-setup`) that exited 0 are "done" and excluded from the healthy total.
 *
 * @param {string} container compose service name (prefix already stripped)
 * @param {string} state
 * @param {string} status
 * @returns {{health: 'healthy'|'unhealthy'|'starting'|'done'|'unknown', label: string, detail: string}}
 */
function classifyContainer(container, state, status) {
  if (state === 'running') {
    if (/\(healthy\)/.test(status)) return { health: 'healthy', label: 'healthy', detail: '' };
    if (/\(unhealthy\)/.test(status)) return { health: 'unhealthy', label: 'unhealthy', detail: '' };
    if (/\(health: starting\)/.test(status)) {
      return { health: 'starting', label: 'starting', detail: '' };
    }
    return { health: 'healthy', label: 'running', detail: '' };
  }
  if (state === 'exited') {
    const exitCode = status.match(/^Exited \((\d+)\)/)?.[1];
    if (exitCode === '0' && container.endsWith('-setup')) {
      return { health: 'done', label: 'done', detail: '' };
    }
    return { health: 'unhealthy', label: 'exited', detail: status };
  }
  return { health: 'unhealthy', label: state, detail: status };
}

/**
 * Parse `docker port <container> 8000/tcp` output ("0.0.0.0:8000\n[::]:8000")
 * into the host port. Null when the container isn't running or the output
 * isn't a binding.
 *
 * @param {string|null|undefined} output
 * @returns {number|null}
 */
function parseKongHostPort(output) {
  const first = (output || '').split('\n').find((line) => line.trim());
  const match = first?.trim().match(/:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}
```

Then change the export line at the bottom of the file (`export { getBranchName, main, providerDisplayName, resolveEnvProvider, SPEC, VERSION };`) to:

```js
export {
  CORE_SERVICE_ORDER,
  classifyContainer,
  getBranchName,
  main,
  parseKongHostPort,
  providerDisplayName,
  resolveEnvProvider,
  SERVICE_DISPLAY_NAMES,
  SPEC,
  VERSION,
};
```

`GATEWAY_PROBES` stays module-private; Task 2 uses it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit tests/unit/status/docker-services.test.ts`
Expected: PASS (14 tests). Then `pnpm lint` — expected clean. If biome complains that the new constants are unused, that's expected until Task 2 wires them; suppress nothing, just proceed to Task 2 before committing lint-clean if needed. (Biome's `noUnusedVariables` does not flag exported bindings; `GATEWAY_PROBES` is the only unexported one and is used in Task 2. If lint fails on it, temporarily export it and remove that export in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add tests/unit/status/docker-services.test.ts src/status.js
git diff --cached --stat
git commit -m "fix(status): classify local containers from Docker state, not a fixed port probe" -- tests/unit/status/docker-services.test.ts src/status.js
```

---

### Task 2: Rewrite `checkDockerContainers` to enumerate the project's stack

**Files:**
- Modify: `src/status.js` — replace the body of `checkDockerContainers` (the original lines 132-266 region, now below the Task 1 helpers)
- Modify: `src/status.js` export list (add `checkDockerContainers`)
- Test: `tests/unit/status/docker-services.test.ts` (append)

**Interfaces:**
- Consumes: `classifyContainer`, `parseKongHostPort`, `SERVICE_DISPLAY_NAMES`, `CORE_SERVICE_ORDER`, `GATEWAY_PROBES` from Task 1; `runCommand(argv, opts)` from `src/lib/command.js` (returns stdout string when `silent: true`, or `''`/`null` on failure with `ignoreError: true`).
- Produces:
  ```js
  export async function checkDockerContainers(projectName, deps = {})
  // deps: { runCommand?: typeof runCommand, fetch?: typeof fetch, timeoutMs?: number }
  // -> Promise<Array<{ name, container, health, label, detail, latencyMs }>>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/status/docker-services.test.ts`. Add `checkDockerContainers` and `vi` to the imports at the top:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  checkDockerContainers,
  classifyContainer,
  parseKongHostPort,
} from '../../../src/status.js';
```

Then:

```ts
// Build a runCommand stub keyed on the docker subcommand. `docker ps -a`
// returns the tab-separated listing; `docker port` returns the binding.
function fakeDocker({ ps = '', port = '' }: { ps?: string; port?: string }) {
  return vi.fn((argv: string[]) => {
    if (argv[1] === 'ps') return ps;
    if (argv[1] === 'port') return port;
    throw new Error(`unexpected docker call: ${argv.join(' ')}`);
  });
}

function okFetch(status = 200) {
  return vi.fn(async () => ({ status })) as unknown as typeof fetch;
}

const LETSGO_PS = [
  'letsgo-storage\trunning\tUp 15 minutes (healthy)',
  'letsgo-studio\trunning\tUp 15 minutes (healthy)',
  'letsgo-auth\trunning\tUp 15 minutes (healthy)',
  'letsgo-realtime\trunning\tUp 15 minutes (healthy)',
  'letsgo-meta\trunning\tUp 15 minutes',
  'letsgo-app\trunning\tUp 15 minutes',
  'letsgo-rest\trunning\tUp 15 minutes',
  'letsgo-imgproxy\trunning\tUp 15 minutes (healthy)',
  'letsgo-kong\texited\tExited (128) 24 minutes ago',
  'letsgo-db\trunning\tUp 15 minutes (healthy)',
  'letsgo-traefik\trunning\tUp 15 minutes',
  // A different project sharing the host — must be ignored.
  'vibecarbon-kong\trunning\tUp 20 minutes (healthy)',
  'vibecarbon-auth\trunning\tUp 20 minutes (healthy)',
].join('\n');

describe('checkDockerContainers', () => {
  it('lists every container of the project, including exited ones, in core order', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.map((r) => r.container)).toEqual([
      'traefik',
      'db',
      'kong',
      'auth',
      'rest',
      'realtime',
      'storage',
      'imgproxy',
      'meta',
      'studio',
      'app',
    ]);
    const kong = rows.find((r) => r.container === 'kong');
    expect(kong).toMatchObject({
      name: 'Kong Gateway',
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 24 minutes ago',
    });
    expect(rows.find((r) => r.container === 'auth')).toMatchObject({
      name: 'Auth (GoTrue)',
      health: 'healthy',
    });
  });

  it('ignores containers belonging to other projects', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS }),
      fetch: okFetch(),
    });
    expect(rows.some((r) => r.name.includes('vibecarbon'))).toBe(false);
    expect(rows.filter((r) => r.container === 'kong')).toHaveLength(1);
  });

  it('marks gateway-probed services unknown when kong is not running', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: LETSGO_PS, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unknown',
      label: 'unknown',
      detail: 'gateway down',
    });
    expect(rows.find((r) => r.container === 'meta')).toMatchObject({ health: 'unknown' });
  });

  it('probes rest and meta through the host port kong actually bound', async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
    );
    const fetchSpy = okFetch(401);
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8100\n[::]:8100\n' }),
      fetch: fetchSpy,
    });
    const urls = fetchSpy.mock.calls.map((call) => call[0]).sort();
    expect(urls).toEqual(['http://localhost:8100/pg/', 'http://localhost:8100/rest/v1/']);
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'healthy',
      label: 'healthy',
    });
    expect(rows.find((r) => r.container === 'rest')?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('marks a gateway-probed service unhealthy on an unexpected status code', async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
    );
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: okFetch(503),
    });
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unhealthy',
      label: 'unhealthy',
      detail: 'HTTP 503',
    });
  });

  it('marks a gateway-probed service unhealthy when the probe throws', async () => {
    const ps = LETSGO_PS.replace(
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
    );
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(rows.find((r) => r.container === 'meta')).toMatchObject({
      health: 'unhealthy',
      detail: 'ECONNREFUSED',
    });
  });

  it('does not probe rest/meta when they are not running, even if kong is up', async () => {
    const ps = [
      'letsgo-kong\trunning\tUp 1 minute (healthy)',
      'letsgo-rest\texited\tExited (1) 3 minutes ago',
    ].join('\n');
    const fetchSpy = okFetch();
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '0.0.0.0:8000\n' }),
      fetch: fetchSpy,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows.find((r) => r.container === 'rest')).toMatchObject({
      health: 'unhealthy',
      label: 'exited',
    });
  });

  it('renders add-on containers under their compose service name, after core services', async () => {
    const ps = [
      'letsgo-db\trunning\tUp 1 hour (healthy)',
      'letsgo-redis\trunning\tUp 1 hour (healthy)',
      'letsgo-grafana\trunning\tUp 1 hour (health: starting)',
      'letsgo-metabase-setup\texited\tExited (0) 1 hour ago',
      'letsgo-promtail\trunning\tUp 1 hour',
    ].join('\n');
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps, port: '' }),
      fetch: okFetch(),
    });
    expect(rows.map((r) => [r.container, r.name, r.health, r.label])).toEqual([
      ['db', 'PostgreSQL', 'healthy', 'healthy'],
      ['grafana', 'grafana', 'starting', 'starting'],
      ['metabase-setup', 'metabase-setup', 'done', 'done'],
      ['promtail', 'promtail', 'healthy', 'running'],
      ['redis', 'redis', 'healthy', 'healthy'],
    ]);
  });

  it('returns an empty list when no containers of the project exist', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: fakeDocker({ ps: 'vibecarbon-db\trunning\tUp 1 hour (healthy)\n' }),
      fetch: okFetch(),
    });
    expect(rows).toEqual([]);
  });

  it('returns an empty list when docker is unavailable', async () => {
    const rows = await checkDockerContainers('letsgo', {
      runCommand: vi.fn(() => {
        throw new Error('docker: command not found');
      }),
      fetch: okFetch(),
    });
    expect(rows).toEqual([]);
  });

  it('returns an empty list without a project name', async () => {
    const run = fakeDocker({ ps: LETSGO_PS });
    const rows = await checkDockerContainers(undefined, { runCommand: run, fetch: okFetch() });
    expect(rows).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
```

Note on the last test: the current code falls back to stripping `^[^-]+-` from every container on the host when `projectName` is missing, which is exactly the cross-project confusion this fix removes. Without a project name there is no stack to report on.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/docker-services.test.ts`
Expected: FAIL — `checkDockerContainers` is not exported / does not accept `deps`.

- [ ] **Step 3: Replace `checkDockerContainers`**

Replace the entire existing `async function checkDockerContainers(projectName) { ... }` (from its opening line through the closing `}` after `return results.map(...)`) with:

```js
/**
 * Health of this project's local Docker stack, from Docker's point of view.
 *
 * Enumerates `docker ps -a` for containers prefixed `${projectName}-` so the
 * table shows the whole stack — core services, `vibecarbon add` add-ons, and
 * containers that have exited (which the old running-only listing hid, e.g.
 * a kong that lost its port bind). Health comes from the compose healthcheck
 * verdict in Docker's status string; the two core services without one
 * (rest, meta) are probed through Kong on the host port THIS project's kong
 * container bound, never a fixed :8000 that another project's gateway may
 * own.
 *
 * @param {string|undefined} projectName
 * @param {{runCommand?: typeof runCommand, fetch?: typeof fetch, timeoutMs?: number}} [deps]
 * @returns {Promise<Array<{name: string, container: string, health: string, label: string, detail: string, latencyMs: number}>>}
 */
async function checkDockerContainers(projectName, deps = {}) {
  const { runCommand: _run = runCommand, fetch: _fetch = fetch, timeoutMs = 2000 } = deps;
  if (!projectName) return [];
  const prefix = `${projectName}-`;

  let listing = '';
  try {
    listing =
      _run(['docker', 'ps', '-a', '--filter', `name=^${prefix}`, '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'], {
        silent: true,
        encoding: 'utf-8',
        timeout: 5000,
        ignoreError: true,
      }) || '';
  } catch {
    return [];
  }

  // Docker's name filter is a substring regex; keep the JS prefix check so a
  // sibling project like `${projectName}-v2` can't leak in via a loose match.
  const containers = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const [fullName, state = '', status = ''] = line.split('\t');
      return { container: fullName.slice(prefix.length), state, status };
    });

  if (containers.length === 0) return [];

  const kongRunning = containers.some((ct) => ct.container === 'kong' && ct.state === 'running');
  let kongPort = null;
  if (kongRunning) {
    try {
      kongPort = parseKongHostPort(
        _run(['docker', 'port', `${prefix}kong`, '8000/tcp'], {
          silent: true,
          encoding: 'utf-8',
          timeout: 5000,
          ignoreError: true,
        }),
      );
    } catch {
      kongPort = null;
    }
  }

  const rows = await Promise.all(
    containers.map(async ({ container, state, status }) => {
      const name = SERVICE_DISPLAY_NAMES[container] || container;
      const base = classifyContainer(container, state, status);
      const probe = GATEWAY_PROBES[container];
      if (!probe || state !== 'running') {
        return { name, container, ...base, latencyMs: 0 };
      }
      if (kongPort === null) {
        return { name, container, health: 'unknown', label: 'unknown', detail: 'gateway down', latencyMs: 0 };
      }
      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await _fetch(`http://localhost:${kongPort}${probe.path}`, {
          method: 'GET',
          signal: controller.signal,
        });
        const latencyMs = Date.now() - start;
        if (probe.acceptCodes.includes(response.status)) {
          return { name, container, health: 'healthy', label: 'healthy', detail: '', latencyMs };
        }
        return { name, container, health: 'unhealthy', label: 'unhealthy', detail: `HTTP ${response.status}`, latencyMs };
      } catch (err) {
        return {
          name,
          container,
          health: 'unhealthy',
          label: 'unhealthy',
          detail: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - start,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }),
  );

  const rank = (ct) => {
    const i = CORE_SERVICE_ORDER.indexOf(ct);
    return i === -1 ? CORE_SERVICE_ORDER.length : i;
  };
  return rows.sort(
    (a, b) => rank(a.container) - rank(b.container) || a.container.localeCompare(b.container),
  );
}
```

Add `checkDockerContainers` to the export list at the bottom of the file (alphabetical position, after `CORE_SERVICE_ORDER`).

Run `pnpm lint` and let biome's formatter reflow the long `_run([...])` and object-literal lines (`pnpm lint:fix` or `pnpm biome format --write src/status.js`; check `package.json` scripts for the exact name).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit tests/unit/status/docker-services.test.ts`
Expected: PASS (all tests from Task 1 and Task 2).

Run: `pnpm test:unit`
Expected: PASS — in particular `tests/unit/status/*.test.ts` still green.

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/status/docker-services.test.ts src/status.js
git diff --cached --stat
git commit -m "fix(status): enumerate the project's own containers via docker ps -a instead of probing :8000" -- tests/unit/status/docker-services.test.ts src/status.js
```

---

### Task 3: Render every state in the Local Development table

**Files:**
- Modify: `src/status.js` — `renderLocalDev(data)` Docker section (originally lines 647-669)
- Modify: `src/status.js` export list (add `formatDockerServiceLines`)
- Test: `tests/unit/status/docker-services.test.ts` (append)

**Interfaces:**
- Consumes: row shape from Task 2 (`name, container, health, label, detail, latencyMs`).
- Produces:
  ```js
  export function formatDockerServiceLines(docker) // -> string[] (ANSI-coloured lines)
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/status/docker-services.test.ts` (add `formatDockerServiceLines` to the import):

```ts
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatDockerServiceLines', () => {
  it('renders "not running" when there are no rows', () => {
    const lines = formatDockerServiceLines([]).map(stripAnsi);
    expect(lines).toEqual(['Docker Services               not running']);
  });

  it('counts healthy over non-done rows and shows exited rows with their Docker status', () => {
    const lines = formatDockerServiceLines([
      { name: 'PostgreSQL', container: 'db', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
      { name: 'Kong Gateway', container: 'kong', health: 'unhealthy', label: 'exited', detail: 'Exited (128) 24 minutes ago', latencyMs: 0 },
      { name: 'REST (PostgREST)', container: 'rest', health: 'unknown', label: 'unknown', detail: 'gateway down', latencyMs: 0 },
      { name: 'Traefik', container: 'traefik', health: 'healthy', label: 'running', detail: '', latencyMs: 0 },
      { name: 'metabase-setup', container: 'metabase-setup', health: 'done', label: 'done', detail: '', latencyMs: 0 },
    ]).map(stripAnsi);

    expect(lines[0]).toBe('Docker Services               ● 2/4 healthy');
    expect(lines[1]).toBe('  PostgreSQL                  ● healthy  ');
    expect(lines[2]).toBe('  Kong Gateway                ● exited  Exited (128) 24 minutes ago');
    expect(lines[3]).toBe('  REST (PostgREST)            ○ unknown  gateway down');
    expect(lines[4]).toBe('  Traefik                     ● running  ');
    expect(lines[5]).toBe('  metabase-setup              ○ done  ');
  });

  it('shows latency for probed rows', () => {
    const lines = formatDockerServiceLines([
      { name: 'Meta', container: 'meta', health: 'healthy', label: 'healthy', detail: '', latencyMs: 17 },
    ]).map(stripAnsi);
    expect(lines[1]).toBe('  Meta                        ● healthy  17ms');
  });

  it('colours the summary green only when every counted row is healthy', () => {
    const allGood = formatDockerServiceLines([
      { name: 'PostgreSQL', container: 'db', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
      { name: 'x-setup', container: 'x-setup', health: 'done', label: 'done', detail: '', latencyMs: 0 },
    ]);
    expect(allGood[0]).toContain('\x1b[32m'); // green
    const oneBad = formatDockerServiceLines([
      { name: 'PostgreSQL', container: 'db', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
      { name: 'Kong Gateway', container: 'kong', health: 'unhealthy', label: 'exited', detail: 'Exited (1) 1s ago', latencyMs: 0 },
    ]);
    expect(oneBad[0]).toContain('\x1b[33m'); // yellow
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/docker-services.test.ts`
Expected: FAIL — `formatDockerServiceLines` is not exported.

- [ ] **Step 3: Extract the formatter and wire it into `renderLocalDev`**

Above `function renderLocalDev(data) {` insert:

```js
/**
 * Lines for the "Docker Services" section of the Local Development note.
 *
 * `done` rows (one-shot init containers that exited 0) are listed but
 * excluded from the healthy total; `starting` and `unknown` rows count
 * against it without being painted red, since neither is a failure yet.
 *
 * @param {Array<{name: string, health: string, label: string, detail: string, latencyMs: number}>} docker
 * @returns {string[]}
 */
function formatDockerServiceLines(docker) {
  if (docker.length === 0) {
    return [`${c.dim('Docker Services'.padEnd(30))}${c.dim('not running')}`];
  }
  const counted = docker.filter((s) => s.health !== 'done');
  const healthyCount = counted.filter((s) => s.health === 'healthy').length;
  const total = counted.length;
  const summary = `● ${healthyCount}/${total} healthy`;
  const lines = [
    `${c.dim('Docker Services'.padEnd(30))}${healthyCount === total ? c.success(summary) : c.warning(summary)}`,
  ];

  for (const svc of docker) {
    let icon;
    let label;
    switch (svc.health) {
      case 'healthy':
        icon = c.success('●');
        label = c.dim(svc.label);
        break;
      case 'unhealthy':
        icon = c.error('●');
        label = c.error(svc.label);
        break;
      case 'starting':
        icon = c.warning('●');
        label = c.warning(svc.label);
        break;
      default: // done, unknown
        icon = c.dim('○');
        label = c.dim(svc.label);
    }
    const tail = svc.detail ? c.dim(svc.detail) : svc.latencyMs ? c.dim(`${svc.latencyMs}ms`) : '';
    lines.push(`  ${c.dim(svc.name.padEnd(28))}${icon} ${label}  ${tail}`);
  }
  return lines;
}
```

In `renderLocalDev`, replace everything from `// Docker services` through the closing `}` of the `else` branch (the block ending `lines.push(\`${c.dim('Docker Services'.padEnd(30))}${c.dim('not running')}\`);\n  }`) with:

```js
  // Docker services
  lines.push(...formatDockerServiceLines(data.docker));
```

Add `formatDockerServiceLines` to the export list.

Then update the summary block in `renderSummary` (originally lines 921-937) so `done` rows don't drag the "All services running" verdict. Replace:

```js
    const dockerHealthy = ld.docker.filter((s) => s.health === 'healthy').length;
    if (ld.docker.length > 0) parts.push(`Docker ${dockerHealthy}/${ld.docker.length}`);
```

with:

```js
    const dockerCounted = ld.docker.filter((s) => s.health !== 'done');
    const dockerHealthy = dockerCounted.filter((s) => s.health === 'healthy').length;
    if (dockerCounted.length > 0) parts.push(`Docker ${dockerHealthy}/${dockerCounted.length}`);
```

and in the `if (... dockerHealthy === ld.docker.length && ld.docker.length > 0)` condition just below, replace both `ld.docker.length` with `dockerCounted.length`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit tests/unit/status/docker-services.test.ts`
Expected: PASS.

Run: `pnpm test:unit && pnpm lint`
Expected: both clean.

Manual check against the live letsgo stack (kong is still exited there as of this plan):

```bash
cd ~/repos/letsgo && node ~/repos/vibecarbon/src/cli.js status
```

Expected: `Docker Services ● 8/11 healthy` (kong exited, rest + meta unknown "gateway down"), `Kong Gateway ● exited  Exited (128) ...`, `Auth (GoTrue) ● healthy`, and `Traefik`, `App`, `ImgProxy` rows present. Summary line `Local Dev  Docker 8/11`. Then `node ~/repos/vibecarbon/src/cli.js status -json | jq '.localDev.docker'` (adjust the key path to whatever `-json` emits; check `showGlobalStatus`/`main` for the exact shape) shows the new `label`/`detail` fields.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/status/docker-services.test.ts src/status.js
git diff --cached --stat
git commit -m "fix(status): render exited, starting, and add-on containers in the local dev table" -- tests/unit/status/docker-services.test.ts src/status.js
```

---

### Task 4: Pre-push gate and PR

**Files:** none. `CHANGELOG.md` is frozen at v0.41.0 (see its header); release notes are generated from conventional commit subjects on GitHub Releases, so there is no changelog edit in this plan.

- [ ] **Step 1: (removed — no changelog)**

- [ ] **Step 2: Verify the full gate**

Run: `pnpm test:prepush`
Expected: lint + unit + integration all green. If the pre-commit hook trips the retired-licence-trace guard on the gitignored `tests/.env.e2e`, that is the known local false positive (see memory: hooks-need-test-license-key); `--no-verify` is acceptable once `pnpm lint` has passed.

- [ ] **Step 3: Commit and open the PR**

```bash
git checkout -b fix/status-docker-native-health   # if not already on a branch
git push -u origin fix/status-docker-native-health
gh pr create --title "fix(status): read local Docker health from Docker, not a fixed :8000 probe" --body "$(cat <<'EOF'
## Summary
- `vibecarbon status` enumerated only running containers and HTTP-probed `localhost:8000` for every row. When another project's Kong owned the port, every row reported on the wrong stack and the one exited container (this project's kong) was omitted.
- Now: `docker ps -a` filtered to `${projectName}-`, health from Docker's compose-healthcheck verdict, `rest`/`meta` probed via the port this project's kong actually bound (`docker port`). Exited/restarting/starting containers are listed; `vibecarbon add` services appear automatically.
- Row states: `healthy` / `running` / `starting` / `unhealthy` / `exited` / `done` / `unknown`. (`-json` is unaffected: it has never included the local-dev block.)

## Test plan
- [ ] `pnpm test:unit` — new `tests/unit/status/docker-services.test.ts`
- [ ] `pnpm test:prepush`
- [ ] Manual: project with a kong exited on port conflict shows `Kong Gateway ● exited`, auth healthy, rest/meta `unknown (gateway down)`
EOF
)"
```

---

### Task 5: Update notice moves under the banner, on every command

**Files:**
- Modify: `src/lib/telemetry/update-check.js` (add `printUpdateNotice`, change notice colour)
- Modify: `src/lib/cli/intro.js` (`introCommand` prints the notice between banner and intro line)
- Modify: `src/access.js:325` and `src/lib/deploy/prompts.js:386` (the two manual `printBanner()` call sites)
- Modify: `src/cli.js:427-432` (`finally` block becomes the fallback for banner-less commands)
- Test: `tests/unit/telemetry/update-check.test.ts` (extend), `tests/unit/lib/cli/intro.test.ts` (create)

**Interfaces:**
- Consumes: `getUpdateNotice(opts)` (existing), `printBanner()` from `src/lib/colors.js`, `c.warning` from `src/lib/colors.js`.
- Produces:
  ```js
  // src/lib/telemetry/update-check.js
  export function printUpdateNotice(opts = {})
  // opts: { currentVersion?, stateDir?, isTTY? = process.stdout.isTTY, leadingBlank? = false, log? = console.log }
  // Prints "<notice>\n" (plus a leading blank line when leadingBlank) at most ONCE per process; returns true if printed.
  export function resetUpdateNoticeForTests()
  ```

**Design (from Brandon, 2026-09-18):** the "Update available X → Y · npm i -g vibecarbon" line currently prints dim, at the very end of every command (`src/cli.js:428-429`). It should print in a distinct colour, directly below the vibecarbon logo box and above the `vibecarbon <command> vX` intro line, on every command, with one blank line before and one after. Commands with no banner (console, diagnose, shell, telemetry) keep the trailing notice so they never lose it. Colour: `c.warning` (yellow), the conventional update-notice colour and distinct from the dim metadata around it. The once-per-process guard is what lets the banner path and the `finally` fallback coexist without double printing.

Expected layout (banner already ends with a blank line):

```
████████████████████████████████████████████████
██      v  i  b  e  c  a  r  b  o  n          ██
████████████████████████████████████████████████

Update available 0.44.0 → 0.44.1 · npm i -g vibecarbon

┌  vibecarbon status v0.44.0
│
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/telemetry/update-check.test.ts` (extend the import to `import { getUpdateNotice, printUpdateNotice, refreshUpdateCache, resetUpdateNoticeForTests } from '../../../src/lib/telemetry/update-check.js';`):

```ts
describe('getUpdateNotice colour', () => {
  it('renders the notice in yellow, not dim', () => {
    writeCache('0.99.0', 0);
    const notice = getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir }) as string;
    expect(notice.startsWith('\x1b[33m')).toBe(true);
    expect(notice).not.toContain('\x1b[2m');
  });
});

describe('printUpdateNotice', () => {
  beforeEach(() => resetUpdateNoticeForTests());

  it('prints the notice followed by a blank line and returns true', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    const printed = printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log });
    expect(printed).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('Update available 0.41.0 → 0.99.0');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('adds a leading blank line when asked (fallback path for banner-less commands)', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, leadingBlank: true, log });
    const line = log.mock.calls[0][0] as string;
    expect(line.startsWith('\n')).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('prints at most once per process', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(true);
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('prints nothing when stdout is not a TTY', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: false, log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('prints nothing when there is no newer version', () => {
    writeCache('0.41.0', 0);
    const log = vi.fn();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('does not consume the once-guard when nothing was printed', () => {
    const log = vi.fn();
    printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: false, log });
    writeCache('0.99.0', 0);
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(true);
  });
});
```

Create `tests/unit/lib/cli/intro.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.mock('@clack/prompts', () => ({
  intro: (m: string) => calls.push(`intro:${m}`),
}));
vi.mock('../../../../src/lib/colors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/colors.js')>();
  return { ...actual, printBanner: () => calls.push('banner') };
});
vi.mock('../../../../src/lib/telemetry/update-check.js', () => ({
  printUpdateNotice: vi.fn(() => {
    calls.push('notice');
    return true;
  }),
}));

import { introCommand } from '../../../../src/lib/cli/intro.js';
import { printUpdateNotice } from '../../../../src/lib/telemetry/update-check.js';

describe('introCommand', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.mocked(printUpdateNotice).mockClear();
  });

  it('prints banner, then the update notice, then the intro line', () => {
    introCommand('status');
    expect(calls).toEqual(['banner', 'notice', expect.stringMatching(/^intro:.*vibecarbon status/)]);
  });

  it('asks for no leading blank line — the banner already ends with one', () => {
    introCommand('status');
    expect(printUpdateNotice).toHaveBeenCalledWith();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/telemetry/update-check.test.ts tests/unit/lib/cli/intro.test.ts`
Expected: FAIL — `printUpdateNotice` / `resetUpdateNoticeForTests` not exported; colour test fails (notice starts with `\x1b[2m`); intro ordering test fails (no `notice` entry).

- [ ] **Step 3: Implement**

In `src/lib/telemetry/update-check.js`, change `getUpdateNotice` to use `c.warning(...)` instead of `c.dim(...)`:

```js
      return c.warning(
        `Update available ${currentVersion} → ${cache.latestVersion} · npm i -g vibecarbon`,
      );
```

Then add below `getUpdateNotice`:

```js
let noticePrinted = false;

/**
 * Print the update notice once per process, on a TTY only.
 *
 * Every banner-opening command calls this right after the logo box (see
 * introCommand) so an update is the first thing the user reads; cli.js
 * calls it again in its `finally` as the fallback for the few commands
 * that never draw a banner. The once-guard is what keeps those two call
 * sites from double-printing. Always followed by a blank line; the
 * fallback asks for a leading one too because nothing precedes it there.
 *
 * @param {{ currentVersion?: string, stateDir?: string, isTTY?: boolean, leadingBlank?: boolean, log?: (s: string) => void }} [opts]
 * @returns {boolean} true when a notice was printed
 */
export function printUpdateNotice({
  currentVersion = VERSION,
  stateDir = DEFAULT_DIR,
  isTTY = process.stdout.isTTY,
  leadingBlank = false,
  log = console.log,
} = {}) {
  if (noticePrinted || !isTTY) return false;
  const notice = getUpdateNotice({ currentVersion, stateDir });
  if (!notice) return false;
  log(`${leadingBlank ? '\n' : ''}${notice}\n`);
  noticePrinted = true;
  return true;
}

/** Test hook: clear the once-per-process guard. */
export function resetUpdateNoticeForTests() {
  noticePrinted = false;
}
```

In `src/lib/cli/intro.js`:

```js
import * as p from '@clack/prompts';
import { c, printBanner } from '../colors.js';
import { printUpdateNotice } from '../telemetry/update-check.js';
import { VERSION } from '../version.js';

/**
 * @param {string} command - label after "vibecarbon " (e.g. 'backup',
 *   'configure cicd')
 */
export function introCommand(command) {
  printBanner();
  printUpdateNotice();
  p.intro(`${c.bold(`vibecarbon ${command}`)} ${c.dim(`v${VERSION}`)}`);
}
```

Update the file's header comment to mention the notice: "brand banner + update notice (when one is cached) + clack intro line".

In `src/access.js`, after the `printBanner();` at line ~325 add `printUpdateNotice();` and add `import { printUpdateNotice } from './lib/telemetry/update-check.js';` to the imports (keep import order biome-clean; run the formatter).

In `src/lib/deploy/prompts.js`, after `printBanner();` at line ~386 add `printUpdateNotice();` and add `import { printUpdateNotice } from '../telemetry/update-check.js';`.

In `src/cli.js`, replace

```js
  } finally {
    const notice = getUpdateNotice();
    if (notice && process.stdout.isTTY) console.log(`\n${notice}`);
    await settlePendingTelemetry();
```

with

```js
  } finally {
    // Fallback for commands that never draw a banner (console, diagnose,
    // shell, telemetry). Banner commands already printed it under the logo;
    // the once-guard makes this a no-op for them.
    printUpdateNotice({ leadingBlank: true });
    await settlePendingTelemetry();
```

and change the import on line 24 to `import { printUpdateNotice, refreshUpdateCache } from './lib/telemetry/update-check.js';` (drop `getUpdateNotice` if nothing else in cli.js uses it — grep first).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit tests/unit/telemetry/update-check.test.ts tests/unit/lib/cli/intro.test.ts`
Expected: PASS.

Run: `pnpm test:unit && pnpm lint`
Expected: clean. Also `pnpm test:cli` (integration flag matrix spawns the CLI; confirms nothing prints twice or on `-json`).

Manual: seed a newer version and run any command on a TTY:

```bash
printf '{"checkedAt":"%s","latestVersion":"99.0.0"}\n' "$(date -u +%FT%TZ)" > ~/.vibecarbon/update-check.json
cd ~/repos/letsgo && node ~/repos/vibecarbon/src/cli.js status | cat -A | head -12   # non-TTY: no notice
cd ~/repos/letsgo && node ~/repos/vibecarbon/src/cli.js status                     # TTY: yellow notice under logo, blank line each side, nothing at the end
node ~/repos/vibecarbon/src/cli.js diagnose                                        # banner-less: notice at the end, blank line each side
rm ~/.vibecarbon/update-check.json   # let the next run rebuild the real cache
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/telemetry/update-check.js src/lib/cli/intro.js src/access.js src/lib/deploy/prompts.js src/cli.js tests/unit/telemetry/update-check.test.ts tests/unit/lib/cli/intro.test.ts
git diff --cached --stat
git commit -m "feat(cli): show the update notice under the banner on every command" -- src/lib/telemetry/update-check.js src/lib/cli/intro.js src/access.js src/lib/deploy/prompts.js src/cli.js tests/unit/telemetry/update-check.test.ts tests/unit/lib/cli/intro.test.ts
```

---

### Task 6: Colour the EXAMPLES section of help output

**Files:**
- Modify: `src/lib/colors.js` (add a `gray` code and `c.muted`)
- Modify: `src/lib/cli/help.js` (add + export `formatExampleCommand`, use it and `c.muted` in the EXAMPLES loop)
- Modify: `src/cli.js:182-201` (`showHelp()` EXAMPLES block uses the same helpers)
- Test: `tests/unit/lib/cli/help.test.ts` (extend)

**Interfaces:**
- Consumes: `c.info` (cyan, used for command names in the command lists above EXAMPLES), `c.bold`, `c.dim` from `src/lib/colors.js`.
- Produces:
  ```js
  // src/lib/colors.js
  colors.gray = '\x1b[90m'
  c.muted = (s) => `${colors.gray}${s}${colors.reset}`
  // src/lib/cli/help.js
  export function formatExampleCommand(command) // -> string with `vibecarbon <cmd>` in c.info, remainder untouched
  ```

**Design (from Brandon, 2026-09-18):** in both the global help (`vibecarbon -h`) and per-command help (`vibecarbon <cmd> -h`), the EXAMPLES section prints every line in plain white. The `vibecarbon` word and the command name should be the same teal (`c.info`) as the command lists above; `# comment` lines should be a light gray that is visibly distinct from white (`c.dim` is not distinct enough on Brandon's terminal, so use the bright-black ANSI code 90); arguments and flags after the command name stay white. Lines that are not a vibecarbon invocation (`cd my-app`) stay white.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/lib/cli/help.test.ts` (extend the import to `import { formatExampleCommand, renderHelp } from '../../../../src/lib/cli/help.js';`):

```ts
describe('formatExampleCommand', () => {
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[0m';

  it('colours `vibecarbon <command>` cyan and leaves the rest plain', () => {
    expect(formatExampleCommand('vibecarbon backup prod -l')).toBe(
      `${CYAN}vibecarbon${RESET} ${CYAN}backup${RESET} prod -l`,
    );
  });

  it('colours a bare `vibecarbon <command>`', () => {
    expect(formatExampleCommand('vibecarbon up')).toBe(`${CYAN}vibecarbon${RESET} ${CYAN}up${RESET}`);
  });

  it('leaves a non-vibecarbon line untouched', () => {
    expect(formatExampleCommand('cd my-app')).toBe('cd my-app');
  });

  it('leaves a bare `vibecarbon` with no command untouched except the word itself', () => {
    expect(formatExampleCommand('vibecarbon')).toBe(`${CYAN}vibecarbon${RESET}`);
  });
});

describe('renderHelp EXAMPLES colouring', () => {
  it('renders example commands via formatExampleCommand and comments in gray', () => {
    const out = renderHelp({
      name: 'backup',
      summary: 'x',
      examples: [{ command: 'vibecarbon backup prod -l', description: 'list prod backups' }],
    });
    expect(out).toContain(formatExampleCommand('vibecarbon backup prod -l'));
    expect(out).toContain('\x1b[90m# list prod backups\x1b[0m');
    expect(out).not.toContain('\x1b[2m# list prod backups');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/lib/cli/help.test.ts`
Expected: FAIL — `formatExampleCommand` is not exported; comment line still uses dim (`\x1b[2m`).

- [ ] **Step 3: Implement**

`src/lib/colors.js`: add `gray: '\x1b[90m',` to the `colors` object (after `cyan`), and to `c`:

```js
  // Bright-black gray for prose that should recede without vanishing —
  // help-example comments. `dim` alone is indistinguishable from white on
  // some terminal themes.
  muted: (s) => `${colors.gray}${s}${colors.reset}`,
```

`src/lib/cli/help.js`: add below the typedefs, above `renderHelp`:

```js
/**
 * Colour a help example so `vibecarbon <command>` matches the cyan command
 * names in the lists above it, while args and flags stay plain. Lines that
 * aren't a vibecarbon invocation (`cd my-app`) come back untouched.
 *
 * @param {string} command
 * @returns {string}
 */
export function formatExampleCommand(command) {
  const match = command.match(/^vibecarbon(?:\s+(\S+))?(.*)$/);
  if (!match) return command;
  const [, name, rest] = match;
  return name ? `${c.info('vibecarbon')} ${c.info(name)}${rest}` : `${c.info('vibecarbon')}${rest}`;
}
```

In the EXAMPLES loop of `renderHelp`, change `c.dim(\`# ${ex.description}\`)` to `c.muted(\`# ${ex.description}\`)` and `lines.push(\`  ${ex.command}\`)` to `lines.push(\`  ${formatExampleCommand(ex.command)}\`)`. Update the header comment's "dim descriptions" sentence to mention "gray example comments".

`src/cli.js`: import `formatExampleCommand` from `./lib/cli/help.js` (check whether `help.js` is already imported there and extend that import if so). In `showHelp()`, rewrite the EXAMPLES block so every `# ...` line uses `c.muted(...)` instead of `c.dim(...)` and every `vibecarbon ...` line goes through `formatExampleCommand(...)`:

```js
${c.bold('EXAMPLES')}
  ${c.muted('# Create a new project')}
  ${formatExampleCommand('vibecarbon create my-app')}
  cd my-app

  ${c.muted('# Local development')}
  ${formatExampleCommand('vibecarbon up')}

  ${c.muted('# Add features')}
  ${formatExampleCommand('vibecarbon add observability')}

  ${c.muted('# Wire up external services')}
  ${formatExampleCommand('vibecarbon configure')}

  ${c.muted('# Deploy to production')}
  ${formatExampleCommand('vibecarbon deploy prod')}

  ${c.muted('# Backup and restore')}
  ${formatExampleCommand('vibecarbon backup prod -l')}
  ${formatExampleCommand('vibecarbon restore prod')}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit tests/unit/lib/cli/help.test.ts`
Expected: PASS.

Run: `pnpm test:unit && pnpm lint`
Expected: clean. Then `pnpm test:cli` (integration help/flag matrix spawns the real CLI; strip-ANSI assertions there must still hold).

Manual: `node src/cli.js -h` and `node src/cli.js backup -h` on a TTY — `vibecarbon` + command teal, comments gray, args/flags white, `cd my-app` white.

- [ ] **Step 5: Commit**

```bash
git add src/lib/colors.js src/lib/cli/help.js src/cli.js tests/unit/lib/cli/help.test.ts
git diff --cached --stat
git commit -m "feat(cli): colour vibecarbon commands and gray comments in help EXAMPLES" -- src/lib/colors.js src/lib/cli/help.js src/cli.js tests/unit/lib/cli/help.test.ts
```

---

## Self-review

- Spec coverage: defect 1 (fixed port) → Task 2 `docker port` + `kongPort`; defect 2 (`-a`) → Task 2; defect 3 (Docker health) → Task 1 `classifyContainer`; defect 4 (env-port parsing) → deleted in Task 2, port now comes from Docker; defect 5 (hardcoded list / add-ons) → Task 2 enumeration + Task 3 rendering. Add-on `*-setup` one-shots → Task 1/3 `done`. Kong-down fallback → Task 2 `unknown`.
- Task 5 (added 2026-09-18 after Tasks 1-2 started): notice placement → intro.js + two manual banner sites; banner-less commands → cli.js finally fallback; once-guard prevents double print; TTY gate preserved so -json is unaffected.
- Task 6 (added 2026-09-18): both help surfaces (global showHelp, per-command renderHelp) share `formatExampleCommand`; `c.muted` (ANSI 90) is new because `c.dim` is not visually distinct on Brandon's terminal.
- Placeholder scan: none.
- Type consistency: row shape `{name, container, health, label, detail, latencyMs}` is identical across Tasks 1-3; `deps` keys `runCommand`, `fetch`, `timeoutMs` match between Task 2 implementation and tests.
