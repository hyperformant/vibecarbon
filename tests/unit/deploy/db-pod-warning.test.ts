/**
 * Both db waits name the db pod's newest Warning event when they give up,
 * through one helper (src/lib/deploy/k8s/db-pod-warning.js):
 *   - awaitDbRollout, through summarizeDbPods (its tests are in
 *     k8s-db-statefulset.test.ts, which mocks spawn for it);
 *   - awaitDbPodReady, the wait of a deploy whose apply was skipped (here,
 *     through its exec seam).
 * And the census: no other code writes the clause, which
 * tests/e2e/utils/classify-failure.ts masks by its exact shape.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DB_POD_WARNING_READ_MS,
  dbPodWarningEventsArgs,
  podWarningClause,
} from '../../../src/lib/deploy/k8s/db-pod-warning.js';
import { summarizeDbPods } from '../../../src/lib/deploy/k8s/k3s.js';
import { awaitDbPodReady } from '../../../src/lib/deploy/k8s/readiness.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import {
  DB_POD_UID,
  FAILED_ATTACH_MESSAGE,
  failedAttachEvent,
} from '../../_shared/vultr-failed-attach-event.js';

const env = { KUBECONFIG: '/tmp/fake-kubeconfig' } as NodeJS.ProcessEnv;
const eventsOf = (...items: unknown[]) => JSON.stringify({ kind: 'List', items });

/** db-0 as `kubectl get pod db-0 -o json` shows it, its Ready condition `ready`. */
const dbPod = (ready: { status: string; reason?: string } | null, uid = DB_POD_UID) =>
  JSON.stringify({
    metadata: { name: 'db-0', uid },
    status: {
      phase: 'Pending',
      conditions: ready ? [{ type: 'Ready', ...ready }] : [],
    },
  });
const NOT_READY = { status: 'False', reason: 'ContainersNotReady' };

type Call = { argv: string[]; opts: { timeout?: number } };

/**
 * Run awaitDbPodReady over a 3 s budget against a cluster that answers the
 * pod read with `pod` and the events read with `events` (a function throws,
 * as a failed kubectl does). Resolves to the error message, or '' on success.
 */
async function giveUp(pod: () => string, events: () => string = () => eventsOf()) {
  const calls: Call[] = [];
  let t = 0;
  const exec = async (argv: string[], opts: { timeout?: number }) => {
    calls.push({ argv, opts });
    return argv.includes('events') ? events() : pod();
  };
  const err = await awaitDbPodReady({
    env,
    exec,
    budgetMs: 3_000,
    sleep: async () => {
      t += 1_000;
    },
    nowFn: () => t,
  }).catch((e: Error) => e);
  const eventReads = calls.filter((c) => c.argv.includes('events'));
  return { message: err instanceof Error ? err.message : '', eventReads };
}

const TODAY =
  'db pod Ready (db-0) did not become serving within 3s. Last error: db-0 is not Ready (ContainersNotReady)';

