# Remote container health in `status` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vibecarbon status` shows the real health of every container (compose) or pod (k8s) on every server of every deployed environment, as an exceptions-only rollup under each server, with `-json` carrying every row, and an e2e `verify-status` step proving it on all four modes without touching perf stats.

**Architecture:** The local Docker-row machinery from PR #110 (`classifyContainer`, the `docker ps` line parser, the row formatter) moves into `src/lib/status/container-rows.js` so local and remote share it. A new `src/lib/status/remote-containers.js` plans which servers to query per deploy mode, collects `docker ps -a` (compose) or `kubectl get pods/nodes` (k8s) over SSH with per-server bounds, and maps everything onto the same row shape. `src/status.js` wires the collection into the per-environment checks, switches the liveness probe to `/api/health/ready`, renders the rollup under each server line via a pure `formatServerLines`, and counts container failures in the summary. The e2e lifecycle gains `verify-status` (polling `status -json`), excluded from the reporter's totals via `NON_PERF_STEPS`.

**Tech Stack:** Node ESM, vitest (unit + integration projects), `sshRun`/`sshKubectl` from `src/lib/ssh.js`, the e2e harness in `tests/e2e/`.

**Spec:** `docs/superpowers/specs/2026-09-18-remote-container-health-design.md` — the binding authority for every task below.

## Global Constraints

- Branch `feat/status-remote-container-health` (based on `fix/status-docker-native-health`, PR #110). If #110 has merged by the time a task runs, `git rebase main` first; the plan's line numbers refer to the post-#110 tree.
- No `!:` / `BREAKING CHANGE` footers. Conventional prefixes per task. Commit with pathspecs after `git diff --cached --stat` (shared checkout). The pre-commit hook runs lint + unit and must pass on its own: never `--no-verify`.
- `pnpm lint` and `pnpm test:unit` green after every task; `pnpm test:integration` green after Task 4; `pnpm test:cli` after Task 4.
- Row shape everywhere: `{ name, container, health: 'healthy'|'unhealthy'|'starting'|'done'|'unknown', label, detail, latencyMs }`. Remote rows always have `latencyMs: 0`.
- `ServerContainers` shape: `{ kind: 'compose'|'k8s', ip, rows, platform?, nodes?, error? }` exactly as the spec §1.
- No emoji in CLI output; icons stay `●` (`●`) / `○` (`○`); 28-col name padding for rows.
- Remote collection is best-effort: it must never reject the environment's checks entry, never run when `envConfig.servers` is empty, and must skip the network entirely when there is no SSH key.
- `verify-status` must NOT be added to `PERF_TABLE_ROWS`, and must be excluded from every sum over `steps[].duration_ms` in `tests/e2e/metrics/reporter.ts`.

---

## File Structure

- Create `src/lib/status/container-rows.js` — `classifyContainer`, `rowsFromDockerPs(listing, projectName)`, `formatContainerRow(row, indent)`. Moved out of `src/status.js`; `src/status.js` re-exports `classifyContainer` so existing tests keep importing it from there.
- Create `src/lib/status/remote-containers.js` — `planContainerTargets`, `classifyPod`, `rowsFromPods`, `nodeReadiness`, `checkRemoteContainers`.
- Modify `src/status.js` — `checkDockerContainers` uses `rowsFromDockerPs`; `formatDockerServiceLines` uses `formatContainerRow`; `checkRemoteHealth` → `/ready`; `main` wires `checks.containers`; new pure `formatServerLines(servers, checks)` used by `renderEnvironment`; new pure `isEnvironmentUnhealthy(entry)` used by `renderSummary`; export list.
- Tests: `tests/unit/status/container-rows.test.ts` (new), `tests/unit/status/remote-containers.test.ts` (new), `tests/unit/status/render-environment.test.ts` (new), `tests/unit/status/docker-services.test.ts` (parity checks), `tests/integration/cli/status/…` (one new case; check the existing status integration file name under `tests/integration/cli/` first).
- e2e: `tests/e2e/scenarios/types.ts` (StepName), `tests/e2e/checks/status-health.ts` (new), `tests/e2e/scenarios/_run-lifecycle.ts` (timeout + two step defs), `tests/e2e/metrics/reporter.ts` (`NON_PERF_STEPS`), `tests/unit/e2e/status-health-check.test.ts` (new), `tests/unit/e2e/reporter-non-perf-steps.test.ts` (new).

---

### Task 1: Extract shared container-row helpers

**Files:**
- Create: `src/lib/status/container-rows.js`
- Modify: `src/status.js` (remove `classifyContainer` body, the parser inside `checkDockerContainers`, and the row loop inside `formatDockerServiceLines`; import from the new module; keep `classifyContainer` in the export list via re-export)
- Test: `tests/unit/status/container-rows.test.ts` (create); `tests/unit/status/docker-services.test.ts` (unchanged, must still pass)

**Interfaces:**
- Produces:
  ```js
  export function classifyContainer(container, state, status)   // unchanged behaviour, moved
  export function rowsFromDockerPs(listing, projectName)          // -> Array<{ container, state, status }>  (prefix-filtered, tab-split)
  export function formatContainerRow(row, indent = '  ')          // -> string  (icon + label + detail/latency, 28-col name)
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/status/container-rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  classifyContainer,
  formatContainerRow,
  rowsFromDockerPs,
} from '../../../src/lib/status/container-rows.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('rowsFromDockerPs', () => {
  it('keeps only this project’s containers and splits the three tab fields', () => {
    const listing = [
      'letsgo-db\trunning\tUp 1 hour (healthy)',
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'vibecarbon-kong\trunning\tUp 2 hours (healthy)',
      '',
    ].join('\n');
    expect(rowsFromDockerPs(listing, 'letsgo')).toEqual([
      { container: 'db', state: 'running', status: 'Up 1 hour (healthy)' },
      { container: 'kong', state: 'exited', status: 'Exited (128) 24 minutes ago' },
    ]);
  });

  it('tolerates a malformed line by leaving state and status empty', () => {
    expect(rowsFromDockerPs('letsgo-weird\n', 'letsgo')).toEqual([
      { container: 'weird', state: '', status: '' },
    ]);
  });

  it('returns [] for empty, null, or foreign-only listings', () => {
    expect(rowsFromDockerPs('', 'letsgo')).toEqual([]);
    expect(rowsFromDockerPs(null, 'letsgo')).toEqual([]);
    expect(rowsFromDockerPs('other-db\trunning\tUp', 'letsgo')).toEqual([]);
  });
});

describe('formatContainerRow', () => {
  const row = (over: Record<string, unknown>) => ({
    name: 'Kong Gateway',
    container: 'kong',
    health: 'healthy',
    label: 'healthy',
    detail: '',
    latencyMs: 0,
    ...over,
  });

  it('renders healthy with a dim label and no tail', () => {
    expect(stripAnsi(formatContainerRow(row({})))).toBe('  Kong Gateway                ● healthy  ');
  });

  it('renders unhealthy with the detail as tail', () => {
    expect(
      stripAnsi(formatContainerRow(row({ health: 'unhealthy', label: 'exited', detail: 'Exited (128) 3 hours ago' }))),
    ).toBe('  Kong Gateway                ● exited  Exited (128) 3 hours ago');
  });

  it('renders latency when there is no detail', () => {
    expect(stripAnsi(formatContainerRow(row({ latencyMs: 17 })))).toBe('  Kong Gateway                ● healthy  17ms');
  });

  it('uses the hollow icon for done and unknown', () => {
    expect(stripAnsi(formatContainerRow(row({ health: 'done', label: 'done' })))).toBe('  Kong Gateway                ○ done  ');
    expect(stripAnsi(formatContainerRow(row({ health: 'unknown', label: 'unknown', detail: 'gateway down' })))).toBe(
      '  Kong Gateway                ○ unknown  gateway down',
    );
  });

  it('honours a custom indent', () => {
    expect(stripAnsi(formatContainerRow(row({}), '      '))).toBe('      Kong Gateway                ● healthy  ');
  });

  it('colours by health: green healthy, red unhealthy, yellow starting', () => {
    expect(formatContainerRow(row({}))).toContain('\x1b[32m●');
    expect(formatContainerRow(row({ health: 'unhealthy', label: 'unhealthy' }))).toContain('\x1b[31m●');
    expect(formatContainerRow(row({ health: 'starting', label: 'starting' }))).toContain('\x1b[33m●');
  });
});

describe('classifyContainer (moved)', () => {
  it('still classifies a healthy running container', () => {
    expect(classifyContainer('auth', 'running', 'Up 1m (healthy)')).toEqual({ health: 'healthy', label: 'healthy', detail: '' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/container-rows.test.ts`
Expected: FAIL — module `src/lib/status/container-rows.js` does not exist.

- [ ] **Step 3: Create the module and refactor `status.js` to use it**

Create `src/lib/status/container-rows.js`:

```js
/**
 * Container rows shared by the local Docker block and the remote per-server
 * tables in `vibecarbon status`. One classifier, one `docker ps` line parser,
 * one row formatter — so what a healthy/exited/starting container looks like
 * cannot drift between "your laptop" and "your server".
 */

import { c } from '../colors.js';

/**
 * Derive a status row's health from Docker's own view of the container.
 * (Moved verbatim from src/status.js — see that file's history for the
 * rationale on `running`-without-verdict and `*-setup` one-shots.)
 *
 * @param {string} container compose service name (prefix already stripped)
 * @param {string} state `{{.State}}`
 * @param {string} status `{{.Status}}`
 * @returns {{health: 'healthy'|'unhealthy'|'starting'|'done'|'unknown', label: string, detail: string}}
 */
export function classifyContainer(container, state, status) {
  // ← paste the current body of classifyContainer from src/status.js unchanged
}

/**
 * Parse `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'` output
 * into this project's containers. Docker's `--filter name=` is an unanchored
 * regex match, so the JS prefix check is what guarantees only true
 * `${projectName}-*` names survive whatever the daemon returned.
 *
 * @param {string|null|undefined} listing
 * @param {string} projectName
 * @returns {Array<{container: string, state: string, status: string}>}
 */
export function rowsFromDockerPs(listing, projectName) {
  const prefix = `${projectName}-`;
  return (listing || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const [fullName, state = '', status = ''] = line.split('\t');
      return { container: fullName.slice(prefix.length), state, status };
    });
}

