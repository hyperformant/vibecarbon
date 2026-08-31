# CLI Telemetry Client Side Implementation Plan (vibecarbon-public)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every vibecarbon command a universal async update check, anonymous opt-out usage analytics, and sanitized crash reports — with zero risk of disrupting the underlying command.

**Architecture:** A new `src/lib/telemetry/` module (state, semver, update-check, sanitizer, sender) integrated at the single dispatch point in `src/cli.js`: fire an event at command start, print the cached update notice after the command, catch crashes for a sanitized report, and add a `telemetry on|off|status` subcommand. Everything network-touching is fire-and-forget with short timeouts and blanket catches.

**Tech Stack:** Node 24 ESM (plain JS with JSDoc, matching the codebase), built-in `fetch`, `node:crypto` `randomUUID`/`createHash`, vitest (TS tests under `tests/unit/telemetry/`).

**Spec:** `~/repos/vibecarbon-web/docs/superpowers/specs/2026-08-30-cli-telemetry-design.md` (canonical copy lives in the vibecarbon-web repo; the wire contract summary is repeated in each task below so this plan is self-contained).

## Global Constraints

- **A telemetry failure must be unobservable**: no thrown errors, no changed exit codes, no extra output (beyond the intended one-line update notice and one-time first-run notice). Every public function in `src/lib/telemetry/` catches everything.
- **Kill switches** (any one disables analytics + error reports): `VIBECARBON_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK` set to anything except `''`/`0`, persisted `disabled: true` in `~/.vibecarbon/telemetry.json`. `CI` truthy disables analytics **and** the update check.
- **Wire contract** (server: vibecarbon-web `/api/v1/...`): event = `{machine_id, project_id, command, cli_version, node_version, platform, arch, provider, deploy_target}`; error adds `{error_name, message ≤500 chars, stack ≤8192 chars, fingerprint}`. Base URL `process.env.VIBECARBON_API_BASE || 'https://vibecarbon.com'`.
- Never send raw argv, env values, hostnames, or project names.
- Match codebase style: ESM `.js` with JSDoc, single-dash flags, `c` color helpers from `src/lib/colors.js`.
- Tests: `pnpm exec vitest run tests/unit/telemetry/<file>` from the repo root.
- Commit after every green cycle.

---

### Task 1: Semver compare + persistent state (`machineId`, opt-out)

**Files:**
- Create: `src/lib/telemetry/semver.js`
- Create: `src/lib/telemetry/state.js`
- Test: `tests/unit/telemetry/semver.test.ts`, `tests/unit/telemetry/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isNewerVersion(latest: string, current: string): boolean`
  - `getTelemetryState(stateDir?: string): { machineId: string, disabled: boolean, noticeShown: boolean }` (creates + persists on first call)
  - `setTelemetryDisabled(disabled: boolean, stateDir?: string): void`
  - `markNoticeShown(stateDir?: string): void`
  - `isAnalyticsDisabled(env?: NodeJS.ProcessEnv, stateDir?: string): boolean`
  - Default `stateDir` is `join(homedir(), '.vibecarbon')`; the override exists for tests.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/telemetry/semver.test.ts
import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../../../src/lib/telemetry/semver.js';

