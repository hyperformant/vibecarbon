# k8s-ha db volume churn: in-place standby reseed (A) and a live wal-g role (B), Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Each task is test-first: write the failing test, run it red, implement, run it green, then run the task gate (`pnpm lint && pnpm test:unit`) and commit with pathspecs (`git commit -- <files>`). The tree must build and pass the gate after EVERY task: nothing is deleted while a later task still uses it.

All file:line references are against `main` at 43e04ef (includes #299 and #282), the base of branch `feat/k8s-ha-churn-redesign` (worktree `.claude/worktrees/cli-links`). Revision 2 applies the pre-flight scan (`.superpowers/sdd/2026-11-02-k8s-ha-churn-redesign/progress.md`, "## Pre-flight scan") and the controller rulings on top of it. The task map at the end of this header lists how revision 1's task ids moved.

**Goal:** remove the two remaining same-node detach and re-attach cycles of a db volume on k8s-ha, the trigger of the `do-csi-stale-volumeattachment` class (docs/mitigations.yml:288, its one site at 317-324):

- **A.** The standby reseed (cold deploy, failover, restore) goes through four attach transitions: scale to 0, helper pod attach, helper delete, scale to 1 (`src/lib/deploy/k8s/ha/index.js:825-1135`, `src/lib/deploy/replication.js:1325-1717`). After this plan it goes through none: postgres stops, the kubelet restarts the container in the same pod, and a wrapper swaps the staged tree in before postgres starts.
- **B.** Failover moves the wal-g write-guard with `kubectl set env WALG_ROLE=primary`, which recreates the promoted db pod (`src/failover.js:1915-1981`, `src/lib/deploy/walg-role.js:246-255`). Compose does the same with a `.env` merge plus a db recreate (`src/lib/deploy/compose/ha.js:1295-1364`). After this plan the role is a one-word file outside PGDATA. A failover changes it with one exec or SSH write, and no pod or container restarts.

**Architecture:**

- **B, live wal-g role (built first; A's wrapper reads B's intent).**
  - The role file is `/var/lib/vibecarbon/role/walg-role`, holding `primary` or `standby`, on a volume that is never PGDATA, so `pg_basebackup` never copies it.
    - k8s: a `subPath: vibecarbon-role` mount of the same db PVC, a sibling of `postgres-data`.
    - compose: a bind of the host directory `/opt/<project>/.vibecarbon-role`, read-only into the container, from `docker-compose.prod.yml`.
  - One parser: `WALG_ROLE_PARSE_SH` in `src/lib/deploy/walg-role.js` is the only text that turns the file into `VC_WALG_ROLE` (`primary`, `standby` or empty).
    - `walg-env.sh`, which every wal-g caller in the container already sources, carries it verbatim; a parity test pins that.
    - The host and e2e readers (`tls-snapshot.sh`, the generated `standby-scale.sh` and `addon-services.sh`, the e2e checks) get it through `walgRoleReadFragment(path)` or `walgRoleReadShell(dir)`, rendered from the same constant. `tls-snapshot.sh` is a template file, so it carries the fragment verbatim and the parity test pins that too.
  - A missing or unparseable file is fail-safe. `wal-archive.sh` exits 1, so postgres keeps the segment and retries it. The backup scripts exit 1 with no result marker, and the audit fails.
  - Writers go through `walg-role.js` and write atomically (temp file, `mv -f` in the same directory, `sync`). The one other writer is `db-guard.sh`'s intent apply, with the same three steps.
  - k8s also keeps a durable intent in a CLI-owned ConfigMap `vibecarbon-db-role`, injected as `VC_WALG_ROLE_INTENT` (an optional `configMapKeyRef`). `db-guard.sh` applies it on every container start, so a db pod the CLI could not reach (scaled to 0, crash-looping, down) comes back with the right role. The intent is created and changed with `kubectl apply` of one manifest, so a cluster that predates this release gets it created, never a failed patch.
- **A, in-place reseed.**
  - `carbon/volumes/db/db-guard.sh` already wraps the compose db entrypoint (carbon/docker-compose.yml:186). It becomes the k8s db container's command too (Task B3), shipped as a third key of the `vibecarbon-wal-archive` ConfigMap, byte-identical and parity-tested like `wal-archive.sh` and `walg-env.sh`.
  - On every container start, before `exec db-entrypoint.sh`, it keeps the existing refusal over an interrupted restore, applies the k8s role intent (B3), and runs a crash-safe, marker-driven swap of a staged reseed tree (A1). It swaps only when the intent is `standby` and the attempt ids match.
  - The CLI checks that the RUNNING standby pod runs the wrapper and that the cluster's intent is `standby`, stages a verified `pg_basebackup` into `$PGDATA/.vc-reseed`, writes `$PGDATA/.vc-reseed-ready` last, sends SIGINT to PID 1 (the postmaster), waits for the same pod uid with a higher `restartCount` and Ready, then checks `$PGDATA/.vc-reseeded-from`.
  - The volume never detaches. The helper pod, `waitForPvDetach`, `deleteStaleDbVolumeAttachments` and the stale-attachment repair are deleted, each in the task that removes its last caller.
- **One roll for existing clusters (D6).** A and B change the same pod template: the command, the `db-guard.sh` mount, the role mount, the intent env, and dropping the `WALG_ROLE` env. They ship in one release, so every existing k8s cluster restarts its db once, under `watchDbAttach` (`replication.js:826`). Intermediate commits are not shippable on their own; the gate keeps each one green.

**Tech Stack:** Node ESM CLI, vitest (unit tier), bash and POSIX sh scripts run under `spawnSync` in unit tests, kubectl/kustomize (`k8s-db-statefulset.test.ts` already shells out to `kubectl kustomize`), real-infra e2e (`pnpm test:e2e:batch`).

**Task map (revision 1 → revision 2, execution order):**

| rev 2 | content | from rev 1 | scan rulings applied |
| --- | --- | --- | --- |
| 0 | gate: symbols on main | 0 | R10 |
| B1 | the one role parser | B1 | R1, R6, C6 |
| B2 | role primitives | B4 | C18, C6 |
| B3 | k8s template, db-guard entrypoint with intent, deploy intent and live write | B5 + intent half of A1 | R5, C12, C18, R6 |
| B4 | compose template and every compose writer (deploy, scale) | writer half of B6, B8's scale writes | C10, R8, C15 |
| B5 | every reader switches to the role file; the `WALG_ROLE` env is dropped | B2, B3, D4 half of B6, tls half of B8 | C6, C7, C8 |
| B6 | k8s role movers: failover, abort, retired fence; rollout-wait move | k8s half of B7 | C14, C18, C15 |
| B7 | compose role movers; retire `composeRoleEnv`, `composeDbRecreateShell` | compose half of B7, B8 cutover | C3, C4, C15 |
| B8 | e2e role checks | B9 | C7, C9, R9 |
| B9 | template lockstep preflight | B10 | |
| A1 | db-guard reseed swap | swap half of A1 | C16, R6 |
| C1 | role census | B11 | C5, C6 |
| A2 | in-place stage script | A2 | C1, R4, C15 |
| A3 | live-pod guard, in-place restart, quoting | A3 | C13, R2 |
| A4 | `reseedStandbyInPlace`; failover and restore migrate and preflight | A4 | C2, C11, C14, C15, C17 |
| A5 | cold deploy migrates; helper-pod code deleted | A5 | C2, C13, C15, R12 |
| A6 | census, mitigations, docs | A6 | R3 |
| A7 | e2e zero-transition checks | A7 | C9, R7 |
| X1, X2 | one roll; Compatibility note | X1, X2 | C11, C18 |

## Global Constraints

- **Never stop postgres in-pod unless the live pod provably runs the wrapper.** `pg_ctl stop` stays banned everywhere: `tests/unit/deploy/k8s-ha-repl-gateway.test.ts` keeps pinning it (the case rewritten in A5). The single sanctioned in-pod stop is `kill -INT 1` inside `restartDbContainerInPlace`, behind `assertLiveDbGuardSupportsReseed`, and a census enforces that pairing and the single caller (Task A6).
- **No retry ladders** (AGENTS.md:108-135, mitigation census R7). An `archive_command` that exits 1 is postgres' own retain-and-retry contract, not a ladder. Every wait added here is a single bounded wait on a state transition, with no retry.
- **Fail-safe role semantics (D2, D8).** Only the literal word `primary` arms archiving or base backups. `standby` is an explicit skip (exit 0, as today). Anything else (missing, empty, garbage, a symlink) means never archive and never silently drop: exit 1, and the segment is held.
- **One parser, one writer module.** The role word is parsed only by `WALG_ROLE_PARSE_SH` (walg-role.js), which `walg-env.sh` (both copies) and `tls-snapshot.sh` carry verbatim and every generated host script and e2e reader renders from walg-role.js. No other file parses the role file. Role writes are spelled only in walg-role.js and in `db-guard.sh` (both copies). Task C1's census enforces both.
- **Remote commands survive ssh.** Any kubectl argv sent through ssh is built with `shEscape` per token (src/lib/shell.js:17, the same scheme as `sshArgv`, src/lib/ssh.js:286-296), never with a bare `join(' ')`. A test runs the exact remote string through `sh -c` and checks the argv (Task A3, A5).
- **Template and CLI move together.** Scripts under `carbon/` that ship two ways stay byte-identical: the compose bind mounts and their ConfigMap copies (`walg-archive-script-parity.test.ts`). No reader falls back to the `WALG_ROLE` env. A deploy refuses a project whose scaffold predates the role file (Task B9), and says to run `vibecarbon upgrade`.
- **vibecarbon-web stays on the old CLI** (`npx vibecarbon@0.49.0`) and keeps its own template copy. This plan adds no compat code for it: no env fallback and no dual read.
- **No v1.0.** Commits carry no `!:` and no `BREAKING CHANGE`. The PR body carries a Compatibility note (Task X2).
- **Shared checkout.** Commit with pathspecs and check the staged diff first.
- **Test helpers.** Every stub helper this plan names (`runFailoverK8s`, `inPlaceExec`, ...) is NEW and built in its own task, inside the test file, around the real exported function. Reviewers check that a stub drives the real code path and never re-implements it (R11).

## Review Focus (the five most likely failure modes)

1. **Stale or copied reseed markers swap the wrong tree.**
   - `pg_basebackup` copies everything in the source PGDATA. After a failback, the new primary holds `.vc-*` files from its time as a standby.
   - A reseed interrupted between stage and SIGINT leaves `.vc-reseed-ready` plus `.vc-reseed/`. A restore swap skips `.vc-*` entries (`vc_cluster_entries`), and a promotion does not touch them, so they survive onto a primary.
   - Guards:
     - the stage script strips every `.vc-*` from staging (A2);
     - the wrapper swaps only when the intent is `standby` AND the ready marker's attempt id equals `$STAGE/.vc-reseed-id` (A1); anything else refuses and clears the staging;
     - D2 writes the `primary` intent before `pg_promote`, which disarms any pending swap on the next start;
     - both restore swaps remove `.vc-reseed*` before they swap (A1), and drop `.vc-*` from a staged base by glob (A2).
   - Reviewers should walk the crash points of the swap: before the `out` mark, mid `out`, mid `in`, after `in` but before cleanup, and the two stale-marker cases (C16). Each has a test.
2. **A stop on a container that will not swap.**
   - This reintroduces the RCA'd failure: the standby restarts as an independent primary.
   - The guard reads the RUNNING pod: its spec `command`, plus a grep of the protocol marker in the mounted `/usr/local/bin/db-guard.sh`. A subPath ConfigMap mount never changes for the life of the pod, so it is the exact file the next container start runs. It also reads the intent ConfigMap: a non-`standby` intent would make the wrapper refuse the swap.
   - Reading the StatefulSet template instead is a false positive during a pending roll.
3. **WAL dropped, or a second writer, at a role transition.**
   - The promoted node gets `primary` before `pg_promote` (D2). Today's promote-then-roll order very likely drops the promotion's `.history` and `.partial` files on both tiers: the promoted node reads `standby` and `wal-archive.sh:63-66` exits 0 until the roll. B6 and B7 pin the order; B8 adds an archive check.
   - On a cluster that predates the release, the old pod has no role mount, so an exec write lands in the container overlay and reads back as a false success. `setK8sWalgRole` checks the pod spec for the mount first, and the failover refuses before any change (C18).
   - The missing-file branch must sit after the no-target skip, so local dev with no bucket never holds WAL.
4. **Real kubelet restart semantics.**
   - Restart backoff: exit 0 still counts as a restart, and a recent restart can push it into CrashLoopBackOff, up to 300 s.
   - Env from a ConfigMap key is resolved when each container is created, so a kubelet restart picks up a changed intent. The e2e proves this; unit tests cannot.
   - A pod that gets recreated instead of restarted must degrade into the `watchDbAttach`-wrapped rollout wait, not a timeout.
5. **Template drift, a missed writer, or a mangled remote command.**
   - A compose project that was not upgraded still has the env-based scripts.
   - A deploy or scale path that starts a stack without writing the role leaves archiving held: loud, but a backup stall. The compose-ha standby replacement in `scale` is the path revision 1 missed (C10).
   - A remote `sh -c '...'` joined without quoting is word-split by the remote shell; unit stubs never see it (C13).
   - Guards: the parity tests, the lockstep preflight (B9), the writer census (C1), and the `sh -c` argv tests (A3, A5).

## Decisions (each with a recommendation; the ones the user must confirm are marked USER)

- **D1 (USER, CONFIRMED 2026-11-02: refuse with a fix): a failover or restore reseed on a cluster that has not been redeployed since this release.**
  - Refuse before anything changes, with one line: "this cluster's db predates in-place reseeds; run `vibecarbon deploy <env>` once (one db restart), then retry".
  - "Before anything changes" is enforced by preflights, not by the reseed itself: failover checks at STEP 1 (`src/failover.js:2149`), before the replica proof, provisioning or quiesce; restore checks right after its free-space check (`src/restore.js:1056`), before `setRestoreMarker` touches the primary (C11). Task A4.
  - The helper-pod fallback is not kept.
- **D2 (USER, CONFIRMED 2026-11-02: before promotion): when the promoted node becomes `primary`, and what `standby` means.**
  - Write `primary` (intent plus file) on the standby BEFORE `pg_promote`, while it is still in recovery, where `archive_mode=on` never calls `archive_command`, so the write is inert.
  - Explicit `standby` stays exit 0; missing or unknown exits 1.
  - If the role write fails before the promote, the failover aborts before promotion.
- **D3: the role value carries no stamp keyed by system identifier or timeline. A plain word.**
  - Lineage folders (`walg-env.sh:33-60`) already send a re-initdb'd bring-up standby into its own `<base>/<sysid>` folder; the prefix fence (`wal-archive.sh:127-160`, `backup-fence.js`) already refuses an older timeline of the same sysid.
  - A stamp in PGDATA would be copied by `pg_basebackup`; one outside PGDATA adds a writer at every timeline change for no new protection.
- **D4 (USER, CONFIRMED 2026-11-02: one role file): the compose node role for add-on scaling.** `standby-scale.sh` (`bundle.js:70-85`) and `addon-services.sh` (`addon-start.js:242-253`) read the role through the shared fragment, and nothing writes `WALG_ROLE` into `.env` any more. An existing `.env` line is inert.
- **D5: the k8s intent lives in a ConfigMap `vibecarbon-db-role`**, applied by the CLI in `applyVibecarbonSecrets` (k3s.js:1886) before `apply -k`, and by the failover with the same manifest. Not in `k8s/base`, so Flux never sees it. Not in `vibecarbon-infra-secrets`, whose resourceVersion the app template tracks (`APP_SECRETS_SHA_ANNOTATION`).
- **D6 (USER, CONFIRMED 2026-11-02: one release): ship A and B in one release.**
- **D7: compose role location.** `/opt/<project>/.vibecarbon-role/` bound as a DIRECTORY at `/var/lib/vibecarbon/role:ro,Z` in `docker-compose.prod.yml` (servers only). A single-file bind would pin the old inode across the atomic rename. Precedent: `.vibecarbon-retired` already lives in the project dir (`tls-snapshot.sh:50`).
- **D8: a missing role under disk pressure still never drops a segment**, the same as the retired-node refusal (`wal-archive.sh:51-54`).
- **D9: the reseed's old tree goes to `.vc-discard`, never `.vc-prev`.** The CLI removes `.vc-discard` once the standby is proven in recovery; any later swap or restore removes it as garbage first.

---

## Task 0: Base gate

**Files:** none.

- [ ] Confirm the attach-churn fix (#299, squash-merged as 43e04ef) is on the branch by its symbols, not by commit ancestry:

```bash
git grep -n "export async function watchDbAttach" -- src/lib/deploy/replication.js
git grep -n "export function k8sDbRolloutWait" -- src/lib/deploy/walg-role.js
git grep -n "export async function checkPrimaryDbCreatedOnce" -- tests/e2e/checks/ha-integrity.ts
```

Each must print one line. If any prints nothing, stop and report.
- [ ] Work on the current branch `feat/k8s-ha-churn-redesign`. Do not create another.

---

## Part B: the live wal-g role

### Task B1: the one role parser, carried by `walg-env.sh`

**Files:**
- Modify `src/lib/deploy/walg-role.js` (add `WALG_ROLE_PARSE_SH`, `WALG_ROLE_DIR`, `WALG_ROLE_FILE`, `walgRoleReadFragment`)
- Modify `carbon/volumes/db/walg-env.sh` (insert before line 33)
- Modify `carbon/k8s/base/backup/configmap-walg.yaml` (the `walg-env.sh` key at 255, byte-identical)
- Test `tests/unit/deploy/walg-archive-script-parity.test.ts` (new describe after the `walg-env.sh exports the lineage folder` block at 262)

**Interfaces:**

```js
/** In-container path, both tiers. */
export const WALG_ROLE_DIR = '/var/lib/vibecarbon/role';
export const WALG_ROLE_FILE = `${WALG_ROLE_DIR}/walg-role`;
/**
 * THE role parser (POSIX sh). Reads "$vc_walg_role_file"; sets VC_WALG_ROLE to
 * primary, standby or "". Never exits. Carried verbatim by walg-env.sh (both
 * copies) and tls-snapshot.sh; rendered by walgRoleReadFragment everywhere else.
 */
export const WALG_ROLE_PARSE_SH = [
  'VC_WALG_ROLE=""',
  'if [ -f "$vc_walg_role_file" ] && [ ! -L "$vc_walg_role_file" ]; then',
  '    case "$(cat "$vc_walg_role_file" 2>/dev/null)" in',
  '        primary) VC_WALG_ROLE=primary ;;',
  '        standby) VC_WALG_ROLE=standby ;;',
  '    esac',
  'fi',
].join('\n');
/** `vc_walg_role_file=<path>` + the parser + `unset vc_walg_role_file`. */
export function walgRoleReadFragment(path) {}
```

Shell contract after sourcing `walg-env.sh`: `VC_WALG_ROLE` is exported. `VC_WALG_ROLE_FILE` overrides the path, for script tests only. Sourcing never exits because of the role.

- [ ] Write the failing tests:

```ts
import { walgRoleReadFragment, WALG_ROLE_PARSE_SH } from '../../../src/lib/deploy/walg-role.js';

describe('the wal-g role parser (one text, carried by walg-env.sh)', () => {
  const bin = controldataBin('role');
  const roleDir = join(work, 'role');
  mkdirSync(roleDir, { recursive: true });
  const put = (content: string | null, { symlink = false } = {}) => {
    const f = join(roleDir, 'walg-role');
    rmSync(f, { force: true });
    if (content === null) return f;
    if (symlink) {
      writeFileSync(join(roleDir, 'target'), content);
      symlinkSync(join(roleDir, 'target'), f);
    } else writeFileSync(f, content);
    return f;
  };
  const viaEnv = (f: string) => {
    const r = spawnSync('sh', ['-c', `. "${repoRoot}${WALG_ENV_SCRIPT}" && printf 'R=[%s]' "$VC_WALG_ROLE"`], {
      encoding: 'utf-8',
      env: { PATH: `${bin}:${process.env.PATH}`, WALG_S3_PREFIX_BASE: 's3://b/backups/p/prod/walg', PGDATA: '/x', VC_WALG_ROLE_FILE: f },
    });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  const viaFragment = (f: string) =>
    spawnSync('sh', ['-c', `${walgRoleReadFragment(f)}\nprintf 'R=[%s]' "$VC_WALG_ROLE"`], { encoding: 'utf-8' }).stdout.trim();

  it.each([
    ['primary\n', 'R=[primary]'],
    ['standby', 'R=[standby]'],
    ['', 'R=[]'],
    ['Primary\n', 'R=[]'],
    ['primary\nstandby\n', 'R=[]'],
  ])('%j reads as %s, through walg-env.sh and through the fragment alike', (content, want) => {
    const f = put(content);
    expect(viaEnv(f)).toBe(want);
    expect(viaFragment(f)).toBe(want);
  });
  it('a missing file or a symlink is no role, never an exit', () => {
    expect(viaEnv(put(null))).toBe('R=[]');
    expect(viaEnv(put('primary\n', { symlink: true }))).toBe('R=[]');
    expect(viaFragment(put('primary\n', { symlink: true }))).toBe('R=[]');
  });
  it('walg-env.sh carries the parser verbatim, in both copies', () => {
    expect(walgEnvBody).toContain(WALG_ROLE_PARSE_SH);
    expect(k8sWalgEnvBody).toContain(WALG_ROLE_PARSE_SH);
  });
  it('the fragment leaves no helper variable behind', () => {
    const r = spawnSync('sh', ['-c', `${walgRoleReadFragment('/nonexistent')}\nprintf '[%s]' "\${vc_walg_role_file-unset}"`], { encoding: 'utf-8' });
    expect(r.stdout).toBe('[unset]');
  });
});
```

- [ ] Run `pnpm vitest run tests/unit/deploy/walg-archive-script-parity.test.ts`. The new cases fail.
- [ ] Implement. Prepend before line 33 of `walg-env.sh`, then paste the identical block into the ConfigMap (the existing parity case prints the block to paste):

```sh
# The wal-g WRITE-GUARD role (src/lib/deploy/walg-role.js WALG_ROLE_PARSE_SH,
# carried verbatim): one word in a file OUTSIDE PGDATA (k8s: a sibling subPath
# of the db volume; compose: a host directory bound read-only), so
# pg_basebackup never copies it into a standby. Exactly "primary" or
# "standby"; anything else, a missing file or a symlink is no role, which
# every writer of WAL or base backups treats as "do not write".
# Test seams, for the script tests only: VC_WALG_ROLE_FILE here (the file),
# VC_WALG_ROLE_DIR in db-guard.sh (its directory).
vc_walg_role_file="${VC_WALG_ROLE_FILE:-/var/lib/vibecarbon/role/walg-role}"
VC_WALG_ROLE=""
if [ -f "$vc_walg_role_file" ] && [ ! -L "$vc_walg_role_file" ]; then
    case "$(cat "$vc_walg_role_file" 2>/dev/null)" in
        primary) VC_WALG_ROLE=primary ;;
        standby) VC_WALG_ROLE=standby ;;
    esac
fi
export VC_WALG_ROLE
unset vc_walg_role_file
```

  `walgRoleReadFragment(path)` returns `vc_walg_role_file=${shEscape(path)}\n${WALG_ROLE_PARSE_SH}\nunset vc_walg_role_file`, with `shEscape` from `src/lib/shell.js`.
- [ ] Run green, run the gate, commit: `feat(walg): one parser reads the wal-g role from a file outside PGDATA`

### Task B2: the role primitives

**Files:**
- Modify `src/lib/deploy/walg-role.js` (new exports below; nothing is deleted here, old callers move in B6 and B7)
- Test `tests/unit/deploy/walg-role.test.ts`

**Interfaces:**

```js
export const COMPOSE_WALG_ROLE_HOST_DIR = '.vibecarbon-role';     // relative to /opt/<project>
export const DB_ROLE_CONFIGMAP = 'vibecarbon-db-role';
export const DB_ROLE_INTENT_KEY = 'VC_WALG_ROLE_INTENT';
/** @returns {'primary'|'standby'} throws `unknown wal-g role` otherwise */
export function assertWalgRole(role) {}
/** Atomic write: rm tmp, printf to tmp, chmod 0644, mv -f in the same dir, sync; then prints `WALG_ROLE_FILE=<role>` read back through walgRoleReadFragment. */
export function walgRoleWriteShell(dir, role) {}
/** walgRoleReadFragment(<dir>/walg-role) + `printf 'WALG_ROLE_FILE=%s\n' "$VC_WALG_ROLE"`. Never fails. */
export function walgRoleReadShell(dir) {}
/** The ConfigMap manifest (YAML). Applied with `kubectl apply -f -`: creates it on a cluster that predates the release. */
export function dbRoleConfigMapManifest(role) {}
/** kubectl argv (no leading kubectl): `-n vibecarbon apply -f -` (pass the manifest as input). */
export function k8sWalgRoleIntentApplyArgv() {}
/** kubectl argv: exec walgRoleWriteShell(WALG_ROLE_DIR, role) in the db container. */
export function k8sWalgRoleExecArgv(role) {}
/** Pure: does this db pod JSON mount WALG_ROLE_DIR in the db container? */
export function podMountsWalgRoleDir(podJson) {}
/**
 * k8s: apply the intent (durable; creates the ConfigMap if missing), then the
 * live file, but only on a pod whose spec mounts WALG_ROLE_DIR (an old pod's
 * exec would land in the container overlay and read back as a false success).
 * @param {{ip: string, kubectl: (ip: string, argv: string[], opts?: {input?: string, timeout?: number}) => Promise<string>, role: 'primary'|'standby', requireLive?: boolean}} o
 * @returns {Promise<{intent: boolean, live: boolean, reason?: 'no-role-mount'|'pod-unreachable'|'read-back-mismatch', error?: Error}>}
 *   requireLive: throws (Error naming `vibecarbon deploy <env>` for no-role-mount) unless live.
 */
export async function setK8sWalgRole({ ip, kubectl, role, requireLive = false }) {}
/** compose: one SSH command on the host; works with db stopped. */
export function composeWalgRoleWriteShell(projectName, role) {}
```

- [ ] Write the failing tests:

```ts
const podJson = (mounted: boolean) =>
  JSON.stringify({
    metadata: { uid: 'u1' },
    spec: {
      containers: [
        {
          name: 'db',
          volumeMounts: [
            { name: 'data', mountPath: '/var/lib/postgresql/data', subPath: 'postgres-data' },
            ...(mounted ? [{ name: 'data', mountPath: WALG_ROLE_DIR, subPath: 'vibecarbon-role' }] : []),
          ],
        },
      ],
    },
  });

describe('walg role primitives', () => {
  it('refuses an unknown role', () => {
    expect(() => walgRoleWriteShell(WALG_ROLE_DIR, 'leader' as never)).toThrow(/unknown wal-g role/);
    expect(() => dbRoleConfigMapManifest(undefined as never)).toThrow(/unknown wal-g role/);
  });
  it('the write is atomic and reads itself back through the one parser, run for real', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-role-'));
    const r = spawnSync('sh', ['-c', walgRoleWriteShell(dir, 'primary')], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('WALG_ROLE_FILE=primary');
    expect(readFileSync(join(dir, 'walg-role'), 'utf-8')).toBe('primary\n');
    expect(existsSync(join(dir, 'walg-role.tmp'))).toBe(false);
    expect(statSync(join(dir, 'walg-role')).mode & 0o777).toBe(0o644);
    expect(walgRoleWriteShell(dir, 'primary')).toMatch(/mv -f [^\n]*walg-role\.tmp [^\n]*walg-role && sync/);
  });
  it('never follows a symlink planted at the tmp name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-role-'));
    writeFileSync(join(dir, 'victim'), 'x');
    symlinkSync(join(dir, 'victim'), join(dir, 'walg-role.tmp'));
    spawnSync('sh', ['-c', walgRoleWriteShell(dir, 'standby')]);
    expect(readFileSync(join(dir, 'victim'), 'utf-8')).toBe('x');
  });
  it('the manifest is the CLI-owned ConfigMap with the one key', () => {
    const doc = load(dbRoleConfigMapManifest('standby')) as { kind: string; metadata: { name: string; namespace: string }; data: Record<string, string> };
    expect(doc).toMatchObject({ kind: 'ConfigMap', metadata: { name: DB_ROLE_CONFIGMAP, namespace: 'vibecarbon' }, data: { [DB_ROLE_INTENT_KEY]: 'standby' } });
  });
  it('setK8sWalgRole: apply (never patch) the intent, then the live write on a mounted pod', async () => {
    const calls: Array<{ argv: string; input?: string }> = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[], o?: { input?: string }) => {
      calls.push({ argv: argv.join(' '), input: o?.input });
      if (argv.includes('get')) return podJson(true);
      if (argv.includes('exec')) return 'WALG_ROLE_FILE=primary';
      return '';
    });
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary' })).resolves.toEqual({ intent: true, live: true });
    expect(calls[0].argv).toContain('apply -f -');
    expect(calls[0].input).toContain(`${DB_ROLE_INTENT_KEY}: primary`);
    expect(calls.some((c) => c.argv.includes('patch'))).toBe(false);
  });
  it('a pre-release pod without the role mount: intent applied, NO exec, and requireLive throws with the deploy hint (C18)', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => (argv.includes('get') ? podJson(false) : ''));
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'standby' })).resolves.toEqual({ intent: true, live: false, reason: 'no-role-mount' });
    expect(kubectl.mock.calls.some(([, a]) => a.includes('exec'))).toBe(false);
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary', requireLive: true })).rejects.toThrow(/predates[\s\S]*vibecarbon deploy/);
  });
  it('a dead pod still records the intent (its next start applies it)', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      if (argv.includes('get')) throw new Error('pods "db-0" not found');
      return '';
    });
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'standby' })).resolves.toMatchObject({ intent: true, live: false, reason: 'pod-unreachable' });
  });
  it('a read-back that disagrees is not live', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => (argv.includes('get') ? podJson(true) : argv.includes('exec') ? 'WALG_ROLE_FILE=' : ''));
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary' })).resolves.toMatchObject({ live: false, reason: 'read-back-mismatch' });
  });
  it('compose writes on the host, in the project dir', () => {
    expect(composeWalgRoleWriteShell('acme', 'standby')).toMatch(/^cd \/opt\/acme && /);
    expect(composeWalgRoleWriteShell('acme', 'standby')).toContain('.vibecarbon-role');
  });
});
```

- [ ] Run red, implement, run green.
- [ ] Gate and commit: `feat(walg): one module writes the wal-g role, atomically, on both tiers`

### Task B3: k8s template, db-guard as the entrypoint with the intent apply, and the deploy's intent and live write

The `WALG_ROLE` env stays in the template for now (readers still read it until B5), so this task is purely additive.

**Files:**
- Modify `carbon/volumes/db/db-guard.sh` (add the intent apply; the reseed swap comes in A1)
- Modify `carbon/k8s/base/backup/configmap-walg.yaml` (add the key `db-guard.sh: |`, byte-identical; name it in the header at 9-28)
- Modify `carbon/k8s/base/db/statefulset.yaml`, db container (368-509):
  - `command: ["sh", "/usr/local/bin/db-guard.sh"]` (args unchanged);
  - mounts:
    ```yaml
    - name: wal-archive-script
      mountPath: /usr/local/bin/db-guard.sh
      subPath: db-guard.sh
      readOnly: true
    - name: data
      mountPath: /var/lib/vibecarbon/role
      subPath: vibecarbon-role
    ```
  - env:
    ```yaml
    - name: VC_WALG_ROLE_INTENT
      valueFrom:
        configMapKeyRef:
          name: vibecarbon-db-role
          key: VC_WALG_ROLE_INTENT
          optional: true
    ```
- Modify `src/lib/deploy/k8s/k3s.js`:
  - compute `walgRole` (now at 4194) BEFORE the `applyVibecarbonSecrets` call at 4177, and pass it in (R5);
  - `applyVibecarbonSecrets` (1886) applies `dbRoleConfigMapManifest(walgRole)` after the Secrets;
  - the `awaitDb` helper (4556-4561) calls `setK8sWalgRole({ role: walgRole, requireLive: true })` after `awaitPostgresAccepting`, with a local-kubectl adapter, so a warm redeploy converges the live file (C12). The audit (`assertWalgBackupsWorking`, 2578) runs after it.
- Tests:
  - `tests/unit/walg/db-guard.test.ts`
  - `tests/unit/deploy/walg-archive-script-parity.test.ts` (db-guard parity)
  - `tests/unit/deploy/k8s-db-statefulset.test.ts`
  - `tests/unit/deploy/k3s-apply-manifests-ordering.test.ts` (the ConfigMap before `apply -k`)
  - `tests/unit/deploy/k3s-db-role-live-write.test.ts` (new: the live write in `awaitDb`)

- [ ] Write the failing tests:

```ts
// db-guard.test.ts (harness at 17-41); roleDir is a temp dir created in beforeEach
describe('db-guard.sh applies the k8s role intent', () => {
  it('writes the intent atomically into the role dir, then execs the entrypoint', () => {
    const r = runGuard({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir });
    expect(r.status).toBe(0);
    expect(readFileSync(join(roleDir, 'walg-role'), 'utf-8')).toBe('standby\n');
    expect(existsSync(join(roleDir, 'walg-role.tmp'))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
  });
  it('no intent (compose, or a cluster before its first deploy): leaves the file alone', () => {
    writeFileSync(join(roleDir, 'walg-role'), 'primary\n');
    runGuard({ VC_WALG_ROLE_DIR: roleDir });
    expect(readFileSync(join(roleDir, 'walg-role'), 'utf-8')).toBe('primary\n');
  });
  it('a garbage intent REMOVES the file (no role means hold WAL)', () => {
    writeFileSync(join(roleDir, 'walg-role'), 'primary\n');
    runGuard({ VC_WALG_ROLE_INTENT: 'leader', VC_WALG_ROLE_DIR: roleDir });
    expect(existsSync(join(roleDir, 'walg-role'))).toBe(false);
  });
  it('the intent write ends in sync (the atomic-write constraint)', () => {
    expect(readFileSync(GUARD, 'utf-8')).toMatch(/mv -f "\$VC_ROLE_DIR\/walg-role\.tmp" "\$VC_ROLE_DIR\/walg-role"\n\s*sync/);
  });
  it('an interrupted restore still refuses first, before any role write', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    expect(runGuard({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir }).status).toBe(1);
    expect(existsSync(join(roleDir, 'walg-role'))).toBe(false);
  });
});
```

```ts
// walg-archive-script-parity.test.ts
it('the ConfigMap carries db-guard.sh byte-identical, and it parses under sh', () => {
  expect(configMap.data['db-guard.sh']).toBe(readFileSync(`${repoRoot}carbon/volumes/db/db-guard.sh`, 'utf-8'));
  expect(spawnSync('sh', ['-n', `${repoRoot}carbon/volumes/db/db-guard.sh`]).status).toBe(0);
});
```

```ts
// k8s-db-statefulset.test.ts (inside the describe that loads `docs`, `container`)
it('runs db-guard.sh from the ConfigMap, exactly like compose', () => {
  expect(container.command).toEqual(['sh', '/usr/local/bin/db-guard.sh']);
  expect(container.args[0]).toBe('postgres');
  expect(container.volumeMounts).toContainEqual({ name: 'wal-archive-script', mountPath: '/usr/local/bin/db-guard.sh', subPath: 'db-guard.sh', readOnly: true });
});
it('mounts the wal-g role dir as a sibling subPath of PGDATA, writable', () => {
  const m = container.volumeMounts.find((v: Doc) => v.mountPath === '/var/lib/vibecarbon/role');
  expect(m).toMatchObject({ name: 'data', subPath: 'vibecarbon-role' });
  expect(m.readOnly).toBeFalsy();
});
it('carries the role intent from the CLI-owned ConfigMap, optional', () => {
  const intent = container.env.find((e: Doc) => e.name === 'VC_WALG_ROLE_INTENT');
  expect(intent.valueFrom.configMapKeyRef).toEqual({ name: 'vibecarbon-db-role', key: 'VC_WALG_ROLE_INTENT', optional: true });
  expect(docs.find((d: Doc) => d.kind === 'ConfigMap' && d.metadata.name === 'vibecarbon-db-role')).toBeUndefined();
});
```

```ts
// k3s-apply-manifests-ordering.test.ts: reuse the file's existing applyK3sManifests
// driver (its kubectl recorder); add a recorder entry for `apply -f -` inputs.
it('applies the db role ConfigMap, with the deploy role, BEFORE apply -k base', async () => {
  const calls = await runApply({ role: 'standby' }); // the file's existing driver, extended to pass `role`
  const cm = calls.findIndex((c) => c.input?.includes('name: vibecarbon-db-role'));
  const base = calls.findIndex((c) => c.argv.includes('-k') && c.argv.some((a: string) => /k8s-base|\/base$/.test(a)));
  expect(cm).toBeGreaterThanOrEqual(0);
  expect(cm).toBeLessThan(base);
  expect(calls[cm].input).toContain('VC_WALG_ROLE_INTENT: standby');
});
```

`k3s-apply-manifests-ordering.test.ts` drives `applyK3sManifests`, which never reaches `awaitDb` (that lives in `deployK3s`, k3s.js:4556). So the live write gets its own file, `tests/unit/deploy/k3s-db-role-live-write.test.ts`, against an extracted, exported helper `writeDeployWalgRole({ kubectl, role })` that `awaitDb` calls:

```ts
it('writes the live role with requireLive after the rollout, through setK8sWalgRole', async () => {
  const calls: string[] = [];
  const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
    calls.push(argv.join(' '));
    if (argv.includes('get')) return podWithRoleMount();
    if (argv.includes('exec')) return 'WALG_ROLE_FILE=primary';
    return '';
  });
  await writeDeployWalgRole({ kubectl, role: 'primary' });
  expect(calls[0]).toContain('apply -f -');
  expect(calls.some((c) => c.includes('exec') && c.includes('/var/lib/vibecarbon/role'))).toBe(true);
});
it('a live write that does not read back fails the deploy', async () => {
  const kubectl = vi.fn(async (_ip: string, argv: string[]) => (argv.includes('get') ? podWithRoleMount() : argv.includes('exec') ? 'WALG_ROLE_FILE=' : ''));
  await expect(writeDeployWalgRole({ kubectl, role: 'primary' })).rejects.toThrow();
});
it('awaitDb runs it after the rollout and postgres readiness, before the wal-g audit', () => {
  const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
  const awaitDb = src.slice(src.indexOf('const awaitDb = async () => {'));
  const body = awaitDb.slice(0, awaitDb.indexOf('\n  };'));
  expect(body.indexOf('awaitPostgresAccepting(')).toBeLessThan(body.indexOf('writeDeployWalgRole('));
  expect(src.indexOf('writeDeployWalgRole(', src.indexOf('const awaitDb'))).toBeLessThan(src.indexOf('verifyWalgBackups({', src.indexOf('const awaitDb')));
});
```

The audit is `verifyWalgBackups` (k3s.js:2576, which calls `assertWalgBackupsWorking` at 2578); the third case pins its call in `deployK3s` after `awaitDb`'s live write.

- [ ] Run red. Implement the db-guard intent block, placed after the interrupted-restore refusal (`db-guard.sh:18-21`) and before `exec db-entrypoint.sh`:

```sh
# k8s wal-g role intent (ConfigMap vibecarbon-db-role, src/lib/deploy/walg-role.js).
# Compose never sets it. Applied on every container start, so a db pod the CLI
# could not reach comes back with the role the CLI last recorded.
VC_ROLE_DIR="${VC_WALG_ROLE_DIR:-/var/lib/vibecarbon/role}"
if [ -n "${VC_WALG_ROLE_INTENT:-}" ] && [ -d "$VC_ROLE_DIR" ] && [ ! -L "$VC_ROLE_DIR" ]; then
  chown 0:0 "$VC_ROLE_DIR" 2>/dev/null || true
  chmod 0755 "$VC_ROLE_DIR"
  case "$VC_WALG_ROLE_INTENT" in
    primary|standby)
      rm -f "$VC_ROLE_DIR/walg-role.tmp"
      printf '%s\n' "$VC_WALG_ROLE_INTENT" > "$VC_ROLE_DIR/walg-role.tmp"
      chmod 0644 "$VC_ROLE_DIR/walg-role.tmp"
      mv -f "$VC_ROLE_DIR/walg-role.tmp" "$VC_ROLE_DIR/walg-role"
      sync
      ;;
    *)
      echo "db-guard: VC_WALG_ROLE_INTENT is not primary or standby; removing the role file (no role: WAL is held)" >&2
      rm -f "$VC_ROLE_DIR/walg-role"
      ;;
  esac
fi
```

  Then the template, the ConfigMap key, and the k3s.js changes. Run green.
- [ ] Gate and commit: `feat(k8s): the db runs db-guard.sh and keeps its wal-g role in a file, its intent in vibecarbon-db-role`

### Task B4: compose template and every compose role writer

Additive: `.env` `WALG_ROLE` is still merged and still read (readers switch in B5; the `.env` merge is removed in B7).

**Files:**
- `carbon/docker-compose.prod.yml` db (248-253): add
  ```yaml
  volumes:
    - ./.vibecarbon-role:/var/lib/vibecarbon/role:ro,Z
  ```
- `src/lib/deploy/plan/steps.js:238-240`: rename `haMergeWalgRoleStep` to `haWriteNodeRolesStep` (name `write-node-roles`: it writes the role file and still merges `ACME_DISARM_ENV`, R8), and add `writeNodeRolesStep` for single compose (effect `writeNodeRoles`, writes `primary`).
- `src/lib/deploy/plan/deploy-plan.js`: compose list (70-92), insert `writeNodeRolesStep()` before `startComposeStackStep()`; compose-ha list (112), the renamed step.
- `src/lib/deploy/effects/compose-ha.js:635-658` (`haMergeWalgRole` → `haWriteNodeRoles`): write both role files with `composeWalgRoleWriteShell`, then the existing `.env` merge; the single-compose effect file (where `startComposeStack` is wired) gets `writeNodeRoles`.
- `src/scale.js` (C10):
  - `primary` on the replacement server before `startComposeStack` at 1333;
  - `standby` on the compose-ha standby before its first `up` in the standby arm (`rejoinComposeStandby`, call at 970).
- Tests:
  - `tests/unit/deploy/plan/deploy-plan.test.ts`, `tests/unit/deploy/plan/deploy-plan.snapshot.test.ts` (snapshot update for the rename)
  - `tests/unit/deploy/compose-ha-reconverge.test.ts` (step name)
  - `tests/unit/lib/scp-call-site-census.test.ts`, `tests/unit/lib/scp-transient-retry.test.ts` (they spell `merge-walg-role`)
  - `tests/unit/scale/compose-ha-standby-arm.test.ts`, `tests/unit/scale/compose-scale-fence.test.ts`, `tests/unit/helpers/scale-cutover-stub.ts`
  - `tests/unit/lib/upgrade-mount-census.test.ts` (the new bind source is a runtime dir, not a shipped file: add it to that census' explained exceptions)

- [ ] Write the failing tests:

```ts
// deploy-plan.test.ts
it('every compose tier writes the node roles before the stack starts', () => {
  for (const tier of ['compose', 'compose-ha'] as const) {
    const names = planDeploy(tier, {}).map((s) => s.name);
    const write = names.indexOf('write-node-roles');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(names.findIndex((n) => n === 'start-compose-stack' || n === 'ha-start-compose-stack' || /start-compose-stack/.test(n)));
    expect(names).not.toContain('merge-walg-role');
  }
});
```

```ts
// compose-ha-reconverge.test.ts (it already drives the HA effects with a recording ssh stub)
it('write-node-roles writes the role FILE on both nodes, primary and standby', async () => {
  const cmds = await runEffect('haWriteNodeRoles'); // the file's existing effect driver
  expect(cmds.find((c) => c.ip === PRIMARY && c.cmd.includes('.vibecarbon-role'))?.cmd).toContain("'primary'");
  expect(cmds.find((c) => c.ip === STANDBY && c.cmd.includes('.vibecarbon-role'))?.cmd).toContain("'standby'");
});
```

```ts
// compose-ha-standby-arm.test.ts / compose-scale-fence.test.ts
it('scale writes primary on the replacement before its first up', async () => {
  const seq = await recordScale(); // built here around the scale.js seams scale-cutover-stub.ts already exposes
  expect(seq.indexOf('role:new:primary')).toBeGreaterThanOrEqual(0);
  expect(seq.indexOf('role:new:primary')).toBeLessThan(seq.indexOf('up:new'));
});
it('a replaced compose-ha standby gets standby before its first up (C10)', async () => {
  const seq = await recordScale({ tier: 'compose-ha', replace: 'standby' });
  expect(seq.indexOf('role:standby:standby')).toBeLessThan(seq.indexOf('up:standby'));
});
```

```ts
// prod overlay, in k8s-db-statefulset.test.ts's sibling compose test or a new
// tests/unit/template/compose-role-bind.test.ts
it('binds the role DIRECTORY read-only (a single-file bind pins the old inode across the rename)', () => {
  const prod = load(readFileSync(join(ROOT, 'carbon/docker-compose.prod.yml'), 'utf-8')) as Doc;
  expect(prod.services.db.volumes).toContain('./.vibecarbon-role:/var/lib/vibecarbon/role:ro,Z');
});
```

- [ ] Run red, implement, run green.
- [ ] Gate and commit: `feat(compose): deploy and scale write the wal-g role file before the stack starts`

### Task B5: every reader switches to the role file; the `WALG_ROLE` env is dropped

**Files:**
- `carbon/volumes/db/wal-archive.sh`: delete the env guard (56-66), insert the role guard after the no-target `esac` (91) and before the recovery gate (93), update the header list (17-19); the ConfigMap copy (env guard at 96-105), and reword the ConfigMap header (20-28).
- `carbon/backup/compose-backup.sh:126-133` and `carbon/k8s/base/backup/cronjob.yaml:196-206`: the same `case`.
- `src/lib/deploy/walg-audit.js`: probe (155-190), `evaluateWalgAudit` (406), `walgAuditFailureMessage` (511), docblock (62-91).
- `carbon/backup/tls-snapshot.sh:75-78`: the fragment (verbatim parser).
- `src/lib/deploy/bundle.js:70-85` (`renderStandbyScaleScript`) and `src/lib/services/addon-start.js:242-253` (`renderAddonServicesScript`): read through `walgRoleReadFragment(`${COMPOSE_WALG_ROLE_HOST_DIR}/walg-role`)`.
- Template env removal:
  - `carbon/k8s/base/db/statefulset.yaml`: delete the `WALG_ROLE` env (452-453) and its header text (26-27);
  - `src/lib/deploy/k8s/k3s.js` `buildDbManifestValues` (2446-2500): drop `WALG_ROLE` and the `walgRole` parameter (R5);
  - `carbon/docker-compose.yml`: delete `WALG_ROLE` (319), rewrite the comments (310-313).
- `tests/e2e/checks/backup-evidence.ts:219` (B5 owns it, C7).
- Tests:
  - `tests/unit/deploy/walg-archive-script-parity.test.ts` (replace 104-115 and the exit census at 137-160; give the control case at 244 a role file)
  - `tests/unit/backup/backup-result-marker.test.ts` (runtime cases via `runCompose` 223 and `runCron` 243)
  - `tests/unit/deploy/compose-walg-backup.test.ts` (text pins)
  - `tests/unit/deploy/walg-audit.test.ts`
  - `tests/unit/template/tls-snapshot-script.test.ts`
  - `tests/unit/deploy/standby-scale-script.test.ts`, `tests/unit/services/addon-start.test.ts`, `tests/unit/deploy/reconcile-addons-background.test.ts`, `tests/unit/deploy/pull-images-loud.test.ts`
  - `tests/unit/deploy/k8s-db-statefulset.test.ts` (the `values()` helper at 67 drops `walgRole`)
  - `tests/integration/docker/compose-scale-zero.test.ts`, `tests/integration/docker/stack-pull-app-image.test.ts` (integration, DOCKER_INTEGRATION only: write the role file in their fixtures instead of `.env`)

- [ ] Write the failing tests:

```ts
// walg-archive-script-parity.test.ts
const archive = (role: string | null, base = 's3://bucket/backups/acme') => {
  const roleDir = mkdtempSync(join(work, 'r-'));
  if (role !== null) writeFileSync(join(roleDir, 'walg-role'), role);
  return spawnSync('bash', [`${repoRoot}${COMPOSE_SCRIPT}`, 'pg_wal/000000010000000000000001'], {
    encoding: 'utf-8',
    env: {
      PATH: `${controldataBin('arch')}:${process.env.PATH}`,
      WALG_S3_PREFIX_BASE: base,
      WALG_ENV_SH: `${repoRoot}${WALG_ENV_SCRIPT}`,
      VC_WALG_ROLE_FILE: join(roleDir, 'walg-role'),
      WAL_ARCHIVE_RETRIES: '1', WAL_ARCHIVE_SLEEP: '0', PGDATA: '/nonexistent',
    },
    timeout: 10_000,
  });
};
describe('wal-archive.sh role guard', () => {
  it('no role file: holds the segment (exit 1) with a named line, never reaching wal-g', () => {
    const r = archive(null);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WAL_ARCHIVE_ROLE_UNKNOWN');
    expect(r.stderr).not.toContain('WAL_ARCHIVE_FAILED');
  });
  it('garbage role: same hold', () => {
    expect(archive('leader\n').status).toBe(1);
  });
  it('standby: explicit skip, exit 0 (D2)', () => {
    const r = archive('standby\n');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('wal-g role standby');
  });
  it('primary: goes on to the push (no wal-g here, so it holds after the attempts)', () => {
    expect(archive('primary\n').stderr).toContain('WAL_ARCHIVE_FAILED');
  });
  it('no backup target skips BEFORE the role is consulted (local dev never holds WAL)', () => {
    const r = archive(null, '');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no backup target');
  });
  it('never reads the WALG_ROLE env, in either copy', () => {
    for (const body of [composeBody, k8sBody]) expect(body).not.toMatch(/\$\{?WALG_ROLE\b/);
  });
  it('guard order: retired, walg-env, no-target, role, recovery, fence, push', () => {
    for (const body of [composeBody, k8sBody]) {
      const at = (s: string) => body.indexOf(s);
      expect(at('vibecarbon-retired')).toBeLessThan(at('walg-env.sh'));
      expect(at('""|s3:///*)')).toBeLessThan(at('case "${VC_WALG_ROLE:-}" in'));
      expect(at('case "${VC_WALG_ROLE:-}" in')).toBeLessThan(at('SELECT pg_is_in_recovery()'));
      expect(at('SELECT pg_is_in_recovery()')).toBeLessThan(at('st cat vibecarbon-fence.json'));
    }
  });
});
```

Update the exit census (137-160): `exit 1` count 3 → 4 (retired, role unknown, fence, final hold); the `vibecarbon-retired` ordering assertion now compares against `case "${VC_WALG_ROLE:-}" in`. Give the existing control case at 244 a role file reading `primary` through `VC_WALG_ROLE_FILE`.

```ts
// backup-result-marker.test.ts: role file through VC_WALG_ROLE_FILE in env
const roleFile = (name: string, content: string | null) => {
  const d = join(work, `role-${name}`);
  mkdirSync(d, { recursive: true });
  if (content !== null) writeFileSync(join(d, 'walg-role'), content);
  return join(d, 'walg-role');
};
describe('the base-backup role guard (compose and the k8s CronJob)', () => {
  it.each([
    ['compose', runCompose],
    ['cron', runCron],
  ] as const)('%s: no role file exits 1 with no BACKUP_RESULT line and no push', (name, run) => {
    const r = run(`no-role-${name}`, {}, { VC_WALG_ROLE_FILE: roleFile(`none-${name}`, null) });
    expect(r.status).toBe(1);
    expect(markers(r.stdout)).toEqual([]);
    expect(r.stdout + r.stderr).toContain('backup refused: no wal-g role');
    expect(r.walg).not.toContain('backup-push');
  });
  it.each([
    ['compose', runCompose],
    ['cron', runCron],
  ] as const)('%s: standby skips with the standby-role marker', (name, run) => {
    const r = run(`standby-${name}`, {}, { VC_WALG_ROLE_FILE: roleFile(`sb-${name}`, 'standby\n') });
    expect(r.status).toBe(0);
    expect(markers(r.stdout)).toEqual(['BACKUP_RESULT=skipped:standby-role']);
  });
});
```

Every existing case in this file that expects a push gets `VC_WALG_ROLE_FILE` pointing at a `primary` file (add it to `baseEnv`).

```ts
// walg-audit.test.ts
it('the probe reads VC_WALG_ROLE, never the WALG_ROLE env, and has no single quote', () => {
  for (const requirePrimary of [false, true]) {
    const probe = buildWalgAuditProbe({ requirePrimary });
    expect(probe).toContain('case "${VC_WALG_ROLE:-}" in');
    expect(probe).not.toMatch(/\$\{WALG_ROLE/);
    expect(probe).not.toContain("'");
  }
});
it('no role is a failure, never a skip, and the message names vibecarbon deploy', () => {
  const r = evaluateWalgAudit('WALG_AUDIT=fail:no-role\nWALG_AUDIT_PREFIX=s3://b/p/1');
  expect(r.ok).toBe(false);
  expect(walgAuditFailureMessage(r, 'k8s')).toMatch(/no wal-g role[\s\S]*vibecarbon deploy/i);
});
it('assertWalgBackupsWorking throws on it', async () => {
  await expect(assertWalgBackupsWorking({ path: 'compose', probe: async () => 'WALG_AUDIT=fail:no-role\nWALG_AUDIT_PREFIX=s3://b/p/1' })).rejects.toThrow(/no wal-g role/i);
});
it('requirePrimary still turns standby into fail:stale-standby-role', () => {
  expect(buildWalgAuditProbe({ requirePrimary: true })).toContain('fail:stale-standby-role');
});
```

```ts
// tls-snapshot-script.test.ts: extend its runner with a host role file under the project dir
it('snapshots only when the host role file says primary, through the one parser', () => {
  expect(run({ hostRole: 'primary\n' }).stderr).not.toContain('tls snapshot skipped: wal-g role');
  for (const hostRole of ['standby\n', null, 'x']) {
    expect(run({ hostRole }).stderr).toContain('tls snapshot skipped: wal-g role');
  }
  const body = readFileSync(SCRIPT, 'utf-8');
  expect(body).toContain(WALG_ROLE_PARSE_SH);
  expect(body).not.toContain('printenv WALG_ROLE');
});
```

```ts
// standby-scale-script.test.ts
it('reads the role file through the shared fragment, never .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-ss-'));
  const script = renderStandbyScaleScript(['n8n']);
  expect(script).toContain(WALG_ROLE_PARSE_SH);
  expect(script).not.toContain('.env');
  writeFileSync(join(dir, 'standby-scale.sh'), script);
  writeFileSync(join(dir, '.env'), 'WALG_ROLE=standby\n'); // ignored
  mkdirSync(join(dir, '.vibecarbon-role'));
  writeFileSync(join(dir, '.vibecarbon-role/walg-role'), 'primary\n');
  expect(spawnSync('sh', ['standby-scale.sh'], { cwd: dir, encoding: 'utf-8' }).stdout).toBe('');
  writeFileSync(join(dir, '.vibecarbon-role/walg-role'), 'standby\n');
  expect(spawnSync('sh', ['standby-scale.sh'], { cwd: dir, encoding: 'utf-8' }).stdout.trim()).toBe('--scale n8n=0');
});
// addon-start.test.ts: the same shape for renderAddonServicesScript(['n8n']): primary prints n8n, standby prints nothing.
```

```ts
// k8s-db-statefulset.test.ts
it('no WALG_ROLE env and no WALG_ROLE render value', () => {
  expect(container.env.find((e: Doc) => e.name === 'WALG_ROLE')).toBeUndefined();
  expect(values()).not.toHaveProperty('WALG_ROLE');
  expect(readFileSync(join(ROOT, 'carbon/docker-compose.yml'), 'utf-8')).not.toMatch(/^\s*WALG_ROLE:/m);
});
```

- [ ] Run red. Implement. The archive guard:

```bash
# WRITE-GUARD (src/lib/deploy/walg-role.js): only a node whose role file says
# primary archives. standby is an explicit skip (exit 0: a standby's segments
# belong to no backup). No role, or one that is not a word we know, HOLDS the
# segment (exit 1): postgres keeps it and retries, pg_stat_archiver turns
# status red, and nothing is lost while the CLI writes the role.
case "${VC_WALG_ROLE:-}" in
    primary) ;;
    standby)
        echo "wal-archive: wal-g role standby, skipping archive of '${WAL_PATH}' (only the primary writes the lineage prefix)." >&2
        exit 0
        ;;
    *)
        echo "WAL_ARCHIVE_ROLE_UNKNOWN: no wal-g role in ${VC_WALG_ROLE_FILE:-/var/lib/vibecarbon/role/walg-role}; keeping '${WAL_PATH}', postgres retries it (vibecarbon deploy writes the role)." >&2
        exit 1
        ;;
esac
```

The backup scripts, after the no-target and no-credentials skips:

```bash
case "${VC_WALG_ROLE:-}" in
  primary) ;;
  standby)
    echo "wal-g role standby, skipping base backup (only the primary writes the lineage prefix)."
    echo "BACKUP_RESULT=skipped:standby-role"
    exit 0
    ;;
  *)
    echo "backup refused: no wal-g role in ${VC_WALG_ROLE_FILE:-/var/lib/vibecarbon/role/walg-role} (vibecarbon deploy writes it)." >&2
    exit 1
    ;;
esac
```

`tls-snapshot.sh`, at 75-78 (it runs in the project dir):

```bash
vc_walg_role_file=.vibecarbon-role/walg-role
VC_WALG_ROLE=""
if [ -f "$vc_walg_role_file" ] && [ ! -L "$vc_walg_role_file" ]; then
    case "$(cat "$vc_walg_role_file" 2>/dev/null)" in
        primary) VC_WALG_ROLE=primary ;;
        standby) VC_WALG_ROLE=standby ;;
    esac
fi
unset vc_walg_role_file
[ "$VC_WALG_ROLE" = "primary" ] || skip "wal-g role is ${VC_WALG_ROLE:-unknown}, not primary (only the primary writes snapshots)"
```

The audit probe gets `case "${VC_WALG_ROLE:-}" in primary) ;; standby) <existing standby branch> ;; *) echo "WALG_AUDIT=fail:no-role"; echo "WALG_AUDIT_PREFIX=$PFX"; exit 0 ;; esac`. `evaluateWalgAudit` maps `fail:no-role` to `{ok: false, reason: 'no-role'}`, and `walgAuditFailureMessage` renders it.
- [ ] Run green.
- [ ] Gate and commit: `feat(walg): archiving, base backups, the audit and add-on scaling read the role file`

### Task B6: k8s role movers (failover, abort, retired fence) without a restart

**Files:**
- `src/lib/deploy/replication.js`: receive `k8sDbRolloutStatusArgv` and `k8sDbRolloutWait` (moved from walg-role.js:314 and 342, next to `watchDbAttach` at 826), with `DB_STATEFULSET` imported from db-workload.js (C14). `walg-role.js` stops importing them; it keeps importing `DB_STS_BOOT_TIMEOUT_S` only if still used, else drops the import.
- `src/lib/deploy/walg-role.js`:
  - `demoteK8sWalgRole` (275-303): drop slots, then `setK8sWalgRole({ role: 'standby' })` (a dead pod is fine);
  - delete `k8sSetWalgRoleArgv` (246-255): its last callers move here;
  - `walgRoleDegradedMessage` (369-391): the verify commands become `kubectl -n vibecarbon exec db-0 -c db -- cat /var/lib/vibecarbon/role/walg-role` and the compose host `cat`; "re-run deploy" stays, true again after B3's live write (C12).
- `src/failover.js`:
  - STEP 1 preflight (2149): for k8s-ha, read the standby db pod and refuse when `podMountsWalgRoleDir` is false, with D1's hint (C18). No change has happened yet.
  - `restorePromotedWalgRole` (1915-1981) splits:
    - `armPromotedWalgRole({ standbyIp, kubectl })` = `setK8sWalgRole({ role: 'primary', requireLive: true })`, called right before `promote(...)` at 2372; a throw aborts before promotion (D2);
    - after the promote (2507): the `requirePrimary` audit and the old-primary demotion only. The `k8sDbRolloutWait` at 1930 goes.
  - Abort backend: `disarmStandby` (1831-1836) and `armPrimary` (1858-1878) use `setK8sWalgRole`; `armPrimary` decides from `walgRoleReadShell` output and the ConfigMap, not the template env. The `k8sDbRolloutWait` at 1874 goes. The import of `k8sDbRolloutWait` (83) goes.
- `src/lib/deploy/retired-fence.js`:
  - k8s probe (383): `walgStandby` = the intent ConfigMap says `standby` AND (the live file reads `standby`, or the pod is unreachable → `'unknown'`, retried by the second pass);
  - k8s step (494-504): `demoteK8sWalgRole`;
  - import `k8sDbRolloutWait` from replication.js (66); the settle wait (404) stays (it waits for a db pod that is down or mid-roll, not for a role roll).
- Tests:
  - `tests/unit/failover/failover-step-order-census.test.ts`, `tests/unit/failover/failover-abort.test.ts` (k8s side), `tests/unit/failover/walg-role-demotion-independent.test.ts`, `tests/unit/failover/pilot-flow.test.ts`, `tests/unit/failover/failover-minors.test.ts`
  - `tests/unit/deploy/retired-fence.test.ts`
  - `tests/unit/deploy/slot-drop-on-demotion-census.test.ts` (158-192: retarget from `k8sSetWalgRoleArgv` to `setK8sWalgRole`)
  - `tests/unit/deploy/walg-role.test.ts` (drop `k8sSetWalgRoleArgv` and the moved `k8sDbRolloutStatusArgv` cases; they move to a replication test)
  - `tests/unit/deploy/db-attach-watch.test.ts`: the `k8sDbRolloutWait` import (230) moves to replication.js; the census filter `!f.endsWith('walg-role.js')` (268) becomes the enclosing-function check below; ALLOWED key `walg-role.js#k8sDbRolloutStatusArgv` (287) becomes `replication.js#k8sDbRolloutStatusArgv`; the describe title at 228 drops "WALG_ROLE rolls"; recount `seen` (345) and pin the new floor with a comment listing the sites.
  - `tests/unit/deploy/db-sts-boot-timeout-census.test.ts` (it names `k8sDbRolloutStatusArgv`'s file)
  - `tests/unit/walg/post-promote-backup-census.test.ts` (it names `restorePromotedWalgRole`)

- [ ] Write the failing tests. Build `runFailoverK8s(stubs)` in failover-step-order-census.test.ts around the real `failoverHA` export with its existing `deps` seams (`promote`, `kubectl`, `restoreWalgRole`, ...):

```ts
it('k8s: the promoted side is armed BEFORE pg_promote, by apply + live write, and nothing rolls the db', async () => {
  const log: string[] = [];
  await runFailoverK8s({
    kubectl: async (_ip, argv, o) => { log.push(`${argv.join(' ')} ${o?.input ?? ''}`); return k8sReply(argv); },
    promote: async () => { log.push('PROMOTE'); return { ok: true }; },
  });
  const intent = log.findIndex((l) => l.includes('apply -f -') && l.includes('VC_WALG_ROLE_INTENT: primary'));
  const live = log.findIndex((l) => l.includes('exec') && l.includes('/var/lib/vibecarbon/role') && l.includes('primary'));
  const promote = log.indexOf('PROMOTE');
  expect(intent).toBeGreaterThanOrEqual(0);
  expect(live).toBeGreaterThan(intent);
  expect(promote).toBeGreaterThan(live);
  expect(log.some((l) => /set env statefulset\/db|rollout status statefulset\/db/.test(l))).toBe(false);
});
it('k8s: a failed live role write aborts BEFORE promotion', async () => {
  const promote = vi.fn();
  await expect(runFailoverK8s({
    kubectl: async (_ip, argv) => { if (argv.includes('exec') && argv.join(' ').includes('walg-role')) throw new Error('exec failed'); return k8sReply(argv); },
    promote,
  })).rejects.toThrow(/before promotion/i);
  expect(promote).not.toHaveBeenCalled();
});
it('k8s: a standby db pod without the role mount (a pre-release cluster) is refused at STEP 1, before anything changes (C18)', async () => {
  const calls: string[] = [];
  const promote = vi.fn();
  await expect(runFailoverK8s({
    kubectl: async (_ip, argv) => { calls.push(argv.join(' ')); return k8sReply(argv, { roleMount: false }); },
    promote,
  })).rejects.toThrow(/predates[\s\S]*vibecarbon deploy/);
  expect(promote).not.toHaveBeenCalled();
  expect(calls.some((c) => /scale |apply -f -|exec .*walg-role/.test(c))).toBe(false);
});
```

`k8sReply(argv, { roleMount = true } = {})` answers `get pod db-0 -o json` with a pod whose db container mounts `/var/lib/vibecarbon/role` when `roleMount`, the exec write with `WALG_ROLE_FILE=<role in the argv>`, and everything else as the file's existing stubs do.

```ts
// walg-role-demotion-independent.test.ts
it('a dead old-primary pod still gets the standby intent (its next start applies it)', async () => {
  const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
    if (argv.includes('get') && argv.includes('pod')) throw new Error('pods "db-0" not found');
    return '';
  });
  const r = await demoteK8sWalgRole({ ip: '9.9.9.9', kubectl, warn: () => {} });
  expect(kubectl.mock.calls.some(([, a, o]) => a.join(' ').includes('apply -f -') && String(o?.input).includes('VC_WALG_ROLE_INTENT: standby'))).toBe(true);
  expect(r).toMatchObject({ intent: true, live: false });
});
```

```ts
// retired-fence.test.ts: build probeK8sWith({ intent, file, podDown }) around the real probe with its kubectl seam
it('k8s walgStandby needs the standby intent; the live file is checked when the pod answers', async () => {
  expect((await probeK8sWith({ intent: 'standby', file: 'primary' })).walgStandby).toBe(false);
  expect((await probeK8sWith({ intent: 'standby', file: null, podDown: true })).walgStandby).toBe('unknown');
  expect((await probeK8sWith({ intent: 'standby', file: 'standby' })).walgStandby).toBe(true);
  expect((await probeK8sWith({ intent: null, file: 'standby' })).walgStandby).toBe(false);
});
```

```ts
// db-attach-watch.test.ts, replacing 266-271
it('k8sDbRolloutStatusArgv is only spent inside k8sDbRolloutWait', () => {
  for (const f of walk(join(ROOT, 'src'))) {
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/k8sDbRolloutStatusArgv\(/g)) {
      const site = siteOf(f, src, m.index ?? 0);
      expect(['replication.js#k8sDbRolloutWait', 'replication.js#k8sDbRolloutStatusArgv'], site).toContain(site);
    }
  }
});
```

- [ ] Run red, implement, run green. Then `pnpm vitest run tests/unit/failover tests/unit/deploy/retired-fence.test.ts tests/unit/deploy/db-attach-watch.test.ts`.
- [ ] Gate and commit: `feat(failover): k8s moves the wal-g role with one write, before promotion, no db restart`

### Task B7: compose role movers; retire the `.env` role

**Files:**
- `src/lib/deploy/compose/ha.js`:
  - `restoreComposeWalgRole` (1295-1364) → `armComposeWalgRole`, a host write of `primary`, called before `promote(...)` at 2283; after the promote, `restoreWalgRole` at 2343 runs the audit only. No `composeDbRecreateShell`.
  - `demoteComposeWalgRole` (1403+): host write of `standby` plus the slot drop, no recreate.
  - `composeDbRoleProbeShell` (1374-1378): `walgRoleReadShell('/opt/<p>/.vibecarbon-role')`.
  - `composeFailoverAbortBackend` (1749-1880, C4): `disarmStandby` (1829-1834) writes `standby` with `composeWalgRoleWriteShell` instead of `mergeEnv(composeRoleEnv(...))`; `armPrimary` (1860-1870) reads with `walgRoleReadShell` and writes `primary` when it is not; the `rearmWalg` seam (1762) follows.
- `src/lib/deploy/retired-fence.js` compose probe (516-545): `walgRoleReadShell`; compose step: `demoteComposeWalgRole`.
- `src/lib/deploy/effects/compose-ha.js` `haWriteNodeRoles`: drop the `.env` role merge, keep `ACME_DISARM_ENV`.
- `src/scale.js:680-697` (demote after the flip) and `src/lib/deploy/compose/scale-cutover.js:27-29` (reworded: still after the flip, for the gap reason, but instant and reversible).
- `src/lib/deploy/walg-role.js`: delete `composeRoleEnv` (73-78) and `composeDbRecreateShell` (147-230), `COMPOSE_CONFIG_FILES_LABEL` and `PUBLISHED_PORTS_TEMPLATE` only if `acme-role.js` no longer imports them (it does today: keep them, move the comment).
- Tests:
  - delete `tests/unit/deploy/compose-role-env-census.test.ts` (C1's census replaces it)
  - `tests/unit/deploy/slot-drop-on-demotion-census.test.ts` (the compose half), `tests/unit/deploy/walg-prefix-namespacing.test.ts` (68-71), `tests/unit/deploy/walg-role.test.ts` (drop `composeDbRecreateShell` cases)
  - `tests/unit/failover/failover-abort.test.ts` (compose side), `tests/unit/failover/compose-ha-skip-reseed.test.ts`, `tests/unit/failover/failover-minors.test.ts`, `tests/unit/failover/failover-step-order-census.test.ts`
  - `tests/unit/deploy/compose-ha-failover-readiness.test.ts`, `tests/unit/deploy/compose-ssh-dns-retry.test.ts`, `tests/unit/deploy/backup-fence.test.ts`
  - `tests/unit/scale/compose-ha-standby-arm.test.ts`, `tests/unit/scale/compose-scale-fence.test.ts`, `tests/unit/scale/compose-scale-tls-restore.test.ts`, `tests/unit/helpers/scale-cutover-stub.ts`
  - `tests/unit/walg/post-promote-backup-census.test.ts`
  - `tests/unit/deploy/compose-ha-reconverge.test.ts` (no `.env` role in the merge)

- [ ] Write the failing tests. Build `runFailoverCompose(stubs)` around the real compose failover export with its `deps` (`promote`, `run`, `restoreWalgRole`):

```ts
it('compose: the promoted host role file is written BEFORE pg_promote; no db recreate', async () => {
  const cmds: string[] = [];
  await runFailoverCompose({
    run: async (_ip, _k, cmd) => { cmds.push(cmd); return composeReply(cmd); },
    promote: async () => { cmds.push('PROMOTE'); return { ok: true }; },
  });
  const write = cmds.findIndex((c) => c.includes('.vibecarbon-role') && c.includes("'primary'"));
  expect(write).toBeGreaterThanOrEqual(0);
  expect(write).toBeLessThan(cmds.indexOf('PROMOTE'));
  expect(cmds.some((c) => c.includes('up -d --no-deps db'))).toBe(false);
});
it('compose abort: disarmStandby writes the standby role FILE, armPrimary reads it (C4)', async () => {
  const cmds: string[] = [];
  const backend = composeFailoverAbortBackend({
    envName: 'prod', envConfig: haEnvConfig(), projectName: 'acme', sshKeyPath: '/k',
    deps: { run: async (_ip, _k, cmd) => { cmds.push(cmd); return cmd.includes('WALG_ROLE_FILE') ? 'WALG_ROLE_FILE=standby' : 'WRITERS_DONE'; }, mergeEnv: vi.fn() },
  });
  await backend.disarmStandby();
  expect(cmds.some((c) => c.includes('.vibecarbon-role') && c.includes("'standby'"))).toBe(true);
  await backend.armPrimary();
  expect(cmds.some((c) => c.includes('.vibecarbon-role') && c.includes("'primary'"))).toBe(true);
  expect(cmds.some((c) => c.includes('up -d --no-deps db'))).toBe(false);
});
it('nothing writes WALG_ROLE into a compose .env any more', () => {
  for (const f of ['src/lib/deploy/compose/ha.js', 'src/lib/deploy/effects/compose-ha.js', 'src/scale.js']) {
    expect(readFileSync(join(REPO, f), 'utf-8'), f).not.toMatch(/composeRoleEnv|\bWALG_ROLE\s*:/);
  }
});
```

```ts
// compose-scale-fence.test.ts
it('the old server is demoted to standby only after the flip, by a host write, with no recreate', async () => {
  const seq = await recordScale(); // from B4
  expect(seq.indexOf('role:old:standby')).toBeGreaterThan(seq.indexOf('dns-flip'));
  expect(seq).not.toContain('recreate:old:db');
});
```

- [ ] Run red, implement, run green.
- [ ] Gate and commit: `feat(failover): compose moves the wal-g role with one host write; .env no longer carries it`

### Task B8: e2e role checks

**Files:**
- `tests/e2e/checks/ha-integrity.ts`: `buildDisarmProbeCommand` and `parseDisarmProbe` (98-190) read the role through `walgRoleReadShell` (compose: `/opt/<p>/.vibecarbon-role`; k8s: the intent ConfigMap plus `kubectl exec db-0 -c db -- sh -c <walgRoleReadShell(WALG_ROLE_DIR)>`); new checks `checkPromotedDbNotRecreated`, `checkPromotionHistoryArchived`.
- `tests/e2e/scenarios/_run-lifecycle.ts`: capture the standby (to-be-promoted) db incarnation and StatefulSet generation right before the failover step and the failback step, with `readDbIncarnation` (ha-integrity.ts:252), the same way `primaryDbAtDeploy` is captured (1407, 3386); run the new checks at verify-failover and verify-failback (2454 is the pattern).
- `tests/unit/e2e/ha-integrity.test.ts`, `tests/unit/e2e/hollow-pass-census.test.ts` (register both new checks, with the null-handle cases at 497-512 as the pattern).

- [ ] Write the failing tests:

```ts
// ha-integrity.test.ts
it('compose disarm probe: role from the shared reader, not docker inspect', () => {
  const cmd = buildDisarmProbeCommand('compose-ha', 'acme');
  expect(cmd).toContain(walgRoleReadShell('/opt/acme/.vibecarbon-role'));
  expect(cmd).not.toContain('WALG_ROLE=$(docker inspect');
  expect(parseDisarmProbe('compose-ha', 'HOST_MARKER=1\nWALG_ROLE_FILE=standby\nPROBE_DONE')).toEqual({ walgRole: 'standby', walgIntent: null, retiredMarker: true });
});
it('k8s disarm probe: intent and live file must both say standby', () => {
  const out = 'INTENT=standby\nWALG_ROLE_FILE=standby\nRETIRED=1\nPROBE_DONE';
  expect(parseDisarmProbe('k8s-ha', out)).toEqual({ walgRole: 'standby', walgIntent: 'standby', retiredMarker: true });
});
it('promoted_db_not_recreated: uid and generation unchanged across the failover', async () => {
  const inc = (id: string) => ({ ok: true as const, incarnation: { id, startedAt: 't' } });
  const run = async () => ({ ok: true, output: '1' });
  expect((await checkPromotedDbNotRecreated({ ...sshArgs, run, ip: N, before: inc('u1'), after: inc('u1'), generationBefore: '1' })).status).toBe('pass');
  expect((await checkPromotedDbNotRecreated({ ...sshArgs, run, ip: N, before: inc('u1'), after: inc('u2'), generationBefore: '1' })).status).toBe('fail');
  expect((await checkPromotedDbNotRecreated({ ...sshArgs, run: async () => ({ ok: true, output: '2' }), ip: N, before: inc('u1'), after: inc('u1'), generationBefore: '1' })).status).toBe('fail');
});
it('promotion_history_archived: matches <TL hex>.history as a prefix (wal-g stores it compressed)', () => {
  expect(historyArchived('00000002.history.lz4\n000000020000000000000005.lz4', 2)).toBe(true);
  expect(historyArchived('00000002.history.br', 2)).toBe(true);
  expect(historyArchived('000000020000000000000005.lz4', 2)).toBe(false);
  expect(historyArchived('00000003.history.lz4', 2)).toBe(false);
});
```

- [ ] Run red, implement (`historyArchived(listing, tl)` = some line starts with `${tl.toString(16).toUpperCase().padStart(8, '0')}.history`, R9), run green.
- [ ] Gate and commit: `test(e2e): HA checks read the wal-g role through the shared reader; the promoted db is never recreated`

### Task B9: template lockstep preflight

**Files:** `src/lib/deploy/preflight.js` (a new check), `tests/unit/deploy/preflight-role-file.test.ts` (new).

**Interfaces:** `assertScaffoldSupportsRoleFile(projectDir, tier)` throws `Error("this project's scaffold predates the wal-g role file; run vibecarbon upgrade, then deploy")` when:
- `volumes/db/walg-env.sh` lacks `WALG_ROLE_PARSE_SH`;
- compose tiers: `docker-compose.prod.yml` lacks `.vibecarbon-role`;
- k8s tiers: `k8s/base/backup/configmap-walg.yaml` lacks `WALG_ROLE_PARSE_SH` or the `db-guard.sh:` key.

- [ ] Write the failing tests:

```ts
it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const)('%s: the current scaffold passes; an old walg-env.sh refuses', (tier) => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-scaffold-'));
  cpSync(join(ROOT, 'carbon'), dir, { recursive: true });
  expect(() => assertScaffoldSupportsRoleFile(dir, tier)).not.toThrow();
  const env = join(dir, 'volumes/db/walg-env.sh');
  writeFileSync(env, readFileSync(env, 'utf-8').replace(WALG_ROLE_PARSE_SH, ''));
  expect(() => assertScaffoldSupportsRoleFile(dir, tier)).toThrow(/vibecarbon upgrade/);
});
it('k8s: a ConfigMap without db-guard.sh refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-scaffold-'));
  cpSync(join(ROOT, 'carbon'), dir, { recursive: true });
  const cm = join(dir, 'k8s/base/backup/configmap-walg.yaml');
  writeFileSync(cm, readFileSync(cm, 'utf-8').replace(/\n  db-guard\.sh: \|[\s\S]*$/, '\n'));
  expect(() => assertScaffoldSupportsRoleFile(dir, 'k8s-ha')).toThrow(/vibecarbon upgrade/);
});
```

- [ ] Implement, call it next to the existing deploy preflights, run green.
- [ ] Gate and commit: `feat(deploy): refuse a scaffold that predates the wal-g role file`

---

## Part A: the in-place standby reseed

### Task A1: db-guard's reseed swap (only for a standby)

**Files:**
- Modify `carbon/volumes/db/db-guard.sh` (line 2 becomes `# vc-reseed-protocol: 1`; the swap block after the intent apply from B3) and its ConfigMap copy.
- Modify both restore swaps so a stale reseed state cannot survive a restore (C16): the walg-restore init (`carbon/k8s/base/db/statefulset.yaml`, before its swap at 260) and `composeRestoreScript` (`src/lib/deploy/compose/index.js:1536`) add `rm -rf "$PGDATA/.vc-reseed" "$PGDATA/.vc-reseed-ready" "$PGDATA/.vc-reseed-ready.tmp" "$PGDATA/.vc-reseed-in-progress" "$PGDATA/.vc-reseed-in-progress.tmp"` right after `.vc-discard` is cleared.
- Tests:
  - `tests/unit/walg/db-guard.test.ts`
  - `tests/unit/walg/restore-script-states.test.ts` (both tiers)
  - `tests/unit/deploy/restore-destroy-before-verify-census.test.ts` (holds both tiers' text)
  - `tests/unit/deploy/walg-archive-script-parity.test.ts` (parity is already pinned in B3; it stays green with the copy)

**Interfaces (PGDATA layout; all `.vc-*`, so every existing `! -name '.vc-*'` filter skips them):**

| path | written by | meaning |
| --- | --- | --- |
| `.vc-reseed/` | CLI stage script | staged `pg_basebackup` tree, `.vc-*`-free, plus `.vc-reseed/.vc-reseed-id` |
| `.vc-reseed-ready` | CLI stage script, by rename, last | `<attempt id>`: staging is verified and may be swapped on the next start |
| `.vc-reseed-in-progress` | wrapper, by rename | `out <id>`: the cluster is moving to `.vc-discard`. `in <id>`: staging is moving into PGDATA |
| `.vc-reseeded-from` | wrapper, by rename | `<attempt id>` of the last completed swap (the CLI's proof) |
| `.vc-discard/` | wrapper; CLI and restore remove it | the old tree (D9) |
| `.vc-restore.lock` | wrapper (flock), shared with restore | one swap at a time |

A swap STARTS only when `VC_WALG_ROLE_INTENT=standby` and the attempt ids match (C16). A swap already in progress (`out`/`in`) always finishes or rolls back, whatever the intent, because stopping half way would leave no bootable tree.

- [ ] Write the failing tests (`stage()`, `live()` and `roleDir` are new helpers in the file; `runGuard` is the existing one at 22):

```ts
const ID = 'att-7f3c';
const SB = () => ({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir });
function stage(id = ID, { conninfo = true, signal = true } = {}) {
  const s = join(pgdata, '.vc-reseed');
  mkdirSync(join(s, 'base'), { recursive: true });
  writeFileSync(join(s, 'PG_VERSION'), '17\n');
  if (signal) writeFileSync(join(s, 'standby.signal'), '');
  writeFileSync(join(s, 'postgresql.auto.conf'), conninfo ? "primary_conninfo = 'host=x'\n" : '');
  writeFileSync(join(s, '.vc-reseed-id'), id);
  writeFileSync(join(pgdata, '.vc-reseed-ready'), id);
}
function live() {
  writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
  mkdirSync(join(pgdata, 'base'));
  writeFileSync(join(pgdata, 'base', 'OLD'), 'old');
}

describe('db-guard.sh reseed swap', () => {
  it('the protocol marker is line 2 (the live-pod guard greps it)', () => {
    expect(readFileSync(GUARD, 'utf-8').split('\n')[1]).toBe('# vc-reseed-protocol: 1');
  });
  it('a standby swaps a verified staging in, keeps the old tree in .vc-discard, records the attempt, then execs postgres', () => {
    live(); stage();
    const r = runGuard(SB());
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-discard', 'base', 'OLD'))).toBe(true);
    expect(readFileSync(join(pgdata, '.vc-reseeded-from'), 'utf-8')).toBe(ID);
    for (const f of ['.vc-reseed', '.vc-reseed-ready', '.vc-reseed-in-progress', '.vc-reseed-id']) expect(existsSync(join(pgdata, f))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
  });
  it('C16: a stale ready marker on a PRIMARY (survived a promotion) is refused and cleared; the live tree boots', () => {
    live(); stage();
    const r = runGuard({ VC_WALG_ROLE_INTENT: 'primary', VC_WALG_ROLE_DIR: roleDir });
    expect(r.stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT');
  });
  it('C16: no intent at all (compose, or no ConfigMap) never swaps', () => {
    live(); stage();
    expect(runGuard().stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
  });
  it('a staging whose id does not match the ready marker is refused and cleared', () => {
    live(); stage(); writeFileSync(join(pgdata, '.vc-reseed', '.vc-reseed-id'), 'other');
    expect(runGuard(SB()).stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
  });
  it.each([
    ['no standby.signal', { signal: false }],
    ['no primary_conninfo', { conninfo: false }],
  ])('refuses a staging with %s', (_n, opts) => {
    live(); stage(ID, opts);
    expect(runGuard(SB()).stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
  });
  it('resumes a crash mid "out" (whatever the intent): finishes moving the cluster aside, then swaps', () => {
    live(); stage();
    mkdirSync(join(pgdata, '.vc-discard')); renameSync(join(pgdata, 'base'), join(pgdata, '.vc-discard', 'base'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `out ${ID}`);
    expect(runGuard({ VC_WALG_ROLE_DIR: roleDir }).stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, '.vc-discard', 'PG_VERSION'))).toBe(true);
    expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
  });
  it('resumes a crash mid "in": moves the rest of staging in', () => {
    stage();
    mkdirSync(join(pgdata, '.vc-discard'));
    renameSync(join(pgdata, '.vc-reseed', 'PG_VERSION'), join(pgdata, 'PG_VERSION'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    expect(runGuard(SB()).stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
    expect(existsSync(join(pgdata, 'base'))).toBe(true);
  });
  it('resumes "in" when staging is already gone (crash after the moves, before cleanup)', () => {
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n'); writeFileSync(join(pgdata, 'standby.signal'), '');
    writeFileSync(join(pgdata, '.vc-reseed-ready'), ID);
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    expect(runGuard(SB()).stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, '.vc-reseed-in-progress'))).toBe(false);
  });
  it('"out" with a staging that lost PG_VERSION rolls the cluster BACK and boots it', () => {
    live(); stage();
    rmSync(join(pgdata, '.vc-reseed', 'PG_VERSION'));
    mkdirSync(join(pgdata, '.vc-discard')); renameSync(join(pgdata, 'base'), join(pgdata, '.vc-discard', 'base'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `out ${ID}`);
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_ROLLED_BACK');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expect(existsSync(join(pgdata, '.vc-reseed-in-progress'))).toBe(false);
  });
  it('an interrupted RESTORE still wins: refuse before touching any reseed state', () => {
    live(); stage(); writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in');
    expect(runGuard(SB()).status).toBe(1);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(true);
  });
  it('refuses symlinked reseed markers (it runs as root)', () => {
    live(); stage(); rmSync(join(pgdata, '.vc-reseed-ready')); symlinkSync('/etc/passwd', join(pgdata, '.vc-reseed-ready'));
    expect(runGuard(SB()).status).toBe(1);
  });
  it('a normal boot with no reseed state is unchanged', () => {
    live();
    expect(runGuard(SB()).stdout).toContain('STUB-ENTRYPOINT postgres -c config_file=/x');
  });
});
```

```ts
// restore-script-states.test.ts: both tiers
it.each(['compose', 'k8s'] as const)('%s: a stale reseed state does not survive a restore (C16)', (tier) => {
  const pgdata = seedLiveCluster();
  mkdirSync(join(pgdata, '.vc-reseed', 'base'), { recursive: true });
  writeFileSync(join(pgdata, '.vc-reseed', '.vc-reseed-id'), 'old');
  writeFileSync(join(pgdata, '.vc-reseed-ready'), 'old');
  const r = runRestore(tier, { pgdata, fetch: 'good' }); // the file's existing per-tier runner
  expect(r.status).toBe(0);
  for (const f of ['.vc-reseed', '.vc-reseed-ready']) expect(existsSync(join(pgdata, f))).toBe(false);
});
```

- [ ] Run red. Implement the swap block (after B3's intent apply, before `exec db-entrypoint.sh`):

```sh
# Pending in-place reseed (src/lib/deploy/replication.js reseedStandbyInPlace).
# A swap STARTS only on a standby (VC_WALG_ROLE_INTENT=standby) whose staged
# tree proves itself and carries the ready marker's attempt id. One already
# under way always finishes or rolls back: half way is no bootable tree.
R_STAGE="$PGDATA/.vc-reseed"; R_READY="$PGDATA/.vc-reseed-ready"
R_MARK="$PGDATA/.vc-reseed-in-progress"; R_DONE="$PGDATA/.vc-reseeded-from"; R_DISC="$PGDATA/.vc-discard"
vc_put() { rm -f "$1.tmp"; printf '%s' "$2" > "$1.tmp"; mv -f "$1.tmp" "$1"; }
vc_cluster() { find "$PGDATA" -mindepth 1 -maxdepth 1 ! -name '.vc-*'; }
if [ -e "$R_MARK" ] || [ -e "$R_READY" ] || [ -L "$R_MARK" ] || [ -L "$R_READY" ]; then
  for f in "$R_MARK" "$R_READY" "$R_STAGE" "$R_DISC"; do
    if [ -L "$f" ]; then echo "db-guard: $f is a symlink; refusing" >&2; exit 1; fi
  done
  exec 9>"$PGDATA/.vc-restore.lock"
  flock -n 9 || { echo "db-guard: a restore holds $PGDATA/.vc-restore.lock; refusing" >&2; exit 75; }
  state="$(cat "$R_MARK" 2>/dev/null || true)"
  if [ -z "$state" ]; then
    id="$(cat "$R_READY" 2>/dev/null || true)"
    if [ "${VC_WALG_ROLE_INTENT:-}" = standby ] && [ -n "$id" ] \
      && [ "$(cat "$R_STAGE/.vc-reseed-id" 2>/dev/null || true)" = "$id" ] \
      && [ -f "$R_STAGE/PG_VERSION" ] && [ -f "$R_STAGE/standby.signal" ] \
      && grep -q '^[[:space:]]*primary_conninfo' "$R_STAGE/postgresql.auto.conf" 2>/dev/null; then
      rm -rf "$R_DISC"
      vc_put "$R_MARK" "out $id"; state="out $id"
    else
      echo "db-guard: RESEED_REFUSED: no standby intent, or the staged tree does not prove itself (attempt '${id}'); booting the existing data directory" >&2
      rm -rf "$R_STAGE"; rm -f "$R_READY"
    fi
  fi
  case "$state" in
    "out "*)
      id="${state#out }"
      if [ ! -f "$R_STAGE/PG_VERSION" ]; then
        if [ -d "$R_DISC" ]; then find "$R_DISC" -mindepth 1 -maxdepth 1 | while IFS= read -r e; do mv "$e" "$PGDATA/"; done; fi
        rmdir "$R_DISC" 2>/dev/null || true
        rm -rf "$R_STAGE"; rm -f "$R_READY" "$R_MARK"
        echo "db-guard: RESEED_ROLLED_BACK $id: staging incomplete, the previous data directory is back" >&2
        state=""
      else
        mkdir -p "$R_DISC"
        vc_cluster | while IFS= read -r e; do mv "$e" "$R_DISC/"; done
        vc_put "$R_MARK" "in $id"; state="in $id"
      fi
      ;;
  esac
  case "$state" in
    "in "*)
      id="${state#in }"
      if [ -d "$R_STAGE" ]; then
        find "$R_STAGE" -mindepth 1 -maxdepth 1 ! -name '.vc-reseed-id' | while IFS= read -r e; do mv "$e" "$PGDATA/"; done
        rm -rf "$R_STAGE"
      fi
      vc_put "$R_DONE" "$id"
      rm -f "$R_READY" "$R_MARK"
      echo "db-guard: RESEED_SWAPPED $id" >&2
      ;;
  esac
  exec 9>&-
fi
```

`flock` is busybox, already used by the restore prelude (`statefulset.yaml:180-184`). No chown here: the stage script chowns staging to postgres, and upstream's `docker_create_db_directories` (`db-entrypoint.sh:46`) fixes PGDATA ownership as root. Then the two restore-swap `rm -rf` lines; sync the ConfigMap copy.
- [ ] Run green: `pnpm vitest run tests/unit/walg tests/unit/deploy/walg-archive-script-parity.test.ts tests/unit/deploy/restore-destroy-before-verify-census.test.ts`.
- [ ] Gate and commit: `feat(db): db-guard.sh finishes an in-place reseed swap, only on a standby`

### Task C1: role census (after A1, so db-guard's writer exists)

**Files:** `tests/unit/deploy/walg-role-source-census.test.ts` (new; `compose-role-env-census.test.ts` was deleted in B7).

- [ ] Write the tests:

```ts
import { WALG_ROLE_PARSE_SH } from '../../../src/lib/deploy/walg-role.js';
const ROOTS = ['src', 'carbon/backup', 'carbon/volumes/db', 'carbon/k8s/base', 'carbon/docker-compose.yml', 'carbon/docker-compose.prod.yml', 'tests/e2e'];
const files = walk(ROOTS).filter((f) => /\.(js|ts|sh|ya?ml)$/.test(f));
const text = (f: string) => readFileSync(join(REPO, f), 'utf-8');
const code = (f: string) => text(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l));

it('nothing reads or writes a WALG_ROLE env any more', () => {
  const hits = files.flatMap((f) => code(f).filter((l) =>
    /printenv WALG_ROLE|\$\{WALG_ROLE\b|name: WALG_ROLE\b|^\s*WALG_ROLE:|set env [^\n]*WALG_ROLE|'WALG_ROLE='|grep '\^WALG_ROLE=/.test(l)).map((l) => `${f}: ${l.trim()}`));
  expect(hits).toEqual([]);
});
it('only walg-role.js and db-guard.sh (both copies) write the role file', () => {
  const writers = files.filter((f) => code(f).some((l) => l.includes('walg-role.tmp')));
  expect(writers.sort()).toEqual(['carbon/k8s/base/backup/configmap-walg.yaml', 'carbon/volumes/db/db-guard.sh', 'src/lib/deploy/walg-role.js'].sort());
});
it('every file that reads the role file carries THE parser verbatim, or renders it from walg-role.js', () => {
  const readers = files.filter((f) => /\bcat\b[^\n]*vc_walg_role_file|\bcat\b[^\n]*walg-role\b/.test(text(f)));
  for (const f of readers) {
    if (f === 'src/lib/deploy/walg-role.js') continue;
    expect(text(f), f).toContain(WALG_ROLE_PARSE_SH);
  }
  expect(readers.sort()).toEqual(['carbon/backup/tls-snapshot.sh', 'carbon/k8s/base/backup/configmap-walg.yaml', 'carbon/volumes/db/walg-env.sh', 'src/lib/deploy/walg-role.js'].sort());
});
it('host and e2e readers render the role read from walg-role.js (C6)', () => {
  for (const f of ['src/lib/deploy/bundle.js', 'src/lib/services/addon-start.js', 'tests/e2e/checks/ha-integrity.ts']) {
    expect(text(f), f).toMatch(/walgRoleReadFragment|walgRoleReadShell/);
    expect(text(f), f).not.toMatch(/\.vibecarbon-role\/walg-role[^\n]*\bcat\b|\bcat\b[^\n]*\.vibecarbon-role/);
  }
});
it('no code path rolls the db to change its role', () => {
  const hits = files.filter((f) => f.startsWith('src/')).flatMap((f) => code(f).filter((l) => /'set',\s*'env'|set env statefulset\/db/.test(l)));
  expect(hits).toEqual([]);
});
```

- [ ] Run it. Green is expected after B1-B9 and A1. If it is not, fix the stragglers in their source files. Never allowlist one.
- [ ] Gate and commit: `test(census): the wal-g role has one file, one parser, one writer module`

### Task A2: the stage script's in-place mode

**Files:**
- `src/lib/deploy/replication.js`: add exported `IN_PLACE_RESEED_DIR = '/var/lib/postgresql/data/.vc-reseed'` (C1); `RESEED_STAGING_DIR` (58) stays until A4 removes its last caller. `buildStagedBasebackupScript` (216-341) gains `inPlaceAttempt`.
- Both restore staged-tree drop lists (`statefulset.yaml:243`, `composeRestoreScript`'s `staged` step): replace the enumerated `rm -rf` with `find "$PGDATA/.vc-restore" -mindepth 1 -maxdepth 1 -name '.vc-*' -exec rm -rf {} +`, plus the two `vibecarbon-wal-gap*` names.
- Tests:
  - `tests/unit/deploy/replication-shared.test.ts`
  - `tests/unit/walg/restore-script-states.test.ts` (a base carrying `.vc-reseed*` is dropped)
  - `tests/unit/deploy/restore-destroy-before-verify-census.test.ts`
  - unchanged on purpose, and checked green: `tests/unit/failover/reseed-standby.test.ts:299`, `tests/unit/deploy/k8s-ha-repl-gateway.test.ts:447/452` (they pin `.reseed_staging`, still true until A4/A5), `tests/unit/deploy/compose-ha-wireguard.test.ts:250` (compose keeps `.reseed_staging` for good).

**Interfaces:** `buildStagedBasebackupScript({ ..., swap: false, stagingDir: IN_PLACE_RESEED_DIR, inPlaceAttempt, probeFirst })`. With `inPlaceAttempt` set, the script:
1. first removes `$PGDATA/.vc-reseed-ready`;
2. stages (the probe block when `probeFirst`; a skipped probe prints `RESEED_SKIPPED` and exits 0);
3. strips every `.vc-*` from staging;
4. writes `.vc-reseed-id`;
5. does the existing auto.conf edits and the chown;
6. writes `.vc-reseed-ready` by rename;
7. prints `RESEED_STAGED <id>`.

Its own comment block replaces the `swap:false` comment (no `pg_ctl` in the text, R4). Callers without `inPlaceAttempt` produce byte-identical output to today.

- [ ] Write the failing tests:

```ts
import { buildStagedBasebackupScript, IN_PLACE_RESEED_DIR } from '../../../src/lib/deploy/replication.js';
const base = { replPassword: 'p', primaryHost: '10.0.0.5', primaryPort: '15433', swap: false, stagingDir: IN_PLACE_RESEED_DIR, primaryConninfo: 'host=10.0.0.5', inPlaceAttempt: 'att-1' };
describe('buildStagedBasebackupScript in-place mode', () => {
  const s = buildStagedBasebackupScript(base);
  it('clears a stale ready marker before staging anything', () => {
    expect(s.indexOf('rm -f /var/lib/postgresql/data/.vc-reseed-ready')).toBeLessThan(s.indexOf('pg_basebackup'));
  });
  it('strips every .vc-* the primary carried, then stamps the attempt', () => {
    expect(s).toMatch(/find \/var\/lib\/postgresql\/data\/\.vc-reseed -mindepth 1 -maxdepth 1 -name '\.vc-\*' -exec rm -rf \{\} \+/);
    expect(s.indexOf("-name '.vc-*'")).toBeLessThan(s.indexOf('.vc-reseed-id'));
  });
  it('marks ready LAST, by rename, after chown and every staging edit', () => {
    const ready = s.indexOf('mv -f /var/lib/postgresql/data/.vc-reseed-ready.tmp /var/lib/postgresql/data/.vc-reseed-ready');
    expect(ready).toBeGreaterThan(s.lastIndexOf('chown -R postgres:postgres'));
    expect(ready).toBeGreaterThan(s.indexOf('primary_conninfo'));
    expect(s.trim().endsWith('echo "RESEED_STAGED att-1"')).toBe(true);
  });
  it('never stops postgres and never swaps in-pod', () => {
    expect(s).not.toMatch(/pg_ctl|kill |-mindepth 1 -delete/);
  });
  it('probeFirst: an unreachable primary prints RESEED_SKIPPED and stages nothing', () => {
    const p = buildStagedBasebackupScript({ ...base, probeFirst: true, probeAttempts: 1, probeDelayS: 0 });
    expect(p).toMatch(/echo RESEED_SKIPPED\nexit 0/);
    expect(p.indexOf('RESEED_SKIPPED')).toBeLessThan(p.indexOf('pg_basebackup'));
  });
  it('callers without inPlaceAttempt are byte-identical to before', () => {
    expect(buildStagedBasebackupScript({ replPassword: 'p', primaryHost: 'h', swap: true })).toMatchSnapshot();
    expect(buildStagedBasebackupScript({ replPassword: 'p', primaryHost: 'h', swap: false, stagingDir: '/var/lib/postgresql/data/.reseed_staging' })).toMatchSnapshot();
  });
});
```

Run the stage script for real against a stub `pg_basebackup` that copies a fixture tree holding `.vc-reseeded-from`, `.vc-reseed-ready` and `.vc-discard/`, with stub `pg_isready`, `chown`: staging holds none of them, and `.vc-reseed-ready` reads `att-1`.

- [ ] Take the snapshot baseline on the unmodified builder first (run the file once with only the snapshot case), then run red, implement, run green.
- [ ] Gate and commit: `feat(reseed): stage the in-place reseed under .vc-reseed, marked ready last`

### Task A3: the live-pod guard, the in-place restart, and ssh-safe remote commands

**Files:**
- `src/lib/deploy/replication.js` (new exports below)
- `src/lib/shell.js`: add `shJoin(argv)` = `argv.map(shEscape).join(' ')`; `sshArgv` (`src/lib/ssh.js:286-296`) uses it (no behaviour change)
- `tests/unit/deploy/in-place-restart.test.ts` (new), `tests/unit/lib/shell.test.ts` (or the file that tests `shEscape`)

**Interfaces:**

```js
export const DB_GUARD_PROTOCOL_MARKER = '# vc-reseed-protocol: 1';
export class DbGuardMissingError extends Error {}
/** The exec that greps the MOUNTED wrapper; one `sh -c` token. */
export const DB_GUARD_MARKER_GREP = ['sh', '-c', `grep -c '^# vc-reseed-protocol: 1$' /usr/local/bin/db-guard.sh || true`];
/** The sanctioned in-pod stop; one `sh -c` token. */
export const DB_IN_PLACE_STOP = ['sh', '-c', 'kill -INT 1'];
/**
 * Pure. From the RUNNING pod JSON, the marker grep output and the intent read.
 * @returns {{ok: true, uid: string, restartCount: number, containerID: string} | {ok: false, reason: string}}
 */
export function evaluateDbGuardSupport(podJson, markerGrepOut, intent) {}
/**
 * kubectl reads (pod JSON, the vibecarbon-db-role ConfigMap) + the marker exec.
 * Throws DbGuardMissingError naming `vibecarbon deploy <env>` (D1) when the pod
 * lacks the wrapper; throws `reseed refused: role intent is <x>` when not standby.
 * @param {(argv: string[], opts?: object) => Promise<string>} kubectl
 */
export async function assertLiveDbGuardSupportsReseed(kubectl, { envName }) {}
/**
 * The ONE sanctioned in-pod postmaster stop: DB_IN_PLACE_STOP, then a bounded
 * wait (DB_STS_BOOT_TIMEOUT_S, covers kubelet's 300s max backoff) for the SAME
 * pod uid with restartCount > before, a new containerID and Ready. A changed uid
 * is reported and handed to `recreatedWait`, never retried.
 * @returns {Promise<{inPlace: boolean, uid: string}>}
 */
export async function restartDbContainerInPlace(kubectl, { guard, recreatedWait, timeoutS, pollMs, sleep, now, log }) {}
```

- [ ] Write the failing tests:

```ts
const pod = (o: Partial<{ uid: string; command: string[] | null; rc: number; cid: string; ready: boolean; waiting: string }> = {}) => JSON.stringify({
  metadata: { uid: o.uid ?? 'u1' },
  spec: { containers: [{ name: 'db', ...(o.command === null ? {} : { command: o.command ?? ['sh', '/usr/local/bin/db-guard.sh'] }), volumeMounts: [{ name: 'wal-archive-script', mountPath: '/usr/local/bin/db-guard.sh', subPath: 'db-guard.sh' }] }] },
  status: { containerStatuses: [{ name: 'db', restartCount: o.rc ?? 0, containerID: o.cid ?? 'c1', ready: o.ready ?? true, state: o.waiting ? { waiting: { reason: o.waiting } } : { running: {} } }] },
});
const GUARD = { ok: true as const, uid: 'u1', restartCount: 0, containerID: 'c1' };

describe('evaluateDbGuardSupport', () => {
  it('ok only with the wrapper command, the protocol marker in the mounted file, and a standby intent', () => {
    expect(evaluateDbGuardSupport(pod(), '1', 'standby')).toEqual(GUARD);
    expect(evaluateDbGuardSupport(pod({ command: null }), '1', 'standby')).toMatchObject({ ok: false, reason: expect.stringMatching(/command/) });
    expect(evaluateDbGuardSupport(pod({ command: ['sh', '/usr/local/bin/other.sh'] }), '1', 'standby')).toMatchObject({ ok: false, reason: expect.stringMatching(/command/) });
    expect(evaluateDbGuardSupport(pod(), '0', 'standby')).toMatchObject({ ok: false, reason: expect.stringMatching(/protocol/) });
    expect(evaluateDbGuardSupport(pod(), '', 'standby')).toMatchObject({ ok: false });
    expect(evaluateDbGuardSupport(pod(), '1', 'primary')).toMatchObject({ ok: false, reason: expect.stringMatching(/intent/) });
  });
});

describe('restartDbContainerInPlace', () => {
  it('sends SIGINT to PID 1 only, then waits for the same pod restarted and Ready', async () => {
    const seq = [pod({ rc: 1, cid: 'c2', ready: false }), pod({ rc: 1, cid: 'c2', ready: true })];
    const argvs: string[][] = [];
    const kubectl = vi.fn(async (argv: string[]) => { argvs.push(argv); return argv.includes('exec') ? '' : (seq.shift() ?? pod({ rc: 1, cid: 'c2' })); });
    const r = await restartDbContainerInPlace(kubectl, { guard: GUARD, recreatedWait: vi.fn(), pollMs: 1, sleep: async () => {}, now: Date.now, log: () => {} });
    expect(r).toEqual({ inPlace: true, uid: 'u1' });
    const stops = argvs.filter((a) => a.includes('exec'));
    expect(stops).toHaveLength(1);
    expect(stops[0].slice(-3)).toEqual(DB_IN_PLACE_STOP);
    expect(argvs.flat().join(' ')).not.toMatch(/pg_ctl|scale|delete pod/);
  });
  it('a recreated pod (new uid) is reported and handed to the attach-watched rollout wait', async () => {
    const recreatedWait = vi.fn(async () => {});
    const log = vi.fn();
    const kubectl = vi.fn(async (argv: string[]) => (argv.includes('exec') ? '' : pod({ uid: 'u2' })));
    expect(await restartDbContainerInPlace(kubectl, { guard: GUARD, recreatedWait, pollMs: 1, sleep: async () => {}, now: Date.now, log })).toEqual({ inPlace: false, uid: 'u2' });
    expect(recreatedWait).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/recreated.*u1.*u2/));
  });
  it('a deadline names the container state, one stop, no retry', async () => {
    let t = 0;
    const kubectl = vi.fn(async (argv: string[]) => (argv.includes('exec') ? '' : pod({ rc: 1, cid: 'c2', ready: false, waiting: 'CrashLoopBackOff' })));
    await expect(restartDbContainerInPlace(kubectl, { guard: GUARD, recreatedWait: vi.fn(), timeoutS: 1, pollMs: 1, sleep: async () => { t += 600; }, now: () => t, log: () => {} })).rejects.toThrow(/CrashLoopBackOff/);
    expect(kubectl.mock.calls.filter(([a]) => a.includes('exec'))).toHaveLength(1);
  });
  it('an exec that dies because the container stopped under it is not a failure (state decides)', async () => {
    const kubectl = vi.fn(async (argv: string[]) => { if (argv.includes('exec')) throw new Error('command terminated with exit code 137'); return pod({ rc: 1, cid: 'c2' }); });
    await expect(restartDbContainerInPlace(kubectl, { guard: GUARD, recreatedWait: vi.fn(), pollMs: 1, sleep: async () => {}, now: Date.now, log: () => {} })).resolves.toMatchObject({ inPlace: true });
  });
});

describe('shJoin: remote commands survive the remote shell (C13)', () => {
  // The exact string ssh hands the remote shell, run through sh -c with a stub
  // kubectl that prints each argument it received on its own line.
  const argvSeenRemotely = (argv: string[]) => {
    const bin = mkdtempSync(join(tmpdir(), 'vc-kubectl-'));
    writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    chmodSync(join(bin, 'kubectl'), 0o755);
    return spawnSync('sh', ['-c', shJoin(['kubectl', ...argv])], { encoding: 'utf-8', env: { PATH: `${bin}:${process.env.PATH}` } }).stdout.split('\n').slice(0, -1);
  };
  it.each([
    [['exec', 'db-0', '-n', 'vibecarbon', '-c', 'db', '--', ...DB_IN_PLACE_STOP]],
    [['exec', 'db-0', '-n', 'vibecarbon', '-c', 'db', '--', ...DB_GUARD_MARKER_GREP]],
  ])('%j arrives as the same argv', (argv) => {
    expect(argvSeenRemotely(argv)).toEqual(argv);
  });
  it('a bare join(" ") would not (the bug this guards against)', () => {
    const joined = ['kubectl', 'exec', '--', ...DB_IN_PLACE_STOP].join(' ');
    expect(spawnSync('sh', ['-c', `set -- ${joined.slice('kubectl '.length)}; echo $#`], { encoding: 'utf-8' }).stdout.trim()).not.toBe('4');
  });
});
```

- [ ] Run red, implement, run green.
- [ ] Gate and commit: `feat(reseed): restart the db container in place, only behind a live-pod wrapper guard`

### Task A4: `reseedStandbyInPlace`; failover and restore migrate and check before acting

**Files:**
- `src/lib/deploy/replication.js`:
  - new `reseedStandbyInPlace`; rewrite `reseedStandbyFromPrimary` (1325-1717) on it, with `envName` added to its options (C17);
  - `recreatedWait` is built inside replication.js from `k8sDbRolloutWait` (moved here in B6, so no import cycle, C14);
  - delete what only `reseedStandbyFromPrimary` used: `RESEED_STAGING_DIR` (58), `resolvePgdataClaim` (476), `listDbPvNames` (898), `waitForPvDetach` (938), `deleteStaleDbVolumeAttachments` (1010), the stale-attach repair (1542-1629), and its recovery loop body (1630-1683, moved into a shared `waitForStandbyRecovery`).
  - Keep, because A5 still calls them (C2): `swapPgdataViaHelperPod`, `parsePgdataClaimFromPodJson`, `buildPgdataSwapPodManifest`, `PGDATA_SWAP_POD`. Keep `buildNodePgdataSwapScript` (compose, `compose/ha.js:670`) and `STALE_ATTACH_EVENT_PATTERN` (`persistentStaleAttach` uses it, 756).
- `src/failover.js`:
  - `reseedStandbyOrAbort` (334) takes `envName` and passes it at the call (366);
  - STEP 1 preflight (2149, B6 added the role-mount check): add `assertLiveDbGuardSupportsReseed` on the standby, so D1's refusal comes before the replica proof, provisioning or quiesce. When the standby is already streaming the reseed will be skipped, but the refusal still applies: D2's arm needs the same template, and the check is the one place that says so.
- `src/restore.js` `runK8sRestore` (1014): a new injected `assertStandbyReseedCapable` dep, called for k8s-ha right after `assertRestoreFits` (1056) and before `setRestoreMarker` (1067) (C11); `envName` passed to `reseedStandbyFromPrimary` (1268).
- Tests:
  - `tests/unit/failover/reseed-standby.test.ts` (rewrite the transport expectations; 299's `.reseed_staging` pin becomes `.vc-reseed`)
  - `tests/unit/restore/k8s-ha-reseed.test.ts`
  - `tests/unit/deploy/db-private-ip-required.test.ts` (signature)
  - `tests/unit/deploy/pv-detach-wait.test.ts` (delete every case but `STALE_ATTACH_EVENT_PATTERN`'s; rename the file `stale-attach-pattern.test.ts` if only those remain)
  - `tests/unit/deploy/db-attach-watch.test.ts`: remove the ALLOWED entry `replication.js#reseedStandbyFromPrimary` (it has no rollout wait any more) and recount `seen`
  - `tests/unit/failover/failover-step-order-census.test.ts` (the STEP 1 guard)

**Interfaces:**

```js
/**
 * Guard → stage (in the running standby db) → restart in place → prove the
 * swap (.vc-reseeded-from === attempt) → recovery wait → remove .vc-discard.
 * Zero attach transitions on the happy path.
 * @param {object} o
 * @param {(argv: string[], opts?: {input?: string, timeout?: number}) => Promise<string>} o.kubectl  standby cluster
 * @param {(attempt: string) => string} o.stageScript  buildStagedBasebackupScript({... inPlaceAttempt: attempt})
 * @param {string} o.envName
 * @param {number} [o.attachWatchPollMs]
 * @returns {Promise<'reseeded'|'skipped'>}  'skipped' only when the stage printed RESEED_SKIPPED
 */
export async function reseedStandbyInPlace(o) {}
```

Order inside it is load-bearing: guard first (no basebackup, nothing moved on refusal), then stage over stdin (password never in argv) expecting `RESEED_STAGED <attempt>` or `RESEED_SKIPPED`, then the restart, then `.vc-reseeded-from` (a mismatch throws "the swap did not run; the standby booted its previous data directory"), then the recovery wait, then `rm -rf $PGDATA/.vc-discard` best-effort.

- [ ] Write the failing tests. Build `runReseed(stubs)` in reseed-standby.test.ts around the real `reseedStandbyFromPrimary`, with `sshKubectl` mocked the way the file already mocks it, and `inPlaceSsh(overrides)` answering: the marker grep with `1`, the ConfigMap read with `standby`, the pod JSON with uid `u1` and restartCount 0 then 1, the stage with `RESEED_STAGED <attempt>` (the attempt read from the stage script input), `.vc-reseeded-from` with the same attempt, `pg_is_in_recovery` with `t`, `pg_control_system` with `7412345678901234567`:

```ts
describe('reseedStandbyFromPrimary (in place)', () => {
  it('never scales, never applies a helper pod, never waits for a detach', async () => {
    const calls = await runReseed(inPlaceSsh());
    const all = calls.join('\n');
    expect(all).not.toMatch(/scale|vibecarbon-pgdata-swap|volumeattachment|delete pod/);
    expect(all).toMatch(/kill -INT 1/);
  });
  it('guards BEFORE staging: an old pod refuses with the deploy hint, no pg_basebackup, no stop', async () => {
    const calls: string[] = [];
    await expect(runReseed(inPlaceSsh({ markerGrep: '0', onCall: (c) => calls.push(c) }))).rejects.toThrow(/vibecarbon deploy prod/);
    expect(calls.some((c) => c.includes('pg_basebackup'))).toBe(false);
    expect(calls.some((c) => c.includes('kill -INT'))).toBe(false);
  });
  it('a swap that did not happen fails loud, never reports reseeded', async () => {
    await expect(runReseed(inPlaceSsh({ reseededFrom: 'other' }))).rejects.toThrow(/swap did not run/);
  });
  it('still reports skipped when the stage never reached the primary (no restart)', async () => {
    const calls: string[] = [];
    await expect(runReseed(inPlaceSsh({ stageOut: 'RESEED_SKIPPED', onCall: (c) => calls.push(c) }))).resolves.toBe('skipped');
    expect(calls.some((c) => c.includes('kill -INT'))).toBe(false);
  });
  it('records the seeded system identifier exactly as before', async () => {
    const onSeeded = vi.fn();
    await runReseed(inPlaceSsh(), { onSeeded });
    expect(onSeeded).toHaveBeenCalledWith('7412345678901234567');
  });
});
```

```ts
// k8s-ha-reseed.test.ts (restore): runK8sRestore with its existing seams
it('D1/C11: a standby without in-place support is refused BEFORE the primary is touched', async () => {
  const setMarker = vi.fn();
  await expect(runK8sRestore({
    ...haRestoreArgs(),
    assertStandbyReseedCapable: async () => { throw new DbGuardMissingError('run `vibecarbon deploy prod` once'); },
    setRestoreMarker: setMarker,
  })).rejects.toThrow(/vibecarbon deploy prod/);
  expect(setMarker).not.toHaveBeenCalled();
});
```

If `setRestoreMarker` is not injectable today, add it as a seam (production default the imported one) in this task.

```ts
// failover-step-order-census.test.ts
it('k8s: the in-place guard runs at STEP 1, before the replica proof, provisioning or quiesce', async () => {
  const log: string[] = [];
  await expect(runFailoverK8s({ kubectl: async (_ip, argv) => { log.push(argv.join(' ')); return k8sReply(argv, { markerGrep: '0' }); } })).rejects.toThrow(/vibecarbon deploy/);
  expect(log.some((l) => /scale |pg_stat_wal_receiver|exec .*psql/.test(l))).toBe(false);
});
```

- [ ] Run red, implement, run green. Then `pnpm vitest run tests/unit/failover tests/unit/restore tests/unit/deploy/db-attach-watch.test.ts`.
- [ ] Gate and commit: `feat(reseed): failover and restore reseed the standby in place and refuse before acting`

### Task A5: the cold deploy migrates; the helper-pod code goes

**Files:**
- `src/lib/deploy/k8s/ha/index.js`:
  - keep `setupReplication` steps 1a-3 and the streaming fast path (658-801);
  - replace 4a-4f (825-1135) with one `reseedStandbyInPlace` call over an ssh kubectl closure built with `standbyKubectlCommand(argv)` = `shJoin(['kubectl', ...argv])` (C13), never `['kubectl', ...argv].join(' ')` (today's closure at 977);
  - keep the replicas=0 self-heal (837-882): one `--replicas=1` no-op on a healthy rig that repairs a rig an older CLI left at zero;
  - pass `probeFirst: true` with `PROBE_ATTEMPTS`/`PROBE_DELAY_S` (901-902), and keep the loud `RESEED_SKIPPED` error text (989-1000);
  - wrap `DbGuardMissingError` as "the standby db pod is not running the db-guard wrapper after this deploy's apply; check the db rollout" (R12);
  - the grep-able line (1133) becomes `k8s-ha reseed: staged=yes swapped=in-place recovery=yes (relay …, pod uid …, restart …)`;
  - drop the imports of `parsePgdataClaimFromPodJson` and `swapPgdataViaHelperPod` (35, 39).
- `src/lib/deploy/replication.js`: delete `swapPgdataViaHelperPod` (579-700), `parsePgdataClaimFromPodJson` (442), `buildPgdataSwapPodManifest` (516), `PGDATA_SWAP_POD` (421): their last caller is gone (C2).
- Tests:
  - `tests/unit/deploy/k8s-ha-repl-gateway.test.ts`: rewrite the case at 390-486 and the swap-pod cases at 577-620; the cases at 487, 509, 537 and 671 (#299's stale-attach boot test) move onto the in-place flow; `happyExec` (71-180) gains the in-place answers; 447/452's `.reseed_staging` pins become `.vc-reseed`
  - `tests/unit/deploy/replication-shared.test.ts` (326-516: delete the helper-pod cases)
  - `tests/unit/deploy/db-attach-watch.test.ts` (the standby-boot rollout wait is gone: recount `seen`)

- [ ] Write the failing tests:

```ts
it('reseeds in place: guard, stage in the running pod, SIGINT to PID 1, same pod back; never pg_ctl stop, never a volume transition', async () => {
  vi.mocked(runCommandAsync).mockClear();
  vi.mocked(runCommandAsync).mockImplementation(inPlaceExec());
  const res = await runWithFakeTimers(() => setupReplication(opts));
  expect(res.streaming).toBe(true);
  const calls = vi.mocked(runCommandAsync).mock.calls;
  const joined = calls.map(([a]) => (a as string[]).join(' '));
  const everything = calls.map(([a, o]) => `${(a as string[]).join(' ')} ${(o as { input?: string })?.input ?? ''}`).join('\n');
  expect(everything).not.toMatch(/pg_ctl stop/);
  expect(everything).not.toMatch(/--replicas=0|vibecarbon-pgdata-swap|volumeattachment/);
  const guard = joined.findIndex((c) => c.includes('vc-reseed-protocol'));
  const stage = calls.findIndex(([, o]) => (o as { input?: string })?.input?.includes('.vc-reseed-ready'));
  const stop = joined.findIndex((c) => c.includes('kill -INT 1'));
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(stage).toBeGreaterThan(guard);
  expect(stop).toBeGreaterThan(stage);
  expect(joined[stop]).toContain(`root@${opts.standbyIp}`);
});
it('the remote kubectl string keeps `sh -c <script>` as one argument (C13)', () => {
  const remote = standbyKubectlCommand(['exec', 'db-0', '-n', 'vibecarbon', '-c', 'db', '--', 'sh', '-c', 'kill -INT 1']);
  const bin = mkdtempSync(join(tmpdir(), 'vc-kubectl-'));
  writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
  chmodSync(join(bin, 'kubectl'), 0o755);
  const seen = spawnSync('sh', ['-c', remote], { encoding: 'utf-8', env: { PATH: `${bin}:${process.env.PATH}` } }).stdout.split('\n').slice(0, -1);
  expect(seen.slice(-3)).toEqual(['sh', '-c', 'kill -INT 1']);
});
it('a standby pod without the wrapper after this deploy\'s apply fails by name (R12)', async () => {
  vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ markerGrep: '0' }));
  await expect(runWithFakeTimers(() => setupReplication(opts))).rejects.toThrow(/not running the db-guard wrapper after this deploy's apply/);
});
```

`inPlaceExec()` extends `happyExec()`: it answers the marker grep with `1`, the ConfigMap read with `standby`, the pod JSON with uid `u1` and restartCount 0 then 1, the stage with `RESEED_STAGED <id>`, the `.vc-reseeded-from` read with the same id, and flips `reseeded = true` on the `kill -INT 1` call instead of on `--replicas=0`.

- [ ] Run red, implement, run green, then the full gate.
- [ ] Commit: `feat(k8s-ha): the cold deploy seeds its standby in place; the helper pod is gone`

### Task A6: census, mitigations and docs for A

**Files:**
- `tests/unit/deploy/db-in-pod-stop-census.test.ts` (new)
- `docs/mitigations.yml`: delete the site at 317-324; keep the class (`sites: []` is allowed; precedent: `provider-provisioning-slowness`) as the record `watchDbAttach` cites, and rewrite its evidence text that names `waitForPvDetach` (it is gone)
- `AGENTS.md:241` (the `StatefulSet db` bullet: command, mounts, ConfigMap keys)
- `carbon/k8s/base/db/statefulset.yaml` comments at 1-34 and 93-118

- [ ] Write the census:

```ts
const SRC = walk(['src']).filter((f) => f.endsWith('.js'));
const body = (f: string) => readFileSync(join(REPO, f), 'utf-8');
const noComments = (s: string) => s.replace(/^\s*(\/\/|\*).*$/gm, '');
it('pg_ctl stop appears nowhere in src (the RCA rule)', () => {
  expect(SRC.filter((f) => /pg_ctl[^\n]*\bstop\b/.test(noComments(body(f))))).toEqual([]);
});
it('the only in-pod stop of PID 1 is DB_IN_PLACE_STOP, spent only by restartDbContainerInPlace, called only by reseedStandbyInPlace after the guard', () => {
  expect(SRC.filter((f) => /kill -(INT|TERM|QUIT|9|KILL) 1\b/.test(noComments(body(f))))).toEqual(['src/lib/deploy/replication.js']);
  const rep = body('src/lib/deploy/replication.js');
  expect([...rep.matchAll(/DB_IN_PLACE_STOP\b/g)].length).toBe(2); // the definition and the one use
  const callers = SRC.flatMap((f) => [...noComments(body(f)).matchAll(/restartDbContainerInPlace\(/g)].map(() => f));
  expect(callers).toEqual(['src/lib/deploy/replication.js', 'src/lib/deploy/replication.js']); // definition + one call
  const fn = rep.match(/export async function reseedStandbyInPlace[\s\S]*?\n}\n/)![0];
  expect(fn.indexOf('assertLiveDbGuardSupportsReseed(')).toBeGreaterThan(-1);
  expect(fn.indexOf('assertLiveDbGuardSupportsReseed(')).toBeLessThan(fn.indexOf('restartDbContainerInPlace('));
});
it('no reseed path scales the db to zero or mounts its PVC in another pod', () => {
  for (const f of ['src/lib/deploy/replication.js', 'src/lib/deploy/k8s/ha/index.js', 'src/restore.js', 'src/failover.js']) {
    const b = noComments(body(f));
    expect(b, f).not.toMatch(/PGDATA_SWAP_POD|swapPgdataViaHelperPod|waitForPvDetach|deleteStaleDbVolumeAttachments/);
    expect(b, f).not.toMatch(/persistentVolumeClaim:\s*\{\s*claimName/);
  }
  const reseedText = ['src/lib/deploy/replication.js', 'src/lib/deploy/k8s/ha/index.js'].map((f) => noComments(body(f))).join('\n');
  expect(reseedText).not.toMatch(/--replicas=0|'--replicas=0'/);
});
```

The only `--replicas=0` left in src is the failover abort's `stopStandbyDb` (failover.js), which is not a reseed path and is out of the census' files.

- [ ] Run the mitigation census (`tests/unit/lib/mitigation-attribution-census.test.ts`); R5 requires the deleted site to leave `docs/mitigations.yml`.
- [ ] Gate and commit: `test(census): the db is stopped in-pod only behind the wrapper guard; the reseed repair is gone`

### Task A7: e2e checks prove zero transitions, without Events

**Files:** `tests/e2e/checks/ha-integrity.ts` (next to `checkPrimaryDbCreatedOnce`, 309), `tests/e2e/scenarios/_run-lifecycle.ts`, `tests/unit/e2e/ha-integrity.test.ts`, `tests/unit/e2e/hollow-pass-census.test.ts`.

Evidence is objects and files, never Events (1 h TTL, R7):
- `readDbAttachState({ ip })` reads the db-0 pod (uid, creationTimestamp, db container restartCount), the VolumeAttachment of its PV (name and creationTimestamp: a detach deletes it, a re-attach creates a new one), and `stat -c %Y $PGDATA/.vc-reseeded-from` plus its content via exec.
- `standby_db_created_once` (verify-deploy, k8s-ha, cold), read after the deploy: the standby StatefulSet is at generation 1; `.vc-reseeded-from` exists (the in-place swap ran); the pod's creationTimestamp is before the file's mtime (the swap ran inside a pod that already existed, so it was not recreated for it); the VolumeAttachment's creationTimestamp is not after the pod's creationTimestamp plus 120 s (one attach, at pod creation).
- `reseed_in_place` (verify-failover and verify-restore, when a reseed ran): `_run-lifecycle.ts` captures `readDbAttachState` on the standby right before the failover and restore steps; after, the pod uid and the VolumeAttachment name and creationTimestamp are unchanged, and `.vc-reseeded-from` changed.

- [ ] Write the failing tests:

```ts
const st = (o: Partial<{ uid: string; podAt: string; vaName: string; vaAt: string; reseededAt: number | null; reseededFrom: string | null; generation: string }>) => ({
  uid: 'u1', podAt: '2026-11-02T10:00:00Z', vaName: 'csi-abc', vaAt: '2026-11-02T10:00:20Z', reseededAt: Date.parse('2026-11-02T10:05:00Z') / 1000, reseededFrom: 'att-1', generation: '1', ...o,
});
it('standby_db_created_once passes on an in-place reseed', () => {
  expect(evaluateStandbyCreatedOnce(st({})).status).toBe('pass');
});
it.each([
  ['no swap ran', { reseededFrom: null, reseededAt: null }],
  ['the pod was created after the swap (recreated)', { podAt: '2026-11-02T10:06:00Z' }],
  ['a later re-attach', { vaAt: '2026-11-02T10:04:00Z' }],
  ['the template rolled', { generation: '2' }],
])('standby_db_created_once fails when %s', (_n, o) => {
  expect(evaluateStandbyCreatedOnce(st(o)).status).toBe('fail');
});
it('reseed_in_place: same uid and attachment across the step, new swap id', () => {
  expect(evaluateReseedInPlace(st({}), st({ reseededFrom: 'att-2' })).status).toBe('pass');
  expect(evaluateReseedInPlace(st({}), st({ uid: 'u2', reseededFrom: 'att-2' })).status).toBe('fail');
  expect(evaluateReseedInPlace(st({}), st({ vaName: 'csi-def', reseededFrom: 'att-2' })).status).toBe('fail');
  expect(evaluateReseedInPlace(st({}), st({ vaAt: '2026-11-02T11:00:00Z', reseededFrom: 'att-2' })).status).toBe('fail');
});
```

Register both checks in hollow-pass-census with their no-handle cases (497-512 is the pattern).
- [ ] Run red, implement, run green.
- [ ] Gate and commit: `test(e2e): k8s-ha reseeds prove the standby db volume never re-attached`

---

## Task X1: one release, one roll (D6)

- [ ] Pin, in `k8s-db-statefulset.test.ts`, the db container's `command`, `volumeMounts` (`mountPath` list, in order) and `env` names (in order), so the template changes exactly once between `main` and this branch: the command, two mounts, the env swap, and the ConfigMap sha.
- [ ] Confirm the warm-redeploy pins still hold (no template diff between two deploys of this branch): `tests/unit/deploy/no-warm-primary-restart-census.test.ts`, and `primary_db_created_once`.
- [ ] Gate and commit: `test(k8s): pin the db pod template this release ships`

## Task X2: the PR body Compatibility note

- Existing k8s and k8s-ha clusters: the first deploy with this CLI restarts each db once (a new pod template), under `watchDbAttach`, and writes the role ConfigMap and file.
- Existing compose and compose-ha servers: the first deploy recreates db once. The `.env` `WALG_ROLE` line is no longer read or written; one left in place is inert.
- Projects must run `vibecarbon upgrade` before deploying; the deploy refuses and says so (B9).
- A failover or restore on a k8s-ha cluster not redeployed since this release refuses at its preflight, before anything changes, with the deploy hint (D1, C11). That includes a failover whose standby does not mount the role dir (C18).
- vibecarbon-web is unaffected. It runs `vibecarbon@0.49.0` with its own template.

---

## Verification (real infrastructure)

Use the `running-e2e-matrix` skill. Run on a clean checkout of the branch, never a worktree that may host a live run.

| scenario | command | proves |
| --- | --- | --- |
| DO k8s-ha cold deploy | `pnpm test:e2e:batch -- --provider digitalocean --scenario digitalocean/k8s-ha --skip-steps failover,verify-failover,failback,verify-failback,restore,verify-restore` | A: `standby_db_created_once` and `primary_db_created_once`; the log carries `k8s-ha reseed: staged=yes swapped=in-place`; perf slices drop `reseed.swap` and `reseed.standbyBoot`. B: the role file reads `primary`/`standby` on the two clusters, `vibecarbon-db-role` holds the same, and the deploy audit passes |
| Hetzner k8s-ha cold deploy | same, with `--provider hetzner --scenario hetzner/k8s-ha` | the same on csi.hetzner.cloud (parity rule, docs/tests.md) |
| DO k8s-ha failover | `--scenario digitalocean/k8s-ha` (full lifecycle) | B: `promoted_db_not_recreated`, `promotion_history_archived`; `old_primary_disarmed` with intent and file both `standby`; no `rollout status statefulset/db` in the failover log. A, if the pre-promotion reseed ran: `reseed_in_place` |
| DO k8s-ha failback | same run | A: the ex-primary's reseed is in place; `ls -a $PGDATA` on both sides shows only the expected `.vc-reseeded-from` (Review Focus 1). B: roles back to the original sides, with no db restart |
| DO k8s-ha restore | same run | A: the standby's restore reseed is in place (`reseed_in_place`). B: the restored primary keeps `primary`; `backup-evidence` shows a pushed base on the restored lineage |
| Hetzner k8s-ha failover, failback, restore | `--provider hetzner --scenario hetzner/k8s-ha` | the same on Hetzner |
| compose-ha failover (Hetzner, then DO) | `--scenario hetzner/compose-ha`, then `--scenario digitalocean/compose-ha` | B: no `up -d --no-deps db` in the failover log; `promotion_history_archived`; standby-scale holds the add-ons at 0 from the role file; `tls-snapshot` skips on the standby with `wal-g role is standby` |
| compose-ha scale (standby replacement) | `--scenario hetzner/compose-ha` with the scale step | C10: the replacement standby has `.vibecarbon-role/walg-role` = `standby` before its first `up`; its add-ons stay at 0 |
| one-roll migration (manual, once) | deploy a k8s-ha rig with `main`, then deploy it with this branch, `--keep` | exactly one db restart per cluster (uid changes once, one new VolumeAttachment), `watchDbAttach` stays quiet; then a failover on that rig succeeds with no restart. Before the second deploy, a failover on the `main`-deployed rig with this branch refuses at STEP 1 with the deploy hint (C18) |

Real-infra behaviour to read off the kept rig at least once (Review Focus 4):
- On a kubelet restart, `kubectl get pod db-0 -o jsonpath='{.status.containerStatuses[0].restartCount}'` increments and the uid does not change.
- After applying `vibecarbon-db-role` with `standby` and running `kubectl exec db-0 -c db -- sh -c 'kill -INT 1'`, the file reads `standby`: env from a ConfigMap key is re-resolved on a container restart.
- The time from SIGINT to Ready, for the perf baseline.