/**
 * One rendered row: icon + label coloured by health, then the detail (or the
 * probe latency when there is no detail). Name is padded to 28 columns.
 *
 * @param {{name: string, health: string, label: string, detail: string, latencyMs: number}} row
 * @param {string} [indent]
 * @returns {string}
 */
export function formatContainerRow(row, indent = '  ') {
  let icon;
  let label;
  switch (row.health) {
    case 'healthy':
      icon = c.success('●');
      label = c.dim(row.label);
      break;
    case 'unhealthy':
      icon = c.error('●');
      label = c.error(row.label);
      break;
    case 'starting':
      icon = c.warning('●');
      label = c.warning(row.label);
      break;
    default: // done, unknown
      icon = c.dim('○');
      label = c.dim(row.label);
  }
  const tail = row.detail ? c.dim(row.detail) : row.latencyMs ? c.dim(`${row.latencyMs}ms`) : '';
  return `${indent}${c.dim(row.name.padEnd(28))}${icon} ${label}  ${tail}`;
}
```

In `src/status.js`:
1. Add `import { classifyContainer, formatContainerRow, rowsFromDockerPs } from './lib/status/container-rows.js';`.
2. Delete the `classifyContainer` function body and its JSDoc (keep nothing local; the import provides it). Keep `classifyContainer` in the bottom `export { … }` list — it is now a re-export of the imported binding, which ESM allows.
3. In `checkDockerContainers`, replace the `const prefix = …` line's use and the `const containers = listing.split(...)…` block with `const containers = rowsFromDockerPs(listing, projectName);`. `prefix` is still needed for the `docker ps --filter` and `docker port` argv; keep it.
4. In `formatDockerServiceLines`, replace the `for (const svc of docker) { … lines.push(…) }` loop with `for (const svc of docker) lines.push(formatContainerRow(svc));`.

Run the formatter on both files.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run --project unit tests/unit/status/container-rows.test.ts tests/unit/status/docker-services.test.ts`
Expected: both files pass with no edits to `docker-services.test.ts` (parity: same rendered lines, same rows).
Run: `pnpm lint && pnpm test:unit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/status/container-rows.js src/status.js tests/unit/status/container-rows.test.ts
git diff --cached --stat
git commit -m "refactor(status): share container classification, parsing and row rendering across local and remote" -- src/lib/status/container-rows.js src/status.js tests/unit/status/container-rows.test.ts
```

---

### Task 2: Remote planning and k8s classification (pure)

**Files:**
- Create: `src/lib/status/remote-containers.js` (pure part only; `checkRemoteContainers` comes in Task 3)
- Test: `tests/unit/status/remote-containers.test.ts` (create)

**Interfaces:**
- Consumes: `classifyContainer`, `rowsFromDockerPs` from Task 1.
- Produces:
  ```js
  export function planContainerTargets(envConfig)  // -> Array<{ serverName, ip, kind: 'compose'|'k8s' }>
  export function classifyPod(pod)                 // -> { health, label, detail }
  export function podDisplayName(pod)              // -> string  ('supabase-kong', 'app', 'supabase-db-0')
  export function rowsFromPods(podsJson)           // -> { app: Row[], platform: Record<ns, {healthy, total}> }
  export function nodeReadiness(nodesJson)         // -> { ready, total }
  export const APP_NAMESPACE = 'vibecarbon'
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/status/remote-containers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  classifyPod,
  nodeReadiness,
  planContainerTargets,
  podDisplayName,
  rowsFromPods,
} from '../../../src/lib/status/remote-containers.js';

describe('planContainerTargets', () => {
  it('compose: the single server, kind compose', () => {
    expect(planContainerTargets({ deployMode: 'compose', servers: [{ name: 'prod', ip: '1.1.1.1' }] })).toEqual([
      { serverName: 'prod', ip: '1.1.1.1', kind: 'compose' },
    ]);
  });

  it('compose-ha: primary and standby, both compose', () => {
    expect(
      planContainerTargets({
        deployMode: 'compose-ha',
        servers: [
          { name: 'prod-primary', ip: '1.1.1.1', role: 'primary' },
          { name: 'prod-standby', ip: '2.2.2.2', role: 'standby' },
        ],
      }),
    ).toEqual([
      { serverName: 'prod-primary', ip: '1.1.1.1', kind: 'compose' },
      { serverName: 'prod-standby', ip: '2.2.2.2', kind: 'compose' },
    ]);
  });

  it('kubernetes: only the master, kind k8s; workers and supabase omitted', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes',
        servers: [
          { name: 'prod', ip: '1.1.1.1', role: 'master' },
          { name: 'supabase', ip: '3.3.3.3', role: 'supabase' },
          { name: 'worker-1', ip: '4.4.4.4', role: 'worker' },
        ],
      }),
    ).toEqual([{ serverName: 'prod', ip: '1.1.1.1', kind: 'k8s' }]);
  });

  it('kubernetes with no roles recorded: falls back to servers[0]', () => {
    expect(planContainerTargets({ deployMode: 'kubernetes', servers: [{ name: 'prod', ip: '1.1.1.1' }] })).toEqual([
      { serverName: 'prod', ip: '1.1.1.1', kind: 'k8s' },
    ]);
  });

  it('kubernetes-ha: primary and standby cluster masters, kind k8s', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes-ha',
        servers: [
          { name: 'prod-primary', ip: '1.1.1.1', role: 'primary' },
          { name: 'prod-standby', ip: '2.2.2.2', role: 'standby' },
          { name: 'worker-1', ip: '4.4.4.4', role: 'worker' },
        ],
      }),
    ).toEqual([
      { serverName: 'prod-primary', ip: '1.1.1.1', kind: 'k8s' },
      { serverName: 'prod-standby', ip: '2.2.2.2', kind: 'k8s' },
    ]);
  });

  it('returns [] with no servers', () => {
    expect(planContainerTargets({ deployMode: 'compose', servers: [] })).toEqual([]);
    expect(planContainerTargets({ deployMode: 'compose' })).toEqual([]);
  });
});

// Minimal pod fixtures: only the fields classifyPod/rowsFromPods read.
const pod = (over: Record<string, unknown>) => ({
  metadata: { name: 'app-7d9f8b5c6-abcde', namespace: 'vibecarbon', ownerReferences: [{ kind: 'ReplicaSet', name: 'app-7d9f8b5c6' }] },
  status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] },
  ...over,
});

describe('classifyPod', () => {
  it('Running with every container ready → healthy', () => {
    expect(classifyPod(pod({}))).toEqual({ health: 'healthy', label: 'healthy', detail: '' });
  });

  it('Running with a container not ready and no waiting reason → starting with ready count', () => {
    const p = pod({
      status: {
        phase: 'Running',
        containerStatuses: [
          { ready: true, restartCount: 0, state: { running: {} } },
          { ready: false, restartCount: 0, state: { running: {} } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'starting', label: 'starting', detail: 'ready 1/2' });
  });

  it('a waiting reason becomes the label; restarts become the detail', () => {
    const p = pod({
      status: {
        phase: 'Running',
        containerStatuses: [{ ready: false, restartCount: 12, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'unhealthy', label: 'CrashLoopBackOff', detail: 'restarts 12' });
  });

  it('ImagePullBackOff with zero restarts has an empty detail', () => {
    const p = pod({
      status: { phase: 'Pending', containerStatuses: [{ ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }] },
    });
    expect(classifyPod(p)).toEqual({ health: 'unhealthy', label: 'ImagePullBackOff', detail: '' });
  });

  it('Pending without a waiting reason → starting/pending with the scheduling message', () => {
    const p = pod({
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/3 nodes are available' }] },
    });
    expect(classifyPod(p)).toEqual({ health: 'starting', label: 'pending', detail: '0/3 nodes are available' });
  });

  it('Succeeded → done', () => {
    expect(classifyPod(pod({ status: { phase: 'Succeeded' } }))).toEqual({ health: 'done', label: 'done', detail: '' });
  });

  it('Failed → unhealthy/failed with the terminated reason', () => {
    const p = pod({
      status: { phase: 'Failed', containerStatuses: [{ ready: false, restartCount: 0, state: { terminated: { reason: 'Error' } } }] },
    });
    expect(classifyPod(p)).toEqual({ health: 'unhealthy', label: 'failed', detail: 'Error' });
  });

  it('Unknown → unknown', () => {
    expect(classifyPod(pod({ status: { phase: 'Unknown' } }))).toEqual({ health: 'unknown', label: 'unknown', detail: '' });
  });
});

describe('podDisplayName', () => {
  it('strips the ReplicaSet hash for Deployment pods', () => {
    expect(podDisplayName(pod({}))).toBe('app');
    expect(
      podDisplayName(pod({ metadata: { name: 'supabase-kong-5f6d7c8b9-xyz12', namespace: 'vibecarbon', ownerReferences: [{ kind: 'ReplicaSet', name: 'supabase-kong-5f6d7c8b9' }] } })),
    ).toBe('supabase-kong');
  });

  it('keeps the ordinal for StatefulSet pods', () => {
    expect(
      podDisplayName(pod({ metadata: { name: 'supabase-db-0', namespace: 'vibecarbon', ownerReferences: [{ kind: 'StatefulSet', name: 'supabase-db' }] } })),
    ).toBe('supabase-db-0');
  });

  it('falls back to the pod name with no owner', () => {
    expect(podDisplayName(pod({ metadata: { name: 'lonely', namespace: 'vibecarbon' } }))).toBe('lonely');
  });
});

describe('rowsFromPods', () => {
  const list = {
    items: [
      pod({}),
      pod({ metadata: { name: 'supabase-db-0', namespace: 'vibecarbon', ownerReferences: [{ kind: 'StatefulSet', name: 'supabase-db' }] } }),
      pod({
        metadata: { name: 'supabase-realtime-1a2b3c-q', namespace: 'vibecarbon', ownerReferences: [{ kind: 'ReplicaSet', name: 'supabase-realtime-1a2b3c' }] },
        status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 12, state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
      }),
      pod({ metadata: { name: 'source-controller-x', namespace: 'flux-system', ownerReferences: [{ kind: 'ReplicaSet', name: 'source-controller' }] } }),
      pod({ metadata: { name: 'kustomize-controller-x', namespace: 'flux-system', ownerReferences: [{ kind: 'ReplicaSet', name: 'kustomize-controller' }] }, status: { phase: 'Pending' } }),
      pod({ metadata: { name: 'cert-manager-x', namespace: 'cert-manager' } }),
      pod({ metadata: { name: 'helm-install-traefik-abc', namespace: 'kube-system' }, status: { phase: 'Succeeded' } }),
      pod({ metadata: { name: 'coredns-x', namespace: 'kube-system' } }),
    ],
  };

  it('puts vibecarbon-namespace pods in app rows, sorted by name, with the row shape', () => {
    const { app } = rowsFromPods(list);
    expect(app).toEqual([
      { name: 'app', container: 'app', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
      { name: 'supabase-db-0', container: 'supabase-db-0', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
      { name: 'supabase-realtime', container: 'supabase-realtime', health: 'unhealthy', label: 'CrashLoopBackOff', detail: 'restarts 12', latencyMs: 0 },
    ]);
  });

  it('rolls other namespaces up as healthy/total, excluding done pods from both', () => {
    const { platform } = rowsFromPods(list);
    expect(platform).toEqual({
      'flux-system': { healthy: 1, total: 2 },
      'cert-manager': { healthy: 1, total: 1 },
      'kube-system': { healthy: 1, total: 1 },
    });
  });

  it('handles an empty list', () => {
    expect(rowsFromPods({ items: [] })).toEqual({ app: [], platform: {} });
  });
});

describe('nodeReadiness', () => {
  it('counts Ready=True nodes over all nodes', () => {
    const nodes = {
      items: [
        { status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        { status: { conditions: [{ type: 'Ready', status: 'False' }] } },
        { status: { conditions: [{ type: 'MemoryPressure', status: 'False' }] } },
      ],
    };
    expect(nodeReadiness(nodes)).toEqual({ ready: 1, total: 3 });
  });

  it('handles an empty list', () => {
    expect(nodeReadiness({ items: [] })).toEqual({ ready: 0, total: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/remote-containers.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the pure part**

Create `src/lib/status/remote-containers.js`:

```js
/**
 * Remote container/pod health for `vibecarbon status`.
 *
 * Every deployed server (compose) or cluster master (k8s) gets a table built
 * from the platform's own verdicts — `docker ps -a` status strings or pod
 * container statuses — mapped onto the same row shape the local Docker block
 * uses, so "exited", "CrashLoopBackOff" and "starting" read the same
 * everywhere. Collection is over SSH (the deployed app's internal services
 * endpoint needs a super_admin browser session the CLI does not have),
 * best-effort and hard-bounded per server: a dead server yields a row that
 * says so, never a thrown check.
 */