describe('isNewerVersion', () => {
  it.each([
    ['0.42.0', '0.41.0', true],
    ['0.41.1', '0.41.0', true],
    ['1.0.0', '0.99.99', true],
    ['0.41.0', '0.41.0', false],
    ['0.41.0', '0.42.0', false],
    ['0.9.0', '0.41.0', false], // numeric, not lexicographic
  ])('(%s newer than %s) === %s', (latest, current, expected) => {
    expect(isNewerVersion(latest, current)).toBe(expected);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(isNewerVersion('banana', '0.41.0')).toBe(false);
    expect(isNewerVersion('0.42.0', '')).toBe(false);
    expect(isNewerVersion('0.42.0-rc.1', '0.41.0')).toBe(false); // prerelease: skip, never nag
  });
});
```

```typescript
// tests/unit/telemetry/state.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTelemetryState,
  isAnalyticsDisabled,
  markNoticeShown,
  setTelemetryDisabled,
} from '../../../src/lib/telemetry/state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-telemetry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getTelemetryState', () => {
  it('creates a persistent random machineId on first call', () => {
    const first = getTelemetryState(dir);
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.disabled).toBe(false);
    expect(first.noticeShown).toBe(false);
    const second = getTelemetryState(dir);
    expect(second.machineId).toBe(first.machineId); // stable across calls
    const onDisk = JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf-8'));
    expect(onDisk.machineId).toBe(first.machineId);
  });

  it('recovers from a corrupt state file by regenerating', () => {
    getTelemetryState(dir);
    require('node:fs').writeFileSync(join(dir, 'telemetry.json'), '{corrupt');
    expect(() => getTelemetryState(dir)).not.toThrow();
    expect(getTelemetryState(dir).machineId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('setTelemetryDisabled / markNoticeShown', () => {
  it('persists the flags', () => {
    getTelemetryState(dir);
    setTelemetryDisabled(true, dir);
    expect(getTelemetryState(dir).disabled).toBe(true);
    markNoticeShown(dir);
    expect(getTelemetryState(dir).noticeShown).toBe(true);
    setTelemetryDisabled(false, dir);
    expect(getTelemetryState(dir).disabled).toBe(false);
  });
});

describe('isAnalyticsDisabled', () => {
  const cleanEnv = {} as NodeJS.ProcessEnv;

  it('is false by default', () => {
    expect(isAnalyticsDisabled(cleanEnv, dir)).toBe(false);
  });

  it.each([
    [{ VIBECARBON_TELEMETRY_DISABLED: '1' }],
    [{ DO_NOT_TRACK: '1' }],
    [{ DO_NOT_TRACK: 'true' }],
    [{ CI: 'true' }],
    [{ CI: '1' }],
  ])('is true with env %j', (env) => {
    expect(isAnalyticsDisabled(env as NodeJS.ProcessEnv, dir)).toBe(true);
  });

  it.each([[{ DO_NOT_TRACK: '0' }], [{ DO_NOT_TRACK: '' }], [{ CI: '' }]])(
    'stays false with env %j',
    (env) => {
      expect(isAnalyticsDisabled(env as NodeJS.ProcessEnv, dir)).toBe(false);
    }
  );

  it('is true when persistently disabled', () => {
    setTelemetryDisabled(true, dir);
    expect(isAnalyticsDisabled(cleanEnv, dir)).toBe(true);
  });
});
```

Note: if `require` inside the corrupt-file test trips ESM lint, use `import { writeFileSync } from 'node:fs'` at the top instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/telemetry/semver.test.ts tests/unit/telemetry/state.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

```javascript
// src/lib/telemetry/semver.js

/**
 * True when `latest` is a strictly newer plain semver triple than `current`.
 * Malformed or prerelease versions return false — we never nag on bad data.
 *
 * @param {string} latest
 * @param {string} current
 * @returns {boolean}
 */
export function isNewerVersion(latest, current) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}
```

```javascript
// src/lib/telemetry/state.js

/**
 * Persistent telemetry state: the random machine ID and opt-out flags.
 * Stored at ~/.vibecarbon/telemetry.json. Every function here is
 * throw-proof — telemetry must never break a command.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR = join(homedir(), '.vibecarbon');
const FILE_NAME = 'telemetry.json';

function readState(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, FILE_NAME), 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(state, stateDir) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, FILE_NAME), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Read-only home, disk full — run stateless rather than break the command.
  }
}

/**
 * Load (creating if needed) the telemetry state.
 *
 * @param {string} [stateDir]
 * @returns {{ machineId: string, disabled: boolean, noticeShown: boolean }}
 */
export function getTelemetryState(stateDir = DEFAULT_DIR) {
  const raw = readState(stateDir);
  if (raw && typeof raw.machineId === 'string' && raw.machineId.length === 36) {
    return { machineId: raw.machineId, disabled: !!raw.disabled, noticeShown: !!raw.noticeShown };
  }
  const fresh = { machineId: randomUUID(), disabled: false, noticeShown: false };
  writeState(fresh, stateDir);
  return fresh;
}

/**
 * @param {boolean} disabled
 * @param {string} [stateDir]
 */
export function setTelemetryDisabled(disabled, stateDir = DEFAULT_DIR) {
  writeState({ ...getTelemetryState(stateDir), disabled }, stateDir);
}

/** @param {string} [stateDir] */
export function markNoticeShown(stateDir = DEFAULT_DIR) {
  writeState({ ...getTelemetryState(stateDir), noticeShown: true }, stateDir);
}

/**
 * The full opt-out matrix for analytics + error reports.
 * (The update check has its own, narrower gate: CI only.)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [stateDir]
 * @returns {boolean}
 */
export function isAnalyticsDisabled(env = process.env, stateDir = DEFAULT_DIR) {
  const truthy = (v) => v !== undefined && v !== '' && v !== '0';
  if (env.VIBECARBON_TELEMETRY_DISABLED === '1') return true;
  if (truthy(env.DO_NOT_TRACK)) return true;
  if (truthy(env.CI)) return true;
  return getTelemetryState(stateDir).disabled;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/telemetry/semver.test.ts tests/unit/telemetry/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/telemetry/semver.js src/lib/telemetry/state.js tests/unit/telemetry/
git commit -m "feat(telemetry): semver compare + persistent machine-id/opt-out state"
```

---

### Task 2: Update check (cache-driven notice + async refresh)

**Files:**
- Create: `src/lib/telemetry/update-check.js`
- Test: `tests/unit/telemetry/update-check.test.ts`

**Interfaces:**
- Consumes: `isNewerVersion` from Task 1.
- Produces:
  - `getUpdateNotice(opts?: { currentVersion?: string, stateDir?: string }): string | null` — reads cache only, never fetches.
  - `refreshUpdateCache(opts?: { env?: NodeJS.ProcessEnv, stateDir?: string, fetchImpl?: typeof fetch }): Promise<void>` — resolves always; fetches only when cache is stale (>24h) and `CI` is not truthy.
  - Cache file: `<stateDir>/update-check.json` = `{ latestVersion: string, checkedAt: ISO string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/telemetry/update-check.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUpdateNotice,
  refreshUpdateCache,
} from '../../../src/lib/telemetry/update-check.js';

let dir: string;
const cachePath = () => join(dir, 'update-check.json');
const writeCache = (latestVersion: string, ageMs: number) =>
  writeFileSync(
    cachePath(),
    JSON.stringify({ latestVersion, checkedAt: new Date(Date.now() - ageMs).toISOString() })
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-update-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getUpdateNotice', () => {
  it('returns a one-line notice when the cache holds a newer version', () => {
    writeCache('0.99.0', 0);
    const notice = getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir });
    expect(notice).toContain('0.41.0');
    expect(notice).toContain('0.99.0');
    expect(notice).toContain('npm i -g vibecarbon');
  });

  it('returns null when cache is same/older version, missing, or corrupt', () => {
    expect(getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir })).toBeNull();
    writeCache('0.41.0', 0);
    expect(getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir })).toBeNull();
    writeFileSync(cachePath(), '{corrupt');
    expect(getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir })).toBeNull();
  });
});

