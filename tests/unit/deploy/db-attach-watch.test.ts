/**
 * watchDbAttach: every db rollout wait that re-attaches the db volume runs
 * under it, so a stale volume attachment (docs/mitigations.yml
 * do-csi-stale-volumeattachment) fails the wait early and by name instead of
 * burning the whole budget (DO e2e 2026-11-01: 600s of the same mkfs event).
 *
 * Pinned here:
 *   - only the CURRENT db-0's events count (selected by its uid, read from
 *     the cluster each poll), so a recovery redeploy never trips on the
 *     events an earlier, replaced db-0 left behind;
 *   - every timestamp compared comes from the cluster, none from this
 *     machine's clock;
 *   - a hung read can never hang the wait: each read gets the stop signal
 *     and a bounded timeout, and kubectl a --request-timeout;
 *   - the signature is the missing-device one, not any formatting failure.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  persistentStaleAttach,
  StaleVolumeAttachmentError,
  watchDbAttach,
} from '../../../src/lib/deploy/replication.js';

const VOL = 'pvc-a769b72d-05d6-451d-adbe-c05698766f80';
const MKFS_MISSING =
  `MountVolume.MountDevice failed for volume "${VOL}" : rpc error: code = Internal desc = ` +
  `formatting disk failed: exit status 1 cmd: 'mkfs.ext4 -F /dev/disk/by-id/scsi-0DO_Volume_${VOL}' ` +
  `output: "mke2fs 1.46.6 (1-Feb-2023)\\nThe file /dev/disk/by-id/scsi-0DO_Volume_${VOL} does not ` +
  'exist and no size was specified.\\n"';

// biome-ignore lint/suspicious/noExplicitAny: event fixtures
type Ev = any;
const failedMount = (
  uid: string,
  first: string,
  last: string,
  count: number,
  message = MKFS_MISSING,
): Ev => ({
  involvedObject: { kind: 'Pod', name: 'db-0', uid },
  reason: 'FailedMount',
  message,
  count,
  firstTimestamp: first,
  lastTimestamp: last,
});

/**
 * A fake cluster: the current db-0 and every event ever recorded for any
 * db-0. The reader applies the field selector the way the apiserver does,
 * so a watcher that selected by name would see the old pod's events.
 */
function fakeCluster({ uid, events }: { uid: string | null; events: Ev[] }) {
  const reads: { argv: string[]; opts: { signal?: AbortSignal; timeout?: number } }[] = [];
  const kubectl = async (argv: string[], opts: { signal?: AbortSignal; timeout?: number } = {}) => {
    reads.push({ argv, opts });
    if (argv.includes('pod')) {
      if (!uid) throw new Error('pods "db-0" not found');
      return JSON.stringify({ metadata: { name: 'db-0', uid } });
    }
    const sel = argv[argv.indexOf('--field-selector') + 1] ?? '';
    const items = events.filter((e) =>
      sel.split(',').every((term) => {
        const [k, v] = term.split('=');
        if (k === 'involvedObject.uid') return e.involvedObject.uid === v;
        if (k === 'involvedObject.name') return e.involvedObject.name === v;
        return true;
      }),
    );
    return JSON.stringify({ items });
  };
  return { kubectl, reads };
}

/** A rollout wait that only ends when aborted, or when `finish` is called. */
function rollout() {
  let finish: () => void = () => {};
  let abortedWith: AbortSignal | null = null;
  const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => {
        abortedWith = signal;
        reject(new Error('aborted'));
      });
    });
  return { wait, finish: () => finish(), aborted: () => abortedWith !== null };
}

describe('persistentStaleAttach', () => {
  it('names the volume once the missing-device signature has held two minutes', () => {
    expect(
      persistentStaleAttach(
        JSON.stringify({
          items: [failedMount('u1', '2026-11-01T16:07:07Z', '2026-11-01T16:15:22Z', 12)],
        }),
      ),
    ).toEqual({ volume: VOL, count: 12, persistedS: 495 });
  });

  it('a short first miss is not the stale state', () => {
    expect(
      persistentStaleAttach(
        JSON.stringify({
          items: [failedMount('u1', '2026-11-01T16:16:00Z', '2026-11-01T16:16:08Z', 4)],
        }),
      ),
    ).toBeNull();
  });

  it('a formatting failure on a device that EXISTS is not this state', () => {
    const exists =
      'MountVolume.MountDevice failed for volume "pvc-x" : rpc error: formatting disk failed: ' +
      'exit status 1 cmd: mkfs.ext4 output: "mke2fs: Device or resource busy"';
    expect(
      persistentStaleAttach(
        JSON.stringify({
          items: [failedMount('u1', '2026-11-01T16:05:00Z', '2026-11-01T16:16:00Z', 9, exists)],
        }),
      ),
    ).toBeNull();
  });

  it('reads the events.k8s.io shape (eventTime + series)', () => {
    const hit = persistentStaleAttach(
      JSON.stringify({
        items: [
          {
            reason: 'FailedMount',
            message: MKFS_MISSING,
            eventTime: '2026-11-01T16:10:00.000000Z',
            series: { count: 7, lastObservedTime: '2026-11-01T16:16:30.000000Z' },
          },
        ],
      }),
    );
    expect(hit).toEqual({ volume: VOL, count: 7, persistedS: 390 });
  });

  it('unreadable output is no evidence', () => {
    expect(persistentStaleAttach('not json')).toBeNull();
  });
});