import { classifyContainer, rowsFromDockerPs } from './container-rows.js';

export const APP_NAMESPACE = 'vibecarbon';

/**
 * Which servers to query, and how, for one environment.
 *
 * compose → its single server; compose-ha → primary + standby; kubernetes →
 * the master (workers and a dedicated supabase VM are nodes, not stacks —
 * their pods show up in the cluster table); kubernetes-ha → the primary and
 * standby cluster masters.
 *
 * @param {{deployMode?: string, servers?: Array<{name?: string, ip?: string, role?: string}>}} envConfig
 * @returns {Array<{serverName: string, ip: string, kind: 'compose'|'k8s'}>}
 */
export function planContainerTargets(envConfig) {
  const servers = envConfig?.servers || [];
  if (servers.length === 0) return [];
  const mode = envConfig.deployMode || 'compose';
  const target = (s, kind) => ({ serverName: s.name || s.ip || '', ip: s.ip || '', kind });

  if (mode === 'compose') return [target(servers[0], 'compose')];
  if (mode === 'compose-ha') {
    return servers.filter((s) => s.role === 'primary' || s.role === 'standby').map((s) => target(s, 'compose'));
  }
  if (mode === 'kubernetes-ha') {
    return servers.filter((s) => s.role === 'primary' || s.role === 'standby').map((s) => target(s, 'k8s'));
  }
  // kubernetes: the control plane. Roles were not always recorded, so fall
  // back to the first server, which the orchestrator writes as the master.
  const master = servers.find((s) => s.role === 'master') || servers[0];
  return [target(master, 'k8s')];
}

/**
 * Pod → row health, from phase + container statuses.
 *
 * @param {object} pod a `kubectl get pods -o json` item
 * @returns {{health: string, label: string, detail: string}}
 */
export function classifyPod(pod) {
  const phase = pod?.status?.phase || 'Unknown';
  const statuses = pod?.status?.containerStatuses || [];
  const waiting = statuses.find((cs) => cs.state?.waiting?.reason);
  if (waiting) {
    const restarts = statuses.reduce((n, cs) => n + (cs.restartCount || 0), 0);
    return { health: 'unhealthy', label: waiting.state.waiting.reason, detail: restarts > 0 ? `restarts ${restarts}` : '' };
  }
  if (phase === 'Succeeded') return { health: 'done', label: 'done', detail: '' };
  if (phase === 'Failed') {
    const terminated = statuses.find((cs) => cs.state?.terminated?.reason);
    return { health: 'unhealthy', label: 'failed', detail: terminated?.state.terminated.reason || '' };
  }
  if (phase === 'Pending') {
    const sched = (pod.status?.conditions || []).find((cd) => cd.type === 'PodScheduled' && cd.status === 'False');
    return { health: 'starting', label: 'pending', detail: sched?.message || '' };
  }
  if (phase === 'Running') {
    const ready = statuses.filter((cs) => cs.ready).length;
    if (statuses.length > 0 && ready === statuses.length) return { health: 'healthy', label: 'healthy', detail: '' };
    return { health: 'starting', label: 'starting', detail: `ready ${ready}/${statuses.length}` };
  }
  return { health: 'unknown', label: 'unknown', detail: '' };
}

/**
 * Name a pod by its controller: Deployment pods drop the ReplicaSet hash
 * (`app-7d9f8b5c6-abcde` → `app`), StatefulSet pods keep their ordinal
 * (`supabase-db-0`), everything else is the pod name.
 *
 * @param {object} pod
 * @returns {string}
 */
export function podDisplayName(pod) {
  const name = pod?.metadata?.name || '';
  const owner = pod?.metadata?.ownerReferences?.[0];
  if (owner?.kind === 'ReplicaSet') return owner.name.replace(/-[0-9a-f]{5,10}$/, '');
  return name;
}

/**
 * Split a `kubectl get pods -A -o json` list into app rows (vibecarbon
 * namespace) and per-namespace rollups for everything else.
 *
 * @param {{items?: object[]}} podsJson
 * @returns {{app: Array<{name: string, container: string, health: string, label: string, detail: string, latencyMs: number}>, platform: Record<string, {healthy: number, total: number}>}}
 */
export function rowsFromPods(podsJson) {
  const app = [];
  const platform = {};
  for (const pod of podsJson?.items || []) {
    const ns = pod?.metadata?.namespace || '';
    const verdict = classifyPod(pod);
    if (ns === APP_NAMESPACE) {
      const name = podDisplayName(pod);
      app.push({ name, container: name, ...verdict, latencyMs: 0 });
      continue;
    }
    if (verdict.health === 'done') continue;
    const bucket = (platform[ns] ||= { healthy: 0, total: 0 });
    bucket.total += 1;
    if (verdict.health === 'healthy') bucket.healthy += 1;
  }
  app.sort((a, b) => a.name.localeCompare(b.name));
  return { app, platform };
}