describe('a skipped apply that gives up on the db pod names its last warning', () => {
  it('quotes the real FailedAttachVolume event of perf run 45940611622, from one bounded read', async () => {
    const { message, eventReads } = await giveUp(
      () => dbPod(NOT_READY),
      () => eventsOf(failedAttachEvent()),
    );
    expect(message).toBe(
      'db pod Ready (db-0) did not become serving within 3s. Last error: db-0 is not Ready ' +
        `(ContainersNotReady; last warning FailedAttachVolume: ${FAILED_ATTACH_MESSAGE})`,
    );
    expect(eventReads.map((c) => c.argv)).toEqual([dbPodWarningEventsArgs()]);
    expect(eventReads[0].opts.timeout).toBe(DB_POD_WARNING_READ_MS);
    expect(dbPodWarningEventsArgs()).toContain('--request-timeout=10s');
  });

  it('an unscheduled pod (no Ready condition yet) gets the clause after its state', async () => {
    const { message } = await giveUp(
      () => dbPod(null),
      () => eventsOf(failedAttachEvent({ reason: 'FailedScheduling', message: '0/3 nodes.' })),
    );
    expect(message).toMatch(
      /Last error: db-0 is not Ready \(no status; last warning FailedScheduling: 0\/3 nodes\.\)$/,
    );
  });

  it('no warning, an empty or unreadable answer, a failed read, or a replaced pod warning: today message, after one read', async () => {
    for (const events of [
      () => eventsOf(),
      () => '',
      () => 'error: not json',
      () => {
        throw new Error('Command failed: kubectl get events\nerror: the server timed out');
      },
      () => eventsOf(failedAttachEvent({ involvedObject: { name: 'db-0', uid: 'uid-before' } })),
    ]) {
      const { message, eventReads } = await giveUp(() => dbPod(NOT_READY), events);
      expect(message).toBe(TODAY);
      expect(eventReads).toHaveLength(1);
    }
  });

  it('a Ready pod, or a pod the API never answered for, reads no events', async () => {
    const ready = await giveUp(() => dbPod({ status: 'True' }));
    expect(ready.message).toBe('');
    expect(ready.eventReads).toEqual([]);
    const unread = await giveUp(() => {
      throw new Error('Error from server (NotFound): pods "db-0" not found');
    });
    expect(unread.message).toBe(
      'db pod Ready (db-0) did not become serving within 3s. Last error: ' +
        'Error from server (NotFound): pods "db-0" not found',
    );
    expect(unread.eventReads).toEqual([]);
  });
});

describe('both db waits write the clause through one helper', () => {
  const hostile = {
    reason: 'Failed\u001b[2KMount',
    message: `line\none (x15) \u202eevil ${'y'.repeat(400)}`,
  };

  it('the same warning reads the same in both waits, exactly as podWarningClause writes it', async () => {
    for (const warning of [
      { reason: 'FailedAttachVolume', message: FAILED_ATTACH_MESSAGE },
      hostile,
    ]) {
      const clause = podWarningClause(warning);
      expect(clause.startsWith('; last warning ')).toBe(true);
      const rollout = summarizeDbPods(
        `db-0   Pending   <none>   ${DB_POD_UID}\n`,
        new Map([['db-0', warning]]),
      );
      expect(rollout).toBe(`The db pod never became Ready: db-0 (Pending${clause}).`);
      const { message } = await giveUp(
        () => dbPod(NOT_READY),
        () => eventsOf(failedAttachEvent(warning)),
      );
      expect(message).toBe(
        `db pod Ready (db-0) did not become serving within 3s. Last error: db-0 is not Ready (ContainersNotReady${clause})`,
      );
    }
    expect(podWarningClause(undefined)).toBe('');
  });

  // A string literal that spells the clause, outside comments: code that
  // writes it. Comments may name it.
  const spellsClause = (src: string) =>
    /['"`][^'"`\n]*last warning/.test(src.replace(/^\s*(\/\/|\*).*$/gm, ''));

  it('no other source writes the clause, and both waits call the helper', () => {
    const writers = sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] })
      .filter((f) => spellsClause(readFileSync(f, 'utf-8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(writers).toEqual(['src/lib/deploy/k8s/db-pod-warning.js']);

    const body = (file: string, start: string) => {
      const src = readRepoFile(file);
      const from = src.indexOf(start);
      expect(from, `${file}: ${start}`).toBeGreaterThan(-1);
      const to = src.indexOf('\n/**', from);
      return src.slice(from, to === -1 ? undefined : to);
    };
    const k3s = 'src/lib/deploy/k8s/k3s.js';
    const readiness = 'src/lib/deploy/k8s/readiness.js';
    expect(body(k3s, 'export function summarizeDbPods(')).toContain('podWarningClause(');
    expect(body(k3s, 'async function describeDbPods(')).toContain('readDbPodWarnings(');
    const ready = body(readiness, 'export async function awaitDbPodReady(');
    expect(ready).toContain('podWarningClause(');
    expect(ready).toContain('readDbPodWarnings(');
  });

  it('the census sees a spelled clause, and not one a comment names (controls)', () => {
    expect(spellsClause("const clause = '; last warning ' + reason;\n")).toBe(true);
    expect(spellsClause('  // the last warning clause\n   * last warning, in a doc\n')).toBe(false);
  });
});