describe('refreshUpdateCache', () => {
  const okFetch = (latest: string) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ latest }), { status: 200 }));

  it('fetches and writes the cache when stale', async () => {
    writeCache('0.41.0', 25 * 60 * 60 * 1000); // 25h old
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({ env: {}, stateDir: dir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe('https://vibecarbon.com/api/v1/cli/version');
    expect(JSON.parse(readFileSync(cachePath(), 'utf-8')).latestVersion).toBe('0.42.0');
  });

  it('does not fetch when the cache is fresh (<24h)', async () => {
    writeCache('0.41.0', 60 * 1000);
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({ env: {}, stateDir: dir, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fetch in CI', async () => {
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({ env: { CI: 'true' }, stateDir: dir, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('respects VIBECARBON_API_BASE', async () => {
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({
      env: { VIBECARBON_API_BASE: 'http://localhost:3000' },
      stateDir: dir,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/api/v1/cli/version');
  });

  it('resolves silently on network failure and non-200', async () => {
    await expect(
      refreshUpdateCache({
        env: {},
        stateDir: dir,
        fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
      })
    ).resolves.toBeUndefined();
    await expect(
      refreshUpdateCache({
        env: {},
        stateDir: dir,
        fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
      })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/telemetry/update-check.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```javascript
// src/lib/telemetry/update-check.js

/**
 * Async update check. The notice always renders from the on-disk cache
 * (zero added latency); the network refresh is fire-and-forget with a 3s
 * timeout and runs at most once per 24h. The GET carries no body, no
 * identifiers, no cookies — it is a feature, not tracking (see
 * vibecarbon.com/docs/telemetry) — so it runs regardless of analytics
 * opt-out. CI skips it entirely.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { c } from '../colors.js';
import { VERSION } from '../version.js';
import { isNewerVersion } from './semver.js';

const DEFAULT_DIR = join(homedir(), '.vibecarbon');
const FILE_NAME = 'update-check.json';
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One-line update notice from the cached check, or null.
 *
 * @param {{ currentVersion?: string, stateDir?: string }} [opts]
 * @returns {string|null}
 */
export function getUpdateNotice({ currentVersion = VERSION, stateDir = DEFAULT_DIR } = {}) {
  try {
    const cache = JSON.parse(readFileSync(join(stateDir, FILE_NAME), 'utf-8'));
    if (isNewerVersion(cache.latestVersion, currentVersion)) {
      return c.dim(
        `Update available ${currentVersion} → ${cache.latestVersion} · npm i -g vibecarbon`
      );
    }
  } catch {
    // no cache / corrupt cache — no notice
  }
  return null;
}

/**
 * Refresh the cached latest-version if stale. Never throws, never rejects.
 *
 * @param {{ env?: NodeJS.ProcessEnv, stateDir?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<void>}
 */
export async function refreshUpdateCache({
  env = process.env,
  stateDir = DEFAULT_DIR,
  fetchImpl = fetch,
} = {}) {
  try {
    if (env.CI !== undefined && env.CI !== '' && env.CI !== '0') return;
    const file = join(stateDir, FILE_NAME);
    try {
      const cache = JSON.parse(readFileSync(file, 'utf-8'));
      if (Date.now() - Date.parse(cache.checkedAt) < TTL_MS) return;
    } catch {
      // missing/corrupt cache — proceed to fetch
    }
    const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
    const res = await fetchImpl(`${base}/api/v1/cli/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const { latest } = await res.json();
    if (typeof latest !== 'string') return;
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      `${JSON.stringify({ latestVersion: latest, checkedAt: new Date().toISOString() }, null, 2)}\n`
    );
  } catch {
    // Offline, timeout, bad JSON, read-only disk — all fine, try next time.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/telemetry/update-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/telemetry/update-check.js tests/unit/telemetry/update-check.test.ts
git commit -m "feat(telemetry): cache-driven update notice with 24h async refresh"
```

---

### Task 3: Error sanitizer + fingerprint

**Files:**
- Create: `src/lib/telemetry/sanitize.js`
- Test: `tests/unit/telemetry/sanitize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sanitizeError(error: Error, opts?: { homeDir?: string, packageRoot?: string }): { error_name: string, message: string, stack: string, fingerprint: string }`. Also exports `sanitizeText(text: string, homeDir: string): string` for direct testing.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/telemetry/sanitize.test.ts
import { describe, expect, it } from 'vitest';
import { sanitizeError, sanitizeText } from '../../../src/lib/telemetry/sanitize.js';

describe('sanitizeText', () => {
  const home = '/home/alice';

  it('replaces the home directory and username with ~', () => {
    expect(sanitizeText('ENOENT: /home/alice/proj/.env.local missing', home)).toBe(
      'ENOENT: ~/proj/.env.local missing'
    );
  });

  it('redacts IPv4 and IPv6 addresses', () => {
    expect(sanitizeText('connect ETIMEDOUT 65.108.12.34:6443', home)).toBe(
      'connect ETIMEDOUT [ip]:6443'
    );
    expect(sanitizeText('listen on 2a01:4f9:c012:7c2::1 failed', home)).toBe(
      'listen on [ip] failed'
    );
  });

  it('redacts long hex/base64 runs and token= / key=-shaped substrings', () => {
    expect(sanitizeText('auth failed for token=hcloud_9aB3xY7kQ2mN8pL4', home)).toBe(
      'auth failed for token=[redacted]'
    );
    expect(
      sanitizeText('bad sig 3f8a2b6e1c4d4e5f9a7b8c9d0e1f2a3b4c5d6e7f', home)
    ).toBe('bad sig [redacted]');
    expect(sanitizeText('S3_SECRET_KEY=AbCdEfGh12345678IjKlMnOp', home)).toBe(
      'S3_SECRET_KEY=[redacted]'
    );
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeText('deploy failed: k3s not ready after 300s', home)).toBe(
      'deploy failed: k3s not ready after 300s'
    );
  });
});

describe('sanitizeError', () => {
  const opts = { homeDir: '/home/alice', packageRoot: '/home/alice/.nvm/lib/vibecarbon' };

  const makeError = () => {
    const err = new Error('boom at /home/alice/proj with 10.0.0.5');
    err.name = 'DeployError';
    err.stack = [
      'DeployError: boom at /home/alice/proj with 10.0.0.5',
      '    at deployK8s (/home/alice/.nvm/lib/vibecarbon/src/deploy.js:120:5)',
      '    at retry (/home/alice/.nvm/lib/vibecarbon/src/lib/retry.js:10:3)',
      '    at userland (/home/alice/proj/node_modules/other/index.js:1:1)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    return err;
  };

  it('produces sanitized message and package-relative, package-only frames', () => {
    const out = sanitizeError(makeError(), opts);
    expect(out.error_name).toBe('DeployError');
    expect(out.message).toBe('boom at ~/proj with [ip]');
    expect(out.stack).toBe(
      'at deployK8s (src/deploy.js:120:5)\nat retry (src/lib/retry.js:10:3)'
    );
    expect(out.stack).not.toContain('alice');
    expect(out.stack).not.toContain('node_modules');
  });

  it('caps message at 500 chars and stack at 20 frames', () => {
    const err = makeError();
    err.message = 'x'.repeat(600);
    err.stack = `DeployError: x\n${Array.from(
      { length: 30 },
      (_, i) => `    at f${i} (/home/alice/.nvm/lib/vibecarbon/src/f.js:${i}:1)`
    ).join('\n')}`;
    const out = sanitizeError(err, opts);
    expect(out.message.length).toBe(500);
    expect(out.stack.split('\n').length).toBe(20);
  });

  it('fingerprint is stable across differing line numbers but distinct per shape', () => {
    const a = sanitizeError(makeError(), opts);
    const err2 = makeError();
    err2.stack = err2.stack!.replace('120:5', '121:9'); // moved a line
    const b = sanitizeError(err2, opts);
    expect(a.fingerprint).toBe(b.fingerprint);
    const err3 = makeError();
    err3.name = 'OtherError';
    err3.stack = err3.stack!.replace('DeployError', 'OtherError');
    const c2 = sanitizeError(err3, opts);
    expect(c2.fingerprint).not.toBe(a.fingerprint);
  });

  it('never throws — even on an error with no stack', () => {
    const bare = new Error('plain');
    bare.stack = undefined;
    const out = sanitizeError(bare, opts);
    expect(out.error_name).toBe('Error');
    expect(out.stack).toBe('(no stack)');
    expect(out.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/telemetry/sanitize.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```javascript
// src/lib/telemetry/sanitize.js

/**
 * Error sanitizer for crash telemetry. The privacy contract lives here:
 * nothing identifying leaves the machine. Redaction order matters —
 * paths first (so usernames vanish), then IPs, then secret-shaped runs.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/lib/telemetry/sanitize.js -> package root is three dirs up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const MESSAGE_MAX = 500;
const FRAMES_MAX = 20;

/**
 * Redact user-identifying and secret-shaped substrings.
 *
 * @param {string} text
 * @param {string} homeDir
 * @returns {string}
 */
export function sanitizeText(text, homeDir) {
  let out = String(text);
  // 1. Home directory (and thus the username) → ~
  if (homeDir) out = out.split(homeDir).join('~');
  // 2. IP addresses → [ip]
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  out = out.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F:]{1,4}\b/g, '[ip]');
  // 3. token= / key=-shaped values (word chars after an = following token/key/secret/password)
  out = out.replace(/\b([\w-]*(?:token|key|secret|password)[\w-]*=)\S+/gi, '$1[redacted]');
  // 4. Long hex/base64-looking runs (20+ chars with at least one digit)
  out = out.replace(/\b(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{20,}\b/g, '[redacted]');
  return out;
}

/**
 * Sanitize an Error into the wire-safe crash payload fields.
 *
 * @param {Error} error
 * @param {{ homeDir?: string, packageRoot?: string }} [opts] injectable for tests
 * @returns {{ error_name: string, message: string, stack: string, fingerprint: string }}
 */
export function sanitizeError(error, { homeDir = homedir(), packageRoot = PACKAGE_ROOT } = {}) {
  try {
    const name = String(error?.name || 'Error').slice(0, 200);
    const message = sanitizeText(String(error?.message ?? ''), homeDir).slice(0, MESSAGE_MAX);

    const rawLines = String(error?.stack ?? '').split('\n');
    const frames = [];
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('at ')) continue;
      if (!trimmed.includes(packageRoot)) continue; // only our own code
      if (trimmed.includes('node_modules')) continue;
      // Rewrite absolute package paths to package-relative.
      frames.push(trimmed.split(`${packageRoot}/`).join(''));
      if (frames.length >= FRAMES_MAX) break;
    }
    const stack = frames.length > 0 ? frames.join('\n') : '(no stack)';

    // Fingerprint: name + frame identities with line:col stripped, so a
    // shifted line number still groups with the same crash.
    const normalized = frames.map((f) => f.replace(/:\d+:\d+\)?$/, ''));
    const fingerprint = createHash('sha256')
      .update(`${name}\n${normalized.join('\n')}`)
      .digest('hex')
      .slice(0, 16);

    return { error_name: name, message, stack, fingerprint };
  } catch {
    return { error_name: 'Error', message: '(sanitizer failed)', stack: '(no stack)', fingerprint: '0'.repeat(16) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/telemetry/sanitize.test.ts`
Expected: PASS. If the caps test fails on message length: remember redaction runs before the cap — `'x'.repeat(600)` contains no redactable content, so length must be exactly 500.

- [ ] **Step 5: Commit**

```bash
git add src/lib/telemetry/sanitize.js tests/unit/telemetry/sanitize.test.ts
git commit -m "feat(telemetry): error sanitizer — home/IP/secret redaction, package-only frames, stable fingerprint"
```

---

### Task 4: Payload builder + fire-and-forget senders (`index.js`)

**Files:**
- Create: `src/lib/telemetry/index.js`
- Test: `tests/unit/telemetry/index.test.ts`

**Interfaces:**
- Consumes: `getTelemetryState`, `isAnalyticsDisabled`, `markNoticeShown` (Task 1); `sanitizeError` (Task 3).
- Produces (all throw-proof; used by Task 5's cli.js wiring):
  - `recordCommandStart(command: string, opts?: Opts): void` — builds payload, fires POST `/api/v1/telemetry/events`, prints the one-time first-run notice.
  - `reportCrash(command: string, error: Error, opts?: Opts): Promise<void>` — resolves within ~2s regardless.
  - `Opts = { env?, cwd?, stateDir?, fetchImpl? }` — all injectable for tests, all defaulting to real values.
  - Payload assembly: `machine_id` from state; `project_id` from `.vibecarbon.json` `projectId` (lazily generated + saved if the file exists but lacks one); `provider`/`deploy_target` from `environments.prod` (else the first environment), keys `provider` and `deployMode`; `node_version` = `process.versions.node` major.minor; `cli_version` = `VERSION`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/telemetry/index.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCommandStart, reportCrash } from '../../../src/lib/telemetry/index.js';

let stateDir: string;
let cwd: string;
const fetchImpl = vi.fn();

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'vc-t-state-'));
  cwd = mkdtempSync(join(tmpdir(), 'vc-t-proj-'));
  fetchImpl.mockReset();
  fetchImpl.mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const manifest = {
  version: '1',
  projectName: 'secret-name',
  services: {},
  environments: { prod: { provider: 'hetzner', region: 'ash', deployMode: 'k8s-ha' } },
};

const opts = () => ({ env: {} as NodeJS.ProcessEnv, cwd, stateDir, fetchImpl });

describe('recordCommandStart', () => {
  it('POSTs the exact event payload — and nothing more', async () => {
    writeFileSync(join(cwd, '.vibecarbon.json'), JSON.stringify(manifest));
    recordCommandStart('deploy', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://vibecarbon.com/api/v1/telemetry/events');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual([
      'arch', 'cli_version', 'command', 'deploy_target', 'machine_id',
      'node_version', 'platform', 'project_id', 'provider',
    ]);
    expect(body.command).toBe('deploy');
    expect(body.provider).toBe('hetzner');
    expect(body.deploy_target).toBe('k8s-ha');
    expect(body.node_version).toMatch(/^\d+\.\d+$/);
    expect(init.body).not.toContain('secret-name'); // project name never leaves
  });

  it('lazily writes a projectId into .vibecarbon.json and reuses it', async () => {
    writeFileSync(join(cwd, '.vibecarbon.json'), JSON.stringify(manifest));
    recordCommandStart('status', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(readFileSync(join(cwd, '.vibecarbon.json'), 'utf-8'));
    expect(saved.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).project_id).toBe(saved.projectId);
  });

  it('sends null project fields outside a project', async () => {
    recordCommandStart('create', opts());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.project_id).toBeNull();
    expect(body.provider).toBeNull();
    expect(body.deploy_target).toBeNull();
  });

  it('sends nothing when analytics is disabled', async () => {
    recordCommandStart('deploy', { ...opts(), env: { DO_NOT_TRACK: '1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is silent when fetch rejects', async () => {
    fetchImpl.mockRejectedValue(new Error('offline'));
    expect(() => recordCommandStart('deploy', opts())).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('reportCrash', () => {
  it('POSTs a sanitized error payload to /errors', async () => {
    await reportCrash('deploy', new Error('boom'), opts());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://vibecarbon.com/api/v1/telemetry/errors');
    const body = JSON.parse(init.body);
    expect(body.error_name).toBe('Error');
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('resolves even when fetch hangs (2s cap)', async () => {
    fetchImpl.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    await reportCrash('deploy', new Error('boom'), opts());
    expect(Date.now() - start).toBeLessThan(2500);
  }, 4000);

  it('does nothing when analytics is disabled', async () => {
    await reportCrash('deploy', new Error('boom'), { ...opts(), env: { CI: '1' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/telemetry/index.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```javascript
// src/lib/telemetry/index.js

/**
 * Telemetry orchestrator: payload assembly + fire-and-forget senders.
 * Public functions never throw and never block the command (reportCrash
 * waits at most ~2s — the process is exiting anyway).
 * Wire contract: vibecarbon-web /api/v1/telemetry/{events,errors}.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { c } from '../colors.js';
import { loadManifest, saveManifest } from '../project.js';
import { VERSION } from '../version.js';
import { sanitizeError } from './sanitize.js';
import { getTelemetryState, isAnalyticsDisabled, markNoticeShown } from './state.js';

function apiBase(env) {
  return env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
}

/**
 * Project context from .vibecarbon.json: id (lazily created), provider,
 * deploy target. All null outside a project.
 */
function projectContext(cwd) {
  try {
    if (!existsSync(join(cwd, '.vibecarbon.json'))) {
      return { project_id: null, provider: null, deploy_target: null };
    }
    const manifest = loadManifest(cwd);
    if (!manifest.projectId) {
      manifest.projectId = randomUUID();
      saveManifest(manifest, cwd);
    }
    const envs = manifest.environments || {};
    const envCfg = envs.prod || envs[Object.keys(envs)[0]] || {};
    return {
      project_id: manifest.projectId,
      provider: envCfg.provider || null,
      deploy_target: envCfg.deployMode || null,
    };
  } catch {
    return { project_id: null, provider: null, deploy_target: null };
  }
}

function buildPayload(command, { cwd, stateDir }) {
  const [major, minor] = process.versions.node.split('.');
  return {
    machine_id: getTelemetryState(stateDir).machineId,
    ...projectContext(cwd),
    command,
    cli_version: VERSION,
    node_version: `${major}.${minor}`,
    platform: process.platform,
    arch: process.arch,
  };
}

function post(path, payload, { env, fetchImpl }) {
  return fetchImpl(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  });
}

/**
 * Fire the usage event for a command run. Synchronous facade; the POST
 * happens in the background and all failures vanish.
 *
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stateDir?: string, fetchImpl?: typeof fetch }} [opts]
 */
export function recordCommandStart(
  command,
  { env = process.env, cwd = process.cwd(), stateDir = undefined, fetchImpl = fetch } = {}
) {
  try {
    if (isAnalyticsDisabled(env, stateDir)) return;
    maybeShowFirstRunNotice(stateDir);
    const payload = buildPayload(command, { cwd, stateDir });
    post('/api/v1/telemetry/events', payload, { env, fetchImpl }).catch(() => {});
  } catch {
    // never break the command
  }
}

/**
 * Report a crash, waiting at most ~2s. Never rejects.
 *
 * @param {string} command
 * @param {Error} error
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stateDir?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<void>}
 */
export async function reportCrash(
  command,
  error,
  { env = process.env, cwd = process.cwd(), stateDir = undefined, fetchImpl = fetch } = {}
) {
  try {
    if (isAnalyticsDisabled(env, stateDir)) return;
    const payload = { ...buildPayload(command, { cwd, stateDir }), ...sanitizeError(error) };
    await Promise.race([
      post('/api/v1/telemetry/errors', payload, { env, fetchImpl }).catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch {
    // never break the exit path
  }
}

/** One-time disclosure notice, printed to stderr so it never pollutes -json output. */
function maybeShowFirstRunNotice(stateDir) {
  const state = getTelemetryState(stateDir);
  if (state.noticeShown || !process.stderr.isTTY) return;
  markNoticeShown(stateDir);
  console.error(
    c.dim(
      [
        '',
        'vibecarbon collects anonymous usage data (command names + versions,',
        'never arguments, paths, or personal data) to improve the CLI.',
        'Details: https://vibecarbon.com/docs/telemetry',
        'Opt out: vibecarbon telemetry off   (or export DO_NOT_TRACK=1)',
        '',
      ].join('\n')
    )
  );
}
```

Note on `stateDir = undefined`: passing `undefined` through to Task 1's functions lets their own `DEFAULT_DIR` default apply — do not re-derive the default here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/telemetry/index.test.ts`
Expected: PASS. (First-run notice does not fire in tests: vitest's stderr is not a TTY.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/telemetry/index.js tests/unit/telemetry/index.test.ts
git commit -m "feat(telemetry): payload builder + fire-and-forget event/crash senders with first-run notice"
```

---

### Task 5: `telemetry` subcommand + cli.js wiring

**Files:**
- Create: `src/telemetry.js`
- Modify: `src/cli.js` — `KNOWN_COMMANDS`, help text, dispatch switch, crash wrap
- Modify: `src/create.js:1429` area — add `projectId: randomUUID()` to the manifest object passed to `saveManifest`
- Test: `tests/unit/telemetry/command.test.ts`; existing `tests/unit/cli/routing.test.ts` will need the new command added

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `vibecarbon telemetry [on|off|status]`; universal wiring for all commands.

- [ ] **Step 1: Write the failing test for the subcommand**

```typescript
// tests/unit/telemetry/command.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../../src/telemetry.js';
import { getTelemetryState } from '../../../src/lib/telemetry/state.js';

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-tcmd-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => {
    logs.push(a.join(' '));
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('vibecarbon telemetry', () => {
  it('off persists disabled=true; on re-enables', async () => {
    await run(['off'], { stateDir: dir });
    expect(getTelemetryState(dir).disabled).toBe(true);
    await run(['on'], { stateDir: dir });
    expect(getTelemetryState(dir).disabled).toBe(false);
  });

  it('status reports the effective state and the reason', async () => {
    await run(['status'], { stateDir: dir, env: {} as NodeJS.ProcessEnv });
    expect(logs.join('\n')).toMatch(/enabled/i);
    logs = [];
    await run(['status'], { stateDir: dir, env: { DO_NOT_TRACK: '1' } });
    expect(logs.join('\n')).toMatch(/disabled/i);
    expect(logs.join('\n')).toMatch(/DO_NOT_TRACK/);
  });

  it('bare `telemetry` behaves like status', async () => {
    await run([], { stateDir: dir, env: {} as NodeJS.ProcessEnv });
    expect(logs.join('\n')).toMatch(/enabled/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/telemetry/command.test.ts`
Expected: FAIL — `src/telemetry.js` does not exist.

- [ ] **Step 3: Implement the subcommand**

```javascript
// src/telemetry.js

/**
 * `vibecarbon telemetry [on|off|status]` — control anonymous usage analytics.
 * The update check is not affected (it carries no data); see
 * https://vibecarbon.com/docs/telemetry
 */

import { c } from './lib/colors.js';
import {
  getTelemetryState,
  isAnalyticsDisabled,
  setTelemetryDisabled,
} from './lib/telemetry/state.js';

/**
 * @param {string[]} args
 * @param {{ stateDir?: string, env?: NodeJS.ProcessEnv }} [opts] injectable for tests
 */
export async function run(args, { stateDir = undefined, env = process.env } = {}) {
  const sub = args[0] || 'status';

  if (sub === 'off') {
    setTelemetryDisabled(true, stateDir);
    console.log(`${c.success('✓')} Telemetry disabled. The version update check (no data sent) still runs.`);
    return;
  }
  if (sub === 'on') {
    setTelemetryDisabled(false, stateDir);
    console.log(`${c.success('✓')} Telemetry enabled. Details: https://vibecarbon.com/docs/telemetry`);
    return;
  }
  if (sub === 'status' ) {
    const disabled = isAnalyticsDisabled(env, stateDir);
    console.log(`Telemetry is ${disabled ? c.warn('disabled') : c.success('enabled')}.`);
    if (disabled) {
      const state = getTelemetryState(stateDir);
      if (env.VIBECARBON_TELEMETRY_DISABLED === '1') console.log(c.dim('  reason: VIBECARBON_TELEMETRY_DISABLED=1'));
      else if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== '0') console.log(c.dim('  reason: DO_NOT_TRACK is set'));
      else if (env.CI && env.CI !== '0') console.log(c.dim('  reason: CI environment'));
      else if (state.disabled) console.log(c.dim('  reason: disabled via `vibecarbon telemetry off`'));
    }
    console.log(c.dim('  what is collected: https://vibecarbon.com/docs/telemetry'));
    return;
  }
  console.error(`Unknown subcommand '${sub}'. Usage: vibecarbon telemetry [on|off|status]`);
  process.exit(1);
}
```

Check `src/lib/colors.js` for the actual helper names (`c.success` / `c.warn` etc.) and use what exists — if there is no `c.warn`, use the closest equivalent (`c.error` or `c.dim`).

- [ ] **Step 4: Wire cli.js**

In `src/cli.js`:

1. Add `'telemetry'` to `KNOWN_COMMANDS` (keep list order style — append at the end near `'access'`).
2. Add a help line under DEV COMMANDS in `showHelp()`:
   `${c.info('telemetry')} [on|off]       Control anonymous usage analytics (status by default)`
3. Add static imports at the top: `import { recordCommandStart, reportCrash } from './lib/telemetry/index.js';` and `import { getUpdateNotice, refreshUpdateCache } from './lib/telemetry/update-check.js';`
4. Add a dispatch case, matching the existing dynamic-import pattern:

```javascript
    case 'telemetry': {
      const telemetryModule = await import('./telemetry.js');
      await telemetryModule.run(subcommandArgs);
      break;
    }
```

5. Immediately before the `switch (command)` line (after the `commandTimer` line), start telemetry — both calls are fire-and-forget and safe pre-dispatch:

```javascript
  // Anonymous usage event + async update-check refresh. Both are
  // fire-and-forget, throw-proof, and disabled in CI — see
  // src/lib/telemetry/ and https://vibecarbon.com/docs/telemetry
  if (command !== 'telemetry') recordCommandStart(command);
  refreshUpdateCache();
```

6. Wrap the `switch` in try/catch/finally for crash reporting and the update notice. The existing structure ends the switch and then (find the exact tail of `main()`) stops the perf timer. Restructure to:

```javascript
  try {
    switch (command) {
      // ... existing cases, unchanged ...
    }
  } catch (error) {
    await reportCrash(command, error);
    throw error; // preserve today's failure behavior exactly
  } finally {
    const notice = getUpdateNotice();
    if (notice && process.stdout.isTTY) console.log(`\n${notice}`);
    commandTimer.end?.() ?? commandTimer();
  }
```

**Important:** open the current tail of `main()` first and preserve its exact behavior — the perf timer call shape (`commandTimer(...)` vs `.end()`), the unknown-command branch, and any `process.exit` calls. The only additions are the try/catch/finally, the two telemetry lines, and the notice print. Commands that call `process.exit()` themselves will skip the notice — that is acceptable and expected.

7. In `src/create.js`, find the `saveManifest(` call around line 1429 and add `projectId: randomUUID()` to the manifest object literal (import `randomUUID` from `node:crypto` if not already imported).

- [ ] **Step 5: Update the routing test and run everything**

Add `'telemetry'` wherever `tests/unit/cli/routing.test.ts` enumerates commands (it asserts `KNOWN_COMMANDS` coverage; also check `tests/unit/licensing/command-gates.test.ts` — `COMMAND_GATES` must classify every command, so add `telemetry: 'free'` (or the file's equivalent shape) to `COMMAND_GATES` in `src/lib/licensing/gate.js`).

Run: `pnpm exec vitest run tests/unit/telemetry/ tests/unit/cli/ tests/unit/licensing/`
Expected: PASS.

- [ ] **Step 6: Integration check — telemetry failure changes nothing**

Run: `VIBECARBON_API_BASE=http://127.0.0.1:1 node src/cli.js -v && echo "exit ok"`
Expected: prints `vibecarbon v0.41.0` (or current) then `exit ok`, instantly — an unreachable telemetry host must not slow down or fail the CLI.

Then: `VIBECARBON_API_BASE=http://127.0.0.1:1 node src/cli.js telemetry status`
Expected: prints status, exit 0.

- [ ] **Step 7: Run the full unit suite**

Run: `pnpm exec vitest run --project unit`
Expected: PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add src/telemetry.js src/cli.js src/create.js src/lib/licensing/gate.js tests/unit/telemetry/command.test.ts tests/unit/cli/routing.test.ts tests/unit/licensing/
git commit -m "feat(telemetry): telemetry subcommand + universal cli wiring (events, crash reports, update notice)"
```

---

### Task 6: README disclosure section

**Files:**
- Modify: `README.md` (add a `## Telemetry` section near the end, before any license/contributing section)

- [ ] **Step 1: Add the section**

```markdown
## Telemetry

vibecarbon collects a small amount of **anonymous** usage data (command names,
CLI/Node versions, platform, provider — never arguments, paths, hostnames, or
personal data) plus sanitized crash reports, to guide development. Every field
is documented at [vibecarbon.com/docs/telemetry](https://vibecarbon.com/docs/telemetry).

Opt out any time:

```bash
vibecarbon telemetry off     # persistent
export DO_NOT_TRACK=1        # industry standard
```

CI environments are excluded automatically. Separately, the CLI checks
vibecarbon.com once a day for a newer version; that request contains no
identifying information at all.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(telemetry): README disclosure section"
```

---

### Task 7: Security review

- [ ] **Step 1: Dispatch the security-reviewer agent** over the full diff. Focus areas: sanitizer bypasses (secret shapes that survive redaction), anything identifying in payloads, the crash path preserving exit behavior, and no telemetry on the `telemetry` command's own opt-out flow before it applies.
- [ ] **Step 2: Apply confirmed fixes; re-run** `pnpm exec vitest run --project unit`.
- [ ] **Step 3: Commit** with `fix(telemetry): security review findings`.

---

## Self-Review (completed)

- **Spec coverage:** update check (Task 2 + wiring in 5), events (Tasks 4–5), crash reports (Tasks 3–5), state/kill switches (Task 1), subcommand (Task 5), first-run notice (Task 4), create-time projectId (Task 5), README (Task 6), security review (Task 7). Server half is the companion plan in vibecarbon-web.
- **Placeholder scan:** clean — all code inline; the two "check the actual name" notes (colors helpers, perf-timer tail) are verification instructions against real files, with fallbacks stated.
- **Type consistency:** payload keys match the server plan's zod schema exactly (9 event fields + 4 error fields); `stateDir`/`env`/`fetchImpl` injection points are consistent across Tasks 1–5.