describe('watchDbAttach', () => {
  it('stops the wait on the CURRENT pod in the stale state, by name', async () => {
    const cluster = fakeCluster({
      uid: 'new-uid',
      events: [failedMount('new-uid', '2026-11-01T16:07:07Z', '2026-11-01T16:15:22Z', 12)],
    });
    const r = rollout();
    const err = await watchDbAttach(r.wait, { kubectl: cluster.kubectl, pollMs: 1 }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(StaleVolumeAttachmentError);
    expect(r.aborted()).toBe(true);
    const msg = (err as Error).message;
    expect(msg).toContain(VOL);
    expect(msg).toMatch(/stale volume attachment/i);
    expect(msg).toMatch(/volumeattachment/i);
    expect(msg).not.toContain('—');
    // The events read is scoped to the pod's uid.
    const evRead = cluster.reads.find((x) => x.argv.includes('events'));
    expect(evRead?.argv).toContain('involvedObject.uid=new-uid');
  });

  it('a recovery redeploy does not trip on the events an earlier db-0 left', async () => {
    // The previous db-0 sat in the stale state for ten minutes; the operator
    // cleared the attachment and redeployed. The new db-0 has no events yet.
    const cluster = fakeCluster({
      uid: 'new-uid',
      events: [failedMount('old-uid', '2026-11-01T16:07:07Z', '2026-11-01T16:17:00Z', 13)],
    });
    const r = rollout();
    const done = watchDbAttach(r.wait, { kubectl: cluster.kubectl, pollMs: 1 });
    // Let several polls run against the old events, then finish the rollout.
    await new Promise((res) => setTimeout(res, 30));
    expect(cluster.reads.filter((x) => x.argv.includes('events')).length).toBeGreaterThan(1);
    r.finish();
    await expect(done).resolves.toBeUndefined();
    expect(r.aborted()).toBe(false);
  });

  it('keeps waiting while the pod does not exist yet or the reads fail', async () => {
    const cluster = fakeCluster({ uid: null, events: [] });
    const r = rollout();
    const done = watchDbAttach(r.wait, { kubectl: cluster.kubectl, pollMs: 1 });
    await new Promise((res) => setTimeout(res, 20));
    r.finish();
    await expect(done).resolves.toBeUndefined();
  });

  it('a hung read never hangs the wait, and every read is bounded', async () => {
    const signals: AbortSignal[] = [];
    let readStarted = false;
    const kubectl = (argv: string[], opts: { signal?: AbortSignal; timeout?: number } = {}) => {
      readStarted = true;
      expect(argv).toContain('--request-timeout=20s');
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(30_000);
      if (opts.signal) signals.push(opts.signal);
      return new Promise<string>(() => {}); // never answers
    };
    const r = rollout();
    const done = watchDbAttach(r.wait, { kubectl, pollMs: 1 });
    await new Promise((res) => setTimeout(res, 20));
    expect(readStarted).toBe(true);
    r.finish();
    const t0 = Date.now();
    await expect(done).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
    // The in-flight read was told to stop.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('a rollout failure without the signature is rethrown untouched', async () => {
    const cluster = fakeCluster({ uid: 'u', events: [] });
    const boom = new Error('timed out waiting for the condition');
    await expect(
      watchDbAttach(async () => Promise.reject(boom), { kubectl: cluster.kubectl, pollMs: 1 }),
    ).rejects.toBe(boom);
  });
});

describe('k8sDbRolloutWait: the failover WALG_ROLE rolls run under the watch', () => {
  it('stops a roll whose re-attach went stale, on that cluster, by name', async () => {
    const { k8sDbRolloutWait } = await import('../../../src/lib/deploy/walg-role.js');
    const cluster = fakeCluster({
      uid: 'promoted-uid',
      events: [failedMount('promoted-uid', '2026-11-01T16:07:07Z', '2026-11-01T16:15:22Z', 12)],
    });
    const ips: string[] = [];
    const kubectl = (
      ip: string,
      argv: string[],
      opts: { signal?: AbortSignal; timeout?: number } = {},
    ) => {
      ips.push(ip);
      if (argv.includes('rollout')) {
        expect(argv).toContain('statefulset/db');
        expect(opts.timeout).toBe((600 + 30) * 1000);
        return new Promise<string>((_r, reject) =>
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }
      return cluster.kubectl(argv, opts);
    };
    await expect(k8sDbRolloutWait({ kubectl, ip: '10.0.0.9', pollMs: 1 })).rejects.toBeInstanceOf(
      StaleVolumeAttachmentError,
    );
    expect(new Set(ips)).toEqual(new Set(['10.0.0.9']));
  });
});

describe('db-rollout-wait census: no db roll waited on outside the watch', () => {
  const ROOT = join(__dirname, '../../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) ? [p] : [];
    });

  it('k8sDbRolloutStatusArgv is only spent inside k8sDbRolloutWait', () => {
    const users = walk(join(ROOT, 'src'))
      .filter((f) => !f.endsWith('walg-role.js'))
      .filter((f) => /k8sDbRolloutStatusArgv\(/.test(readFileSync(f, 'utf-8')));
    expect(users).toEqual([]);
  });

  it('every remote `rollout status statefulset/<db>` in src runs inside watchDbAttach', () => {
    let seen = 0;
    for (const f of walk(join(ROOT, 'src'))) {
      const src = readFileSync(f, 'utf-8');
      const re = /rollout status statefulset\/\$\{(dbSts|DB_STATEFULSET)\}/g;
      for (const m of src.matchAll(re)) {
        const before = src.slice(Math.max(0, (m.index ?? 0) - 600), m.index);
        expect(before, `${f}: a db rollout wait outside watchDbAttach`).toMatch(/watchDbAttach\(/);
        seen += 1;
      }
    }
    // Positive control: the deploy-side reseed's standby boot is one.
    expect(seen).toBeGreaterThanOrEqual(1);
  });
});