/**
 * @param {{items?: object[]}} nodesJson `kubectl get nodes -o json`
 * @returns {{ready: number, total: number}}
 */
export function nodeReadiness(nodesJson) {
  const items = nodesJson?.items || [];
  const ready = items.filter((n) =>
    (n?.status?.conditions || []).some((cd) => cd.type === 'Ready' && cd.status === 'True'),
  ).length;
  return { ready, total: items.length };
}

// re-exported so Task 3 can build compose rows without a second import site
export { classifyContainer, rowsFromDockerPs };
```

- [ ] **Step 4: Verify**

Run: `pnpm vitest run --project unit tests/unit/status/remote-containers.test.ts` → pass. `pnpm lint && pnpm test:unit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/status/remote-containers.js tests/unit/status/remote-containers.test.ts
git diff --cached --stat
git commit -m "feat(status): plan remote container targets and classify pods onto the shared row shape" -- src/lib/status/remote-containers.js tests/unit/status/remote-containers.test.ts
```

---

### Task 3: `checkRemoteContainers` collection over SSH

**Files:**
- Modify: `src/lib/status/remote-containers.js` (add `checkRemoteContainers`)
- Test: `tests/unit/status/remote-containers.test.ts` (append)

**Interfaces:**
- Consumes: `sshRun(ip, keyPath, argv, { timeout, silent })` resolves stdout or throws; `sshKubectl(ip, keyPath, kubectlArgv, opts)` same; `getSSHKeyPath(envName)` from `src/lib/ssh.js`; `existsSync`.
- Produces:
  ```js
  export async function checkRemoteContainers(envName, envConfig, projectName, deps = {})
  // deps: { sshRun?, sshKubectl?, getSSHKeyPath?, existsSync?, timeoutMs? = 10_000 }
  // -> Record<serverName, ServerContainers> | null   (null when no targets or no projectName)
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/status/remote-containers.test.ts` (add `vi` and `checkRemoteContainers` to the imports):

```ts
describe('checkRemoteContainers', () => {
  const composeHa = {
    deployMode: 'compose-ha',
    servers: [
      { name: 'p', ip: '1.1.1.1', role: 'primary' },
      { name: 's', ip: '2.2.2.2', role: 'standby' },
    ],
  };
  const base = () => ({
    getSSHKeyPath: vi.fn(() => '/tmp/key'),
    existsSync: vi.fn(() => true),
    sshKubectl: vi.fn(async () => '{}'),
  });

  it('returns null with no project name or no servers', async () => {
    expect(await checkRemoteContainers('prod', composeHa, undefined, base())).toBeNull();
    expect(await checkRemoteContainers('prod', { deployMode: 'compose', servers: [] }, 'letsgo', base())).toBeNull();
  });

  it('reports "no ssh key" for every server without touching the network', async () => {
    const deps = { ...base(), existsSync: vi.fn(() => false), sshRun: vi.fn() };
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', deps);
    expect(out).toEqual({
      p: { kind: 'compose', ip: '1.1.1.1', rows: [], error: 'no ssh key' },
      s: { kind: 'compose', ip: '2.2.2.2', rows: [], error: 'no ssh key' },
    });
    expect(deps.sshRun).not.toHaveBeenCalled();
  });

  it('compose: runs docker ps -a per server and classifies rows', async () => {
    const sshRun = vi.fn(async (ip: string) =>
      ip === '1.1.1.1'
        ? 'letsgo-db\trunning\tUp 1h (healthy)\nletsgo-kong\trunning\tUp 1h (healthy)\n'
        : 'letsgo-db\trunning\tUp 1h (healthy)\nletsgo-kong\texited\tExited (128) 3 hours ago\n',
    );
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', { ...base(), sshRun });
    expect(sshRun).toHaveBeenCalledTimes(2);
    expect(sshRun.mock.calls[0][2]).toEqual([
      'docker', 'ps', '-a', '--filter', 'name=^letsgo-', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}',
    ]);
    expect(out!.p).toEqual({
      kind: 'compose',
      ip: '1.1.1.1',
      rows: [
        { name: 'PostgreSQL', container: 'db', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
        { name: 'Kong Gateway', container: 'kong', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 },
      ],
    });
    expect(out!.s.rows[1]).toMatchObject({ container: 'kong', health: 'unhealthy', label: 'exited', detail: 'Exited (128) 3 hours ago' });
  });

  it('one server failing does not affect the other', async () => {
    const sshRun = vi.fn(async (ip: string) => {
      if (ip === '2.2.2.2') throw new Error('ssh: connect to host 2.2.2.2 port 22: Connection timed out\nmore');
      return 'letsgo-db\trunning\tUp 1h (healthy)\n';
    });
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', { ...base(), sshRun });
    expect(out!.p.error).toBeUndefined();
    expect(out!.p.rows).toHaveLength(1);
    expect(out!.s).toEqual({ kind: 'compose', ip: '2.2.2.2', rows: [], error: 'ssh: connect to host 2.2.2.2 port 22: Connection timed out' });
  });

  it('a server with no ip is reported, not queried', async () => {
    const sshRun = vi.fn();
    const out = await checkRemoteContainers('prod', { deployMode: 'compose', servers: [{ name: 'p' }] }, 'letsgo', { ...base(), sshRun });
    expect(out).toEqual({ p: { kind: 'compose', ip: '', rows: [], error: 'no ip recorded' } });
    expect(sshRun).not.toHaveBeenCalled();
  });

  it('bounds each server by timeoutMs', async () => {
    const sshRun = vi.fn(() => new Promise(() => {}));
    const out = await checkRemoteContainers('prod', { deployMode: 'compose', servers: [{ name: 'p', ip: '1.1.1.1' }] }, 'letsgo', {
      ...base(),
      sshRun,
      timeoutMs: 20,
    });
    expect(out!.p.error).toBe('ssh timeout');
  });

  it('k8s: pods + nodes on the master, app rows and platform rollups', async () => {
    const pods = {
      items: [
        { metadata: { name: 'app-abc12-x', namespace: 'vibecarbon', ownerReferences: [{ kind: 'ReplicaSet', name: 'app-abc12' }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } },
        { metadata: { name: 'source-controller-x', namespace: 'flux-system' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } },
      ],
    };
    const nodes = { items: [{ status: { conditions: [{ type: 'Ready', status: 'True' }] } }] };
    const sshKubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      argv[1] === 'pods' ? JSON.stringify(pods) : JSON.stringify(nodes),
    );
    const out = await checkRemoteContainers('prod', { deployMode: 'kubernetes', servers: [{ name: 'm', ip: '1.1.1.1', role: 'master' }] }, 'letsgo', {
      ...base(),
      sshKubectl,
      sshRun: vi.fn(),
    });
    expect(sshKubectl.mock.calls.map((c) => c[2])).toEqual([
      ['get', 'pods', '-A', '-o', 'json'],
      ['get', 'nodes', '-o', 'json'],
    ]);
    expect(out!.m).toEqual({
      kind: 'k8s',
      ip: '1.1.1.1',
      rows: [{ name: 'app', container: 'app', health: 'healthy', label: 'healthy', detail: '', latencyMs: 0 }],
      platform: { 'flux-system': { healthy: 1, total: 1 } },
      nodes: { ready: 1, total: 1 },
    });
  });

  it('k8s: unparseable kubectl output is an error row', async () => {
    const out = await checkRemoteContainers('prod', { deployMode: 'kubernetes', servers: [{ name: 'm', ip: '1.1.1.1', role: 'master' }] }, 'letsgo', {
      ...base(),
      sshKubectl: vi.fn(async () => 'error: You must be logged in'),
      sshRun: vi.fn(),
    });
    expect(out!.m).toEqual({ kind: 'k8s', ip: '1.1.1.1', rows: [], error: 'kubectl output unparseable' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/remote-containers.test.ts`
Expected: FAIL — `checkRemoteContainers` is not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/status/remote-containers.js` (imports at top: `import { existsSync as fsExistsSync } from 'node:fs'; import { getSSHKeyPath as defaultGetKey, sshKubectl as defaultKubectl, sshRun as defaultSsh } from '../ssh.js';` and `SERVICE_DISPLAY_NAMES` — move that constant from `src/status.js` into `container-rows.js` and export it from there; `status.js` imports it back):

```js
const DOCKER_PS_ARGV = ['docker', 'ps', '-a', '--filter', null, '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'];

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('ssh timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function firstLine(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].trim();
}

async function collectCompose(target, projectName, keyPath, deps) {
  const argv = DOCKER_PS_ARGV.map((a) => (a === null ? `name=^${projectName}-` : a));
  const listing = await withTimeout(deps.sshRun(target.ip, keyPath, argv, { silent: true, timeout: deps.timeoutMs }), deps.timeoutMs);
  const rows = rowsFromDockerPs(listing, projectName).map(({ container, state, status }) => ({
    name: SERVICE_DISPLAY_NAMES[container] || container,
    container,
    ...classifyContainer(container, state, status),
    latencyMs: 0,
  }));
  return { kind: 'compose', ip: target.ip, rows };
}

async function collectK8s(target, keyPath, deps) {
  const run = (argv) => withTimeout(deps.sshKubectl(target.ip, keyPath, argv, { silent: true, timeout: deps.timeoutMs }), deps.timeoutMs);
  const [podsRaw, nodesRaw] = await Promise.all([run(['get', 'pods', '-A', '-o', 'json']), run(['get', 'nodes', '-o', 'json'])]);
  let pods;
  let nodes;
  try {
    pods = JSON.parse(podsRaw);
    nodes = JSON.parse(nodesRaw);
  } catch {
    throw new Error('kubectl output unparseable');
  }
  const { app, platform } = rowsFromPods(pods);
  return { kind: 'k8s', ip: target.ip, rows: app, platform, nodes: nodeReadiness(nodes) };
}

/**
 * Per-server container/pod tables for one environment. Best-effort and
 * bounded: every server resolves to a `ServerContainers`, with `error` set
 * instead of rows when it could not be read. Null when there is nothing to
 * query (no servers, no project name).
 *
 * @param {string} envName
 * @param {object} envConfig
 * @param {string|undefined} projectName
 * @param {{sshRun?: typeof defaultSsh, sshKubectl?: typeof defaultKubectl, getSSHKeyPath?: typeof defaultGetKey, existsSync?: typeof fsExistsSync, timeoutMs?: number}} [deps]
 * @returns {Promise<Record<string, {kind: 'compose'|'k8s', ip: string, rows: object[], platform?: object, nodes?: object, error?: string}>|null>}
 */
export async function checkRemoteContainers(envName, envConfig, projectName, deps = {}) {
  const d = {
    sshRun: deps.sshRun || defaultSsh,
    sshKubectl: deps.sshKubectl || defaultKubectl,
    getSSHKeyPath: deps.getSSHKeyPath || defaultGetKey,
    existsSync: deps.existsSync || fsExistsSync,
    timeoutMs: deps.timeoutMs ?? 10_000,
  };
  if (!projectName) return null;
  const targets = planContainerTargets(envConfig);
  if (targets.length === 0) return null;

  const keyPath = d.getSSHKeyPath(envName);
  const haveKey = !!keyPath && d.existsSync(keyPath);

  const results = await Promise.all(
    targets.map(async (t) => {
      const empty = (error) => [t.serverName, { kind: t.kind, ip: t.ip, rows: [], error }];
      if (!t.ip) return empty('no ip recorded');
      if (!haveKey) return empty('no ssh key');
      try {
        const value = t.kind === 'k8s' ? await collectK8s(t, keyPath, d) : await collectCompose(t, projectName, keyPath, d);
        return [t.serverName, value];
      } catch (err) {
        return empty(firstLine(err));
      }
    }),
  );
  return Object.fromEntries(results);
}
```

Note on `SERVICE_DISPLAY_NAMES`: move the constant (and `CORE_SERVICE_ORDER`, which `checkDockerContainers` still uses for sorting) into `src/lib/status/container-rows.js` as exports; `src/status.js` imports them. Remote rows are not re-sorted by `CORE_SERVICE_ORDER` — server-side order is `docker ps` order, which is fine because only exceptions render; `-json` consumers get the raw order. (Ruling recorded here so the reviewer does not flag it as drift: sorting is a display concern and the exceptions list is short.)

- [ ] **Step 4: Verify**

Run: `pnpm vitest run --project unit tests/unit/status/remote-containers.test.ts tests/unit/status/container-rows.test.ts tests/unit/status/docker-services.test.ts` → pass. `pnpm lint && pnpm test:unit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/status/remote-containers.js src/lib/status/container-rows.js src/status.js tests/unit/status/remote-containers.test.ts
git diff --cached --stat
git commit -m "feat(status): collect per-server container and pod health over ssh, bounded and best-effort" -- src/lib/status/remote-containers.js src/lib/status/container-rows.js src/status.js tests/unit/status/remote-containers.test.ts
```

---

### Task 4: Wire collection into `status`, switch the probe to `/ready`, integration test

**Files:**
- Modify: `src/status.js` (`checkRemoteHealth`, the environment loop in `main`)
- Test: `tests/unit/status/remote-health-url.test.ts` (create), `tests/integration/cli/status/*.test.ts` (find the existing status integration file; append one case)

- [ ] **Step 1: Write the failing tests**

`tests/unit/status/remote-health-url.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { checkRemoteHealth } from '../../../src/status.js';

describe('checkRemoteHealth', () => {
  it('probes the readiness endpoint so the db/supabase detail can render', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ready', checks: { database: 'connected', supabase: 'connected' } }) }));
    const out = await checkRemoteHealth('example.test', { fetch: fetchSpy as unknown as typeof fetch });
    expect(out.url).toBe('https://example.test/api/health/ready');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.test/api/health/ready');
  });
});
```

For this to be testable, `checkRemoteHealth(domain, deps = {})` gains `deps.fetch` and passes it to `checkHttpEndpoint`; give `checkHttpEndpoint(url, timeout, fetchImpl = fetch)` a third parameter. Export `checkRemoteHealth`.

Integration: open the status integration test under `tests/integration/cli/` (grep `describe('status`). Add a case that creates a fixture project with a `.vibecarbon/config` (or whatever the fixture helper writes) containing one environment `{ deployMode: 'compose', domain: 'example.invalid', servers: [{ name: 'prod', ip: '203.0.113.10' }] }`, runs `status -json` with `HOME` pointed at an empty temp dir (so no SSH key), and asserts:

```ts
const json = JSON.parse(r.stdout);
expect(json.environments.prod.checks.containers).toEqual({
  prod: { kind: 'compose', ip: '203.0.113.10', rows: [], error: 'no ssh key' },
});
expect(json.environments.prod.checks.remoteHealth.url).toBe('https://example.invalid/api/health/ready');
expect(r.exitCode).toBe(0);
```

Follow the file's existing fixture helpers exactly (read the first existing test in that file for how a project + environment is seeded).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/remote-health-url.test.ts` → FAIL (`checkRemoteHealth` not exported / wrong URL). Run the integration file → FAIL (`containers` undefined).

- [ ] **Step 3: Implement**

`src/status.js`:
- `checkHttpEndpoint(url, timeout = 2000, fetchImpl = fetch)` — replace the internal `fetch(` call with `fetchImpl(`.
- `checkRemoteHealth(domain, deps = {})`: `const url = \`https://${domain}/api/health/ready\`; const result = await checkHttpEndpoint(url, 5000, deps.fetch || fetch);` rest unchanged.
- In the renderer's Health block, the `data.database` / `data.supabase` lookups become `data.checks?.database ?? data.database` / `data.checks?.supabase ?? data.supabase` (the `/ready` body nests them under `checks`; verify against `carbon/src/server/routes/health.ts:28-33` and use the exact field names it returns).
- In `main`'s environment loop, after `checks.replication = …`:
  ```js
  // Per-server container/pod health (spec: remote-container-health). Runs
  // for every server of the env, bounded per server; null when there is
  // nothing to query. Independent of noLocal — that flag is about THIS
  // machine's dev stack.
  checks.containers = await checkRemoteContainers(envName, envConfig, projectConfig.projectName);
  ```
  with `import { checkRemoteContainers } from './lib/status/remote-containers.js';`.
- Add `checkRemoteHealth` to the export list.

- [ ] **Step 4: Verify**

`pnpm vitest run --project unit tests/unit/status/` → pass. `pnpm lint && pnpm test:unit && pnpm test:cli` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/status.js tests/unit/status/remote-health-url.test.ts tests/integration/cli/status/
git diff --cached --stat
git commit -m "feat(status): gather remote container health per environment and probe /api/health/ready" -- src/status.js tests/unit/status/remote-health-url.test.ts tests/integration/cli/status/
```

---

### Task 5: Render the rollup and count it in the summary

**Files:**
- Modify: `src/status.js` (`formatServerLines` new pure fn; `renderEnvironment` Servers block uses it; `isEnvironmentUnhealthy` new pure fn; `renderSummary` uses it; exports)
- Test: `tests/unit/status/render-environment.test.ts` (create)

**Interfaces:**
- Produces:
  ```js
  export function formatServerLines(servers, checks)   // -> string[]  (the whole Servers block body, no header)
  export function isEnvironmentUnhealthy(entry)        // entry = { config, checks } -> boolean
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/status/render-environment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatServerLines, isEnvironmentUnhealthy } from '../../../src/status.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const row = (container: string, health: string, label = health, detail = '') => ({
  name: container,
  container,
  health,
  label,
  detail,
  latencyMs: 0,
});
const servers = [
  { id: 'a', name: 'prod-primary', ip: '1.1.1.1', serverType: 'cpx31' },
  { id: 'b', name: 'prod-standby', ip: '2.2.2.2', serverType: 'cpx31' },
];

describe('formatServerLines', () => {
  it('healthy compose servers collapse to one rollup line each', () => {
    const lines = formatServerLines(servers, {
      containers: {
        'prod-primary': { kind: 'compose', ip: '1.1.1.1', rows: [row('db', 'healthy'), row('kong', 'healthy')] },
        'prod-standby': { kind: 'compose', ip: '2.2.2.2', rows: [row('db', 'healthy'), row('kong', 'healthy')] },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    containers ● 2/2 healthy',
      '  prod-standby     2.2.2.2         cpx31',
      '    containers ● 2/2 healthy',
    ]);
  });

  it('non-healthy rows expand under the rollup; done rows are neither counted nor shown', () => {
    const lines = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': {
          kind: 'compose',
          ip: '1.1.1.1',
          rows: [row('db', 'healthy'), row('kong', 'unhealthy', 'exited', 'Exited (128) 3 hours ago'), row('x-setup', 'done'), row('rest', 'starting')],
        },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    containers ● 1/3 healthy',
      '      kong                        ● exited  Exited (128) 3 hours ago',
      '      rest                        ● starting  ',
    ]);
  });

  it('k8s rollup carries nodes and platform namespaces; a short namespace is an exception line', () => {
    const lines = formatServerLines([servers[0]], {
      containers: {
        'prod-primary': {
          kind: 'k8s',
          ip: '1.1.1.1',
          rows: [row('app', 'healthy'), row('supabase-db-0', 'healthy')],
          platform: { 'flux-system': { healthy: 4, total: 4 }, 'cert-manager': { healthy: 2, total: 3 } },
          nodes: { ready: 3, total: 3 },
        },
      },
    }).map(strip);
    expect(lines).toEqual([
      '  prod-primary     1.1.1.1         cpx31',
      '    pods ● 2/2 healthy · nodes 3/3 ready · flux-system 4/4 · cert-manager 2/3',
      '      cert-manager                ○ 2/3 healthy  ',
    ]);
  });

  it('an ssh failure renders as unreachable in red', () => {
    const lines = formatServerLines([servers[0]], {
      containers: { 'prod-primary': { kind: 'compose', ip: '1.1.1.1', rows: [], error: 'ssh timeout' } },
    });
    expect(strip(lines[1])).toBe('    containers ● unreachable  ssh timeout');
    expect(lines[1]).toContain('\x1b[31m');
  });

  it('without containers data the server line stands alone (unchanged behaviour)', () => {
    expect(formatServerLines([servers[0]], {}).map(strip)).toEqual(['  prod-primary     1.1.1.1         cpx31']);
  });

  it('keeps the provider status when serverInfo is present', () => {
    const lines = formatServerLines([servers[0]], {
      serverInfo: { a: { status: 'running', serverType: 'cpx31' } },
      containers: { 'prod-primary': { kind: 'compose', ip: '1.1.1.1', rows: [row('db', 'healthy')] } },
    }).map(strip);
    expect(lines[0]).toBe('  prod-primary     1.1.1.1         ● running  cpx31');
  });

  it('colours the rollup green when all healthy, yellow otherwise', () => {
    const ok = formatServerLines([servers[0]], { containers: { 'prod-primary': { kind: 'compose', ip: '', rows: [row('db', 'healthy')] } } });
    const bad = formatServerLines([servers[0]], { containers: { 'prod-primary': { kind: 'compose', ip: '', rows: [row('db', 'starting')] } } });
    expect(ok[1]).toContain('\x1b[32m');
    expect(bad[1]).toContain('\x1b[33m');
    const nodesShort = formatServerLines([servers[0]], {
      containers: { 'prod-primary': { kind: 'k8s', ip: '', rows: [row('app', 'healthy')], platform: {}, nodes: { ready: 2, total: 3 } } },
    });
    expect(nodesShort[1]).toContain('\x1b[33m');
  });
});

describe('isEnvironmentUnhealthy', () => {
  const healthyEntry = {
    config: {},
    checks: {
      remoteHealth: { ok: true },
      containers: { p: { kind: 'k8s', ip: '', rows: [row('app', 'healthy'), row('job', 'done')], platform: { 'flux-system': { healthy: 1, total: 1 } }, nodes: { ready: 1, total: 1 } } },
    },
  };
  it('is false when the probe is ok and every server is clean', () => {
    expect(isEnvironmentUnhealthy(healthyEntry)).toBe(false);
  });
  it('is true on probe failure', () => {
    expect(isEnvironmentUnhealthy({ ...healthyEntry, checks: { ...healthyEntry.checks, remoteHealth: { ok: false } } })).toBe(true);
  });
  it('is true on a non-healthy row, a platform shortfall, a node shortfall, or an ssh error', () => {
    const with_ = (server: object) => ({ ...healthyEntry, checks: { ...healthyEntry.checks, containers: { p: server } } });
    expect(isEnvironmentUnhealthy(with_({ kind: 'compose', ip: '', rows: [row('db', 'starting')] }))).toBe(true);
    expect(isEnvironmentUnhealthy(with_({ kind: 'k8s', ip: '', rows: [], platform: { 'cert-manager': { healthy: 2, total: 3 } }, nodes: { ready: 1, total: 1 } }))).toBe(true);
    expect(isEnvironmentUnhealthy(with_({ kind: 'k8s', ip: '', rows: [], platform: {}, nodes: { ready: 0, total: 1 } }))).toBe(true);
    expect(isEnvironmentUnhealthy(with_({ kind: 'compose', ip: '', rows: [], error: 'ssh timeout' }))).toBe(true);
  });
  it('is false with no containers data and an ok probe (pre-existing behaviour)', () => {
    expect(isEnvironmentUnhealthy({ config: {}, checks: { remoteHealth: { ok: true } } })).toBe(false);
    expect(isEnvironmentUnhealthy({ config: {}, checks: {} })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/status/render-environment.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement**

In `src/status.js`, above `renderEnvironment`:

```js
/**
 * Is one server's container view fully healthy? Counts rows other than
 * `done`, and for k8s also every platform namespace and every node.
 */
function serverContainersHealthy(sc) {
  if (!sc || sc.error) return false;
  const counted = sc.rows.filter((r) => r.health !== 'done');
  if (counted.some((r) => r.health !== 'healthy')) return false;
  for (const ns of Object.values(sc.platform || {})) if (ns.healthy !== ns.total) return false;
  if (sc.nodes && sc.nodes.ready !== sc.nodes.total) return false;
  return true;
}

/**
 * The Servers block body: one line per server, then — when container data
 * exists for it — one rollup line and only the rows that are not healthy.
 * A healthy server costs exactly one extra line; a broken one shows what is
 * broken. See spec §3.
 *
 * @param {Array<{id?: string, name?: string, ip?: string, serverType?: string, type?: string}>} servers
 * @param {{serverInfo?: object, containers?: object}} checks
 * @returns {string[]}
 */
function formatServerLines(servers, checks) {
  const lines = [];
  for (const server of servers) {
    const serverInfo = checks.serverInfo?.[server.id];
    const configType = server.serverType || server.type || null;
    let statusStr;
    if (serverInfo) {
      const icon = serverInfo.status === 'running' ? c.success('●') : c.error('●');
      const typeLabel = serverInfo.serverType || configType || '';
      statusStr = `${icon} ${serverInfo.status === 'running' ? c.success('running') : c.error(serverInfo.status)}  ${c.dim(typeLabel)}`;
    } else if (configType) {
      statusStr = c.dim(configType);
    } else {
      statusStr = c.dim('–');
    }
    lines.push(`  ${c.info((server.name || '').padEnd(16))} ${(server.ip || '').padEnd(15)} ${statusStr}`);

    const sc = checks.containers?.[server.name];
    if (!sc) continue;
    const noun = sc.kind === 'k8s' ? 'pods' : 'containers';
    if (sc.error) {
      lines.push(`    ${c.dim(noun)} ${c.error('● unreachable')}  ${c.dim(sc.error)}`);
      continue;
    }
    const counted = sc.rows.filter((r) => r.health !== 'done');
    const healthy = counted.filter((r) => r.health === 'healthy').length;
    const parts = [`● ${healthy}/${counted.length} healthy`];
    if (sc.nodes) parts.push(`nodes ${sc.nodes.ready}/${sc.nodes.total} ready`);
    for (const [ns, n] of Object.entries(sc.platform || {})) parts.push(`${ns} ${n.healthy}/${n.total}`);
    const paint = serverContainersHealthy(sc) ? c.success : c.warning;
    lines.push(`    ${c.dim(noun)} ${paint(parts.join(' · '))}`);

    for (const r of sc.rows) {
      if (r.health === 'healthy' || r.health === 'done') continue;
      lines.push(formatContainerRow(r, '      '));
    }
    for (const [ns, n] of Object.entries(sc.platform || {})) {
      if (n.healthy === n.total) continue;
      lines.push(formatContainerRow({ name: ns, container: ns, health: 'unknown', label: `${n.healthy}/${n.total} healthy`, detail: '', latencyMs: 0 }, '      '));
    }
  }
  return lines;
}

/**
 * Summary-block verdict for one environment: the public probe failed, or
 * any server's containers are not fully healthy.
 * @param {{checks?: {remoteHealth?: {ok?: boolean}, containers?: object}}} entry
 */
function isEnvironmentUnhealthy(entry) {
  const checks = entry?.checks || {};
  if (checks.remoteHealth && !checks.remoteHealth.ok) return true;
  for (const sc of Object.values(checks.containers || {})) if (!serverContainersHealthy(sc)) return true;
  return false;
}
```

In `renderEnvironment`, replace the `for (const server of servers) { … }` loop body (from `const serverInfo = …` through the `lines.push(…)` for the server line) with `lines.push(...formatServerLines(servers, checks));`.

In `renderSummary`, replace the `unhealthyCount` filter predicate with `isEnvironmentUnhealthy`.

Export `formatServerLines` and `isEnvironmentUnhealthy`.

- [ ] **Step 4: Verify**

`pnpm vitest run --project unit tests/unit/status/` → pass. `pnpm lint && pnpm test:unit && pnpm test:cli`.

Manual: on a project with a deployed environment and a local SSH key, `vibecarbon status` shows the rollup under each server; `vibecarbon status -json | jq '.environments[].checks.containers'` shows the full rows.

- [ ] **Step 5: Commit**

```bash
git add src/status.js tests/unit/status/render-environment.test.ts
git diff --cached --stat
git commit -m "feat(status): exceptions-only container rollup under each server, counted in the summary" -- src/status.js tests/unit/status/render-environment.test.ts
```

---

### Task 6: e2e `verify-status` check + perf exclusion

**Files:**
- Modify: `tests/e2e/scenarios/types.ts` (`StepName` gains `'verify-status'` after `'verify-deploy'`)
- Create: `tests/e2e/checks/status-health.ts`
- Modify: `tests/e2e/scenarios/_run-lifecycle.ts` (`TIMEOUTS['verify-status']`, step def after `verify-deploy`, step def after `verify-failover`, TODO comment)
- Modify: `tests/e2e/metrics/reporter.ts` (`NON_PERF_STEPS`, applied to the scenario-total reduce at ~line 709 and any other `duration_ms` sum; `STEP_ORDER` gains `'verify-status'` after `'verify-deploy'`)
- Test: `tests/unit/e2e/status-health-check.test.ts` (create), `tests/unit/e2e/reporter-non-perf-steps.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // tests/e2e/checks/status-health.ts
  export function assessStatusJson(json: unknown, envName: string): { ok: true } | { ok: false; retryable: boolean; problems: string[] }
  export async function checkStatusHealth(opts: { projectDir: string; envName: string; timeoutMs: number; pollMs?: number; runCli?: typeof runCli }): Promise<VerificationResult>
  // tests/e2e/metrics/reporter.ts
  export const NON_PERF_STEPS: ReadonlySet<string>
  export function perfDurationSum(steps: Array<{ name: string; duration_ms: number | null }>): number
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/e2e/status-health-check.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { assessStatusJson, checkStatusHealth } from '../../e2e/checks/status-health.js';

const row = (container: string, health: string, label = health, detail = '') => ({ name: container, container, health, label, detail, latencyMs: 0 });
const green = {
  environments: {
    prod: {
      config: {},
      checks: {
        remoteHealth: { ok: true, url: 'https://x/api/health/ready' },
        containers: {
          p: { kind: 'k8s', ip: '1.1.1.1', rows: [row('app', 'healthy'), row('job', 'done')], platform: { 'flux-system': { healthy: 4, total: 4 } }, nodes: { ready: 3, total: 3 } },
        },
      },
    },
  },
};

describe('assessStatusJson', () => {
  it('passes a fully healthy environment', () => {
    expect(assessStatusJson(green, 'prod')).toEqual({ ok: true });
  });
  it('fails, non-retryable, on an unhealthy row and names it', () => {
    const j = structuredClone(green);
    j.environments.prod.checks.containers.p.rows.push(row('supabase-kong', 'unhealthy', 'CrashLoopBackOff', 'restarts 3'));
    expect(assessStatusJson(j, 'prod')).toEqual({ ok: false, retryable: false, problems: ['p: supabase-kong CrashLoopBackOff restarts 3'] });
  });
  it('is retryable on starting rows only', () => {
    const j = structuredClone(green);
    j.environments.prod.checks.containers.p.rows.push(row('app', 'starting', 'starting', 'ready 0/1'));
    expect(assessStatusJson(j, 'prod')).toMatchObject({ ok: false, retryable: true });
  });
  it('fails on platform shortfall, node shortfall, ssh error, probe failure, missing env', () => {
    const j1 = structuredClone(green); j1.environments.prod.checks.containers.p.platform['flux-system'].healthy = 3;
    const j2 = structuredClone(green); j2.environments.prod.checks.containers.p.nodes.ready = 2;
    const j3 = structuredClone(green); j3.environments.prod.checks.containers.p = { kind: 'k8s', ip: '', rows: [], error: 'ssh timeout' };
    const j4 = structuredClone(green); j4.environments.prod.checks.remoteHealth.ok = false;
    for (const j of [j1, j2, j3, j4]) expect(assessStatusJson(j, 'prod').ok).toBe(false);
    expect(assessStatusJson(green, 'nope')).toMatchObject({ ok: false, retryable: false });
    expect(assessStatusJson({ environments: { prod: { checks: {} } } }, 'prod')).toMatchObject({ ok: false, retryable: false, problems: ['no containers data for prod'] });
  });
});

describe('checkStatusHealth', () => {
  it('polls while retryable, then passes', async () => {
    let n = 0;
    const runCli = vi.fn(async () => {
      n += 1;
      const j = structuredClone(green);
      if (n === 1) j.environments.prod.checks.containers.p.rows.push(row('app', 'starting'));
      return { exitCode: 0, stdout: JSON.stringify(j), stderr: '' };
    });
    const r = await checkStatusHealth({ projectDir: '/tmp/x', envName: 'prod', timeoutMs: 1000, pollMs: 1, runCli: runCli as never });
    expect(r.status).toBe('pass');
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(runCli.mock.calls[0][0]).toBe('status -json');
  });
  it('fails immediately on a non-retryable problem', async () => {
    const j = structuredClone(green);
    j.environments.prod.checks.containers.p.rows.push(row('kong', 'unhealthy', 'exited', 'Exited (1)'));
    const runCli = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(j), stderr: '' }));
    const r = await checkStatusHealth({ projectDir: '/tmp/x', envName: 'prod', timeoutMs: 1000, pollMs: 1, runCli: runCli as never });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('kong exited Exited (1)');
    expect(runCli).toHaveBeenCalledTimes(1);
  });
  it('fails when the CLI exits non-zero or emits invalid JSON', async () => {
    const bad = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }));
    expect((await checkStatusHealth({ projectDir: '/tmp/x', envName: 'prod', timeoutMs: 10, pollMs: 1, runCli: bad as never })).status).toBe('fail');
    const junk = vi.fn(async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }));
    expect((await checkStatusHealth({ projectDir: '/tmp/x', envName: 'prod', timeoutMs: 10, pollMs: 1, runCli: junk as never })).status).toBe('fail');
  });
});
```

`tests/unit/e2e/reporter-non-perf-steps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NON_PERF_STEPS, PERF_TABLE_ROWS, perfDurationSum } from '../../e2e/metrics/reporter.js';

describe('non-perf steps', () => {
  it('verify-status is excluded from duration sums', () => {
    expect(NON_PERF_STEPS.has('verify-status')).toBe(true);
    expect(perfDurationSum([{ name: 'deploy', duration_ms: 100 }, { name: 'verify-status', duration_ms: 50 }, { name: 'backup', duration_ms: null }])).toBe(100);
  });
  it('verify-status is not a published perf row', () => {
    expect(PERF_TABLE_ROWS.some((r) => r.step === 'verify-status')).toBe(false);
  });
});
```

Check the `VerificationResult` shape in `tests/e2e/scenarios/types.ts:134` for the exact field carrying the failure text (the test above assumes `detail`; use the real field name and adjust the assertion).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit tests/unit/e2e/status-health-check.test.ts tests/unit/e2e/reporter-non-perf-steps.test.ts` → FAIL (modules/exports missing).

- [ ] **Step 3: Implement**

`tests/e2e/checks/status-health.ts`:

```ts
/**
 * verify-status: `vibecarbon status -json` must report every server of the
 * environment fully healthy — the public readiness probe ok, every
 * container/pod healthy (or a finished one-shot), every k8s platform
 * namespace full, every node Ready. `starting` rows are retried until
 * timeoutMs (a pod may still be rolling right after verify-deploy);
 * anything else fails on first sight. Non-perf step: excluded from the
 * reporter's totals (NON_PERF_STEPS) and never a PERF_TABLE_ROWS entry.
 */
import type { VerificationResult } from '../scenarios/types.js';
import { runCli as defaultRunCli } from '../utils/cli-runner.js';

type Row = { container: string; health: string; label: string; detail: string };
type ServerContainers = {
  kind: string;
  rows: Row[];
  platform?: Record<string, { healthy: number; total: number }>;
  nodes?: { ready: number; total: number };
  error?: string;
};

export function assessStatusJson(json: unknown, envName: string): { ok: true } | { ok: false; retryable: boolean; problems: string[] } {
  const env = (json as { environments?: Record<string, { checks?: Record<string, unknown> }> })?.environments?.[envName];
  if (!env) return { ok: false, retryable: false, problems: [`environment ${envName} missing from status -json`] };
  const checks = env.checks || {};
  const problems: string[] = [];
  let retryable = true;
  const probe = checks.remoteHealth as { ok?: boolean; status?: number; error?: string } | undefined;
  if (!probe?.ok) {
    problems.push(`readiness probe failed: ${probe?.error || `HTTP ${probe?.status}`}`);
    retryable = false;
  }
  const containers = checks.containers as Record<string, ServerContainers> | undefined;
  if (!containers) return { ok: false, retryable: false, problems: [...problems, `no containers data for ${envName}`] };
  for (const [server, sc] of Object.entries(containers)) {
    if (sc.error) {
      problems.push(`${server}: ${sc.error}`);
      retryable = false;
      continue;
    }
    for (const r of sc.rows) {
      if (r.health === 'healthy' || r.health === 'done') continue;
      problems.push(`${server}: ${r.container} ${r.label}${r.detail ? ` ${r.detail}` : ''}`);
      if (r.health !== 'starting') retryable = false;
    }
    for (const [ns, n] of Object.entries(sc.platform || {})) {
      if (n.healthy !== n.total) {
        problems.push(`${server}: ${ns} ${n.healthy}/${n.total}`);
      }
    }
    if (sc.nodes && sc.nodes.ready !== sc.nodes.total) {
      problems.push(`${server}: nodes ${sc.nodes.ready}/${sc.nodes.total} ready`);
      retryable = false;
    }
  }
  if (problems.length === 0) return { ok: true };
  return { ok: false, retryable, problems };
}

export async function checkStatusHealth(opts: {
  projectDir: string;
  envName: string;
  timeoutMs: number;
  pollMs?: number;
  runCli?: typeof defaultRunCli;
}): Promise<VerificationResult> {
  const runCli = opts.runCli ?? defaultRunCli;
  const pollMs = opts.pollMs ?? 10_000;
  const deadline = Date.now() + opts.timeoutMs;
  let last: string[] = [];
  for (;;) {
    const r = await runCli('status -json', { cwd: opts.projectDir, timeout: 120_000 });
    if (r.exitCode !== 0) return fail(`status exited ${r.exitCode}: ${(r.stderr || '').slice(-500)}`);
    let json: unknown;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      return fail(`status -json was not JSON: ${r.stdout.slice(0, 200)}`);
    }
    const verdict = assessStatusJson(json, opts.envName);
    if (verdict.ok) return { checkName: 'status-health', status: 'pass' } as VerificationResult;
    last = verdict.problems;
    if (!verdict.retryable || Date.now() + pollMs > deadline) break;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return fail(last.join('; '));

  function fail(detail: string): VerificationResult {
    return { checkName: 'status-health', status: 'fail', detail } as VerificationResult;
  }
}
```

(Adjust the `VerificationResult` literal to the real interface fields — read `types.ts:134-160`.)

`tests/e2e/scenarios/types.ts`: add `| 'verify-status'` immediately after `| 'verify-deploy'`.

`tests/e2e/scenarios/_run-lifecycle.ts`:
- `TIMEOUTS`: `'verify-status': 300_000, // 5 min — status -json polls up to 3 min for rolling pods`.
- Import `checkStatusHealth` from `'../checks/status-health.js'`.
- After the `verify-deploy` step def object, add:
  ```ts
    // 4.0 Verify status — the CLI's own view of the environment must agree
    // with what verify-deploy just proved from the outside: every container /
    // pod on every server healthy. Non-perf (see NON_PERF_STEPS).
    {
      name: 'verify-status',
      run: () =>
        executeStep('verify-status', 'vibecarbon status -json', async () => {
          const r = await checkStatusHealth({ projectDir: config.projectDir, envName: config.envPrefix, timeoutMs: 180_000 });
          if (r.status !== 'pass') throw new Error(`verify-status: ${(r as { detail?: string }).detail}`);
        }),
    },
  ```
  (`config.envPrefix` is what `runDeploy` is called with; confirm that is the environment name as it appears in `.vibecarbon/config` by checking one `runDeploy(config.envPrefix, …)` call and the config the deploy writes.)
- After the `verify-failover` `stepDefs.push({...})`, push a second `verify-status` def with the same body (HA modes only, inside the same `if` that adds `verify-failover`).
- In the `TODO (deferred from Phase 9…)` comment, change the `verify-status` line to `//   - verify-status step — DONE (tests/e2e/checks/status-health.ts)`.

`tests/e2e/metrics/reporter.ts`:
- `STEP_ORDER`: insert `'verify-status'` after `'verify-deploy'`.
- Add near `PERF_TABLE_ROWS`:
  ```ts
  /**
   * Steps that verify but do not measure: excluded from every duration sum
   * so the published grid and the scenario totals describe only what a
   * customer would wait on. verify-status polls `vibecarbon status`.
   */
  export const NON_PERF_STEPS: ReadonlySet<string> = new Set(['verify-status']);

  export function perfDurationSum(steps: Array<{ name: string; duration_ms: number | null }>): number {
    return steps.reduce((sum, s) => (NON_PERF_STEPS.has(s.name) ? sum : sum + (s.duration_ms ?? 0)), 0);
  }
  ```
- Replace the reduce at ~line 709 with `const totalMs = perfDurationSum(scenarioSteps);`. Grep the file for every other `duration_ms ?? 0` sum (line 795's `historicalDurations` is fed from per-step rows — trace where that array is built; if it includes all steps, filter with `NON_PERF_STEPS` there too).

- [ ] **Step 4: Verify**

`pnpm vitest run --project unit tests/unit/e2e/status-health-check.test.ts tests/unit/e2e/reporter-non-perf-steps.test.ts` → pass. `pnpm lint && pnpm test:unit`. Also `pnpm exec tsc -p tsconfig.e2e.json --noEmit` (the e2e tree is type-checked; confirm the script name in `package.json`, e.g. `typecheck`).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/scenarios/types.ts tests/e2e/checks/status-health.ts tests/e2e/scenarios/_run-lifecycle.ts tests/e2e/metrics/reporter.ts tests/unit/e2e/status-health-check.test.ts tests/unit/e2e/reporter-non-perf-steps.test.ts
git diff --cached --stat
git commit -m "test(e2e): verify-status step asserts per-server container health, excluded from perf totals" -- tests/e2e/scenarios/types.ts tests/e2e/checks/status-health.ts tests/e2e/scenarios/_run-lifecycle.ts tests/e2e/metrics/reporter.ts tests/unit/e2e/status-health-check.test.ts tests/unit/e2e/reporter-non-perf-steps.test.ts
```

---

### Task 7: Gate, PR, matrix run

**Files:** none (verification + PR).

- [ ] **Step 1: Rebase onto main if PR #110 has merged**

`gh pr view 110 --json state -q .state`; if `MERGED`: `git fetch origin && git rebase origin/main`, resolve nothing (the branch only adds), re-run `pnpm test:unit`.

- [ ] **Step 2: Full gate**

`pnpm test:prepush` → lint + unit + integration all green (hook-equivalent; zero failures expected now that the guard uses git grep).

- [ ] **Step 3: Push and PR**

```bash
git push -u origin feat/status-remote-container-health
gh pr create --base main --title "feat(status): real per-server container health for remote environments" --body "$(cat <<'EOF'
## Summary
- `status` now shows every server's container (compose) / pod (k8s) health under the Servers block as an exceptions-only rollup: one line when healthy, the failing rows when not. k8s adds node readiness and platform-namespace rollups.
- Collection over SSH (`docker ps -a` / `kubectl get pods,nodes`), bounded per server, best-effort; `-json` carries every row under `checks.containers`.
- Liveness probe moves to `/api/health/ready`, so `db: connected` finally renders. Summary counts container failures.
- e2e: `verify-status` after verify-deploy (and after verify-failover for HA), polling for rolling pods; excluded from perf totals (`NON_PERF_STEPS`).

Spec: docs/superpowers/specs/2026-09-18-remote-container-health-design.md
Plan: docs/superpowers/plans/2026-09-18-remote-container-health.md

## Test plan
- [ ] `pnpm test:prepush`
- [ ] `pnpm test:e2e:batch -- --provider hetzner` — `verify-status` green on compose, compose-ha, k8s, k8s-ha (lifts the release hold)
EOF
)"
```

- [ ] **Step 4: Matrix run**

Per the `running-e2e-matrix` skill and the overnight-ops memory: `pnpm test:e2e:batch -- --provider hetzner` under `setsid` with a Monitor; `verify-status` must pass in all four modes. Iterate on a kept rig (`--keep`, `iter-step`) if it fails, never re-run the whole matrix to diagnose. Record the run id in the PR. Only then: lift the release hold (delete or amend memory `release-hold-until-remote-health`).

---

## Self-review

- Spec coverage: §1 collection → Tasks 1-3; §2 probe → Task 4; §3 display → Task 5; §4 JSON → Task 4 (shape) + Task 5 (nothing else changes); §5 e2e + perf exclusion → Task 6; §6 errors → Task 3 tests (no key, timeout, no ip, unparseable) + Task 5 (`unreachable`); §7 tests → each task; matrix gate → Task 7.
- Placeholder scan: two "confirm the real field name" notes (VerificationResult detail field, `/ready` body nesting, `config.envPrefix`) are verification instructions with the file:line to check, not TODOs.
- Type consistency: `ServerContainers` and row shapes identical across Tasks 2-6; `checkRemoteContainers(envName, envConfig, projectName, deps)` matches its Task 4 call; `formatContainerRow(row, indent)` from Task 1 is what Task 5 calls; `assessStatusJson` consumes exactly the JSON Task 4 emits.
