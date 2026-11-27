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
 *   - the signature is the missing-device one, not any formatting failure;
 *   - the second signature, a refusal to attach that the provider class
 *     declares permanent (ATTACH_REFUSALS_PERMANENT, only measured wordings:
 *     Vultr runs 45940611622 and 45966805225), stops the wait once it has
 *     held two minutes, and a wording not on the list never does;
 *   - every db rollout wait is handed its provider's refusal list (census).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  attachRefusalsOf,
  persistentAttachRefusal,
  persistentStaleAttach,
  StaleVolumeAttachmentError,
  VolumeAttachRefusedError,
  watchDbAttach,
} from '../../../src/lib/deploy/replication.js';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { type AstNode, calleeName, isFunctionNode, walkAst } from '../../_shared/ast-walk.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';
import {
  DB_POD_UID,
  FAILED_ATTACH_MESSAGE,
  failedAttachEvent,
} from '../../_shared/vultr-failed-attach-event.js';

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

describe('k8sDbRolloutWait: a remote db roll runs under the watch', () => {
  it('waits on the db StatefulSet with the budget it is given', async () => {
    const { k8sDbRolloutStatusArgv } = await import('../../../src/lib/deploy/replication.js');
    expect(k8sDbRolloutStatusArgv(300)).toEqual([
      '-n',
      'vibecarbon',
      'rollout',
      'status',
      'statefulset/db',
      '--timeout=300s',
    ]);
    expect(k8sDbRolloutStatusArgv().at(-1)).toBe('--timeout=600s');
  });

  it('stops a roll whose re-attach went stale, on that cluster, by name', async () => {
    const { k8sDbRolloutWait } = await import('../../../src/lib/deploy/replication.js');
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
  // Both spellings of a db rollout wait: one remote command string, or an
  // argv array ('rollout', 'status', `statefulset/${DB_STATEFULSET}`), with
  // any quote style and whitespace between the tokens.
  const Q = `['"\`]`;
  const DB = String.raw`statefulset/\$\{(?:dbSts|DB_STATEFULSET)\}`;
  const DB_ROLLOUT_WAIT = new RegExp(
    String.raw`rollout\s+status\s+${DB}|${Q}rollout${Q}\s*,\s*${Q}status${Q}\s*,\s*${Q}${DB}${Q}`,
    'g',
  );

  // Explicit exceptions, by file and enclosing function. Each must say why.
  const ALLOWED = new Map<string, string>([
    // The argv builder itself; the census above keeps it spent only inside
    // k8sDbRolloutWait, which runs it under watchDbAttach.
    ['replication.js#k8sDbRolloutStatusArgv', 'builder for k8sDbRolloutWait'],
  ]);

  /** File + enclosing named function of `index` in `src`. */
  const siteOf = (file: string, src: string, index: number) => {
    const fns = [
      ...src.slice(0, index).matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)/g),
    ];
    return `${file.split('/').pop()}#${fns.at(-1)?.[1] ?? '(top level)'}`;
  };

  it('k8sDbRolloutStatusArgv is only spent inside k8sDbRolloutWait', () => {
    let sites = 0;
    for (const f of sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] })) {
      const src = readFileSync(f, 'utf-8');
      for (const m of src.matchAll(/k8sDbRolloutStatusArgv\(/g)) {
        // The site of the match's END, so the definition itself reads as
        // replication.js#k8sDbRolloutStatusArgv.
        const site = siteOf(f, src, (m.index ?? 0) + m[0].length);
        expect(
          ['replication.js#k8sDbRolloutWait', 'replication.js#k8sDbRolloutStatusArgv'],
          site,
        ).toContain(site);
        sites += 1;
      }
    }
    // The definition and its one call.
    expect(sites).toBe(2);
  });

  /** Every db rollout wait in `src` that is neither inside watchDbAttach nor allowlisted. */
  const unwatched = (file: string, src: string) => {
    const out: string[] = [];
    for (const m of src.matchAll(DB_ROLLOUT_WAIT)) {
      const index = m.index ?? 0;
      const site = siteOf(file, src, index);
      if (ALLOWED.has(site)) continue;
      const before = src.slice(Math.max(0, index - 600), index);
      if (!/watchDbAttach\(/.test(before)) out.push(site);
    }
    return out;
  };

  it('the matcher sees both spellings (it cannot go blind to an argv-form wait)', () => {
    // Source text under test: the `$` + `{` split keeps the placeholder literal.
    const stringForm =
      'function a() { run(`kubectl rollout status statefulset/$' +
      '{DB_STATEFULSET} -n vibecarbon`); }';
    const argvForm = `async function b() {
      await sshKubectl(ip, key, [
        "rollout",
        'status',
        \`statefulset/\${dbSts}\`,
      ]);
    }`;
    expect(unwatched('src/x.js', stringForm)).toEqual(['x.js#a']);
    expect(unwatched('src/y.js', argvForm)).toEqual(['y.js#b']);
    const watched = `function c() { return watchDbAttach((signal) => k(['rollout', 'status', \`statefulset/\${DB_STATEFULSET}\`])); }`;
    expect(unwatched('src/z.js', watched)).toEqual([]);
  });

  it('every db rollout wait in src runs inside watchDbAttach (or is an explained exception)', () => {
    let seen = 0;
    const offenders: string[] = [];
    for (const f of sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] })) {
      const src = readFileSync(f, 'utf-8');
      seen += [...src.matchAll(DB_ROLLOUT_WAIT)].length;
      offenders.push(...unwatched(f, src));
    }
    expect(offenders, 'db rollout wait(s) outside watchDbAttach').toEqual([]);
    // Positive control, four sites: k3s.js awaitDbRollout (its argv and its
    // description), replication.js's k8sDbRolloutStatusArgv builder, and
    // restore.js's db rollout. Every k8s reseed (the cold deploy, failover,
    // restore) restarts the db in place and waits through k8sDbRolloutWait
    // only when the pod was recreated. No WALG_ROLE roll is left to wait on.
    expect(seen).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// The second signature: the provider refused the attach, and it held
// ---------------------------------------------------------------------------

/**
 * The FailedAttachVolume message of run 45966805225 (vultr/k8s restore-deploy,
 * 2026-11-27, fresh vc2-4c-8gb in ewr), `x15 over 15m`. The shared fixture is
 * run 45940611622's. Every pattern a provider declares permanent must match
 * one of its measured messages (MEASURED below).
 */
const RUN_45966805225_MESSAGE =
  'AttachVolume.Attach failed for volume "pvc-d77e8ece45b54f59" : rpc error: code = Internal ' +
  'desc = ControllerPublishVolume: cannot attach volume to node: storage handler unable to ' +
  'attach block storage : {"error":"Block storage is not compatible with this server","status":400}';

/** Each provider's measured permanent refusals, with the runs they were read in. */
const MEASURED: Record<string, { runs: string; message: string }[]> = {
  vultr: [
    { runs: '45940611622', message: FAILED_ATTACH_MESSAGE },
    { runs: '45966805225', message: RUN_45966805225_MESSAGE },
  ],
};

/** A FailedAttachVolume wording no provider declares permanent (a negative case, not a measurement). */
const NOT_ON_THE_LIST =
  'AttachVolume.Attach failed for volume "pvc-8d578e6fd25c44b0" : rpc error: code = Internal ' +
  'desc = ControllerPublishVolume: cannot attach volume to node: storage handler unable to ' +
  'attach block storage : {"error":"server is busy, try again","status":400}';

const VULTR = attachRefusalsOf(VultrProvider);
const ONE_MINUTE_IN = { lastTimestamp: '2026-11-27T05:00:20Z', count: 6 }; // held 99 s
const eventsJson = (...items: Ev[]) => JSON.stringify({ kind: 'List', items });

describe('persistentAttachRefusal', () => {
  const permanent = VultrProvider.ATTACH_REFUSALS_PERMANENT;

  it("names the volume, the count, the time held and the provider's own words once it has held two minutes", () => {
    expect(persistentAttachRefusal(eventsJson(failedAttachEvent()), { permanent })).toEqual({
      volume: 'pvc-8d578e6fd25c44b0',
      count: 15,
      persistedS: 906,
      providerMessage: 'Block storage is not compatible with this server',
    });
  });

  it('reads the events.k8s.io shape (eventTime + series)', () => {
    const series = failedAttachEvent({
      firstTimestamp: null,
      lastTimestamp: null,
      count: null,
      eventTime: '2026-11-27T04:58:41.000000Z',
      series: { count: 15, lastObservedTime: '2026-11-27T05:13:47.000000Z' },
    });
    expect(persistentAttachRefusal(eventsJson(series), { permanent })).toMatchObject({
      count: 15,
      persistedS: 906,
    });
    const young = failedAttachEvent({
      firstTimestamp: null,
      lastTimestamp: null,
      count: null,
      eventTime: '2026-11-27T04:58:41.000000Z',
      series: { count: 6, lastObservedTime: '2026-11-27T05:00:20.000000Z' },
    });
    expect(persistentAttachRefusal(eventsJson(young), { permanent })).toBeNull();
  });

  it('one refusal right after create is not the state: under two minutes is no verdict', () => {
    expect(
      persistentAttachRefusal(eventsJson(failedAttachEvent(ONE_MINUTE_IN)), { permanent }),
    ).toBeNull();
    // A single first refusal: first and last are the same instant.
    expect(
      persistentAttachRefusal(
        eventsJson(failedAttachEvent({ lastTimestamp: '2026-11-27T04:58:41Z', count: 1 })),
        { permanent },
      ),
    ).toBeNull();
  });

  it('a wording not on the list, the measured words under another reason, or an empty list: never', () => {
    expect(
      persistentAttachRefusal(eventsJson(failedAttachEvent({ message: NOT_ON_THE_LIST })), {
        permanent,
      }),
    ).toBeNull();
    expect(
      persistentAttachRefusal(eventsJson(failedAttachEvent({ reason: 'FailedMount' })), {
        permanent,
      }),
    ).toBeNull();
    expect(persistentAttachRefusal(eventsJson(failedAttachEvent()), { permanent: [] })).toBeNull();
    expect(persistentAttachRefusal(eventsJson(failedAttachEvent()))).toBeNull();
  });

  it('unreadable output is no evidence', () => {
    for (const out of ['not json', '', 'null', '{"kind":"List"}']) {
      expect(persistentAttachRefusal(out, { permanent }), out).toBeNull();
    }
  });
});

describe('ATTACH_REFUSALS_PERMANENT: only measured wordings', () => {
  it('BaseProvider declares none', () => {
    expect(BaseProvider.ATTACH_REFUSALS_PERMANENT).toEqual([]);
    expect(Object.isFrozen(BaseProvider.ATTACH_REFUSALS_PERMANENT)).toBe(true);
  });

  it("Vultr's list matches both measured refusals", () => {
    for (const { runs, message } of MEASURED.vultr) {
      expect(
        VultrProvider.ATTACH_REFUSALS_PERMANENT.some((re) => re.test(message)),
        runs,
      ).toBe(true);
    }
  });

  it('every pattern on every provider is a RegExp that matches one of its measured messages', () => {
    for (const [id, Class] of Object.entries(PROVIDERS)) {
      const list = (Class as typeof BaseProvider).ATTACH_REFUSALS_PERMANENT;
      expect(Array.isArray(list), id).toBe(true);
      expect(Object.isFrozen(list), id).toBe(true);
      const measured = MEASURED[id] ?? [];
      if (measured.length === 0) expect(list, `${id} has no measured refusal`).toEqual([]);
      for (const re of list) {
        expect(re, id).toBeInstanceOf(RegExp);
        expect(
          measured.some(({ message }) => re.test(message)),
          `${id}: ${re} matches no measured refusal`,
        ).toBe(true);
      }
    }
  });

  it('attachRefusalsOf carries the provider name and its list', () => {
    expect(VULTR).toEqual({
      provider: 'Vultr',
      permanent: VultrProvider.ATTACH_REFUSALS_PERMANENT,
    });
    class Plain extends BaseProvider {
      static NAME = 'Example Cloud';
    }
    expect(attachRefusalsOf(Plain)).toEqual({ provider: 'Example Cloud', permanent: [] });
  });
});

describe('watchDbAttach: a refusal the provider declares permanent stops the wait', () => {
  /** A cluster whose db-0 events the test changes while the watch runs. */
  function liveCluster(events: Ev[]) {
    let current = events;
    const reads: string[][] = [];
    const kubectl = async (argv: string[]) => {
      reads.push(argv);
      if (argv.includes('pod'))
        return JSON.stringify({ metadata: { name: 'db-0', uid: DB_POD_UID } });
      const sel = argv[argv.indexOf('--field-selector') + 1] ?? '';
      expect(sel).toBe(`involvedObject.uid=${DB_POD_UID}`);
      return eventsJson(...current);
    };
    const eventReads = () => reads.filter((a) => a.includes('events')).length;
    return {
      kubectl,
      eventReads,
      set: (next: Ev[]) => {
        current = next;
      },
    };
  }
  const until = async (cond: () => boolean) => {
    while (!cond()) await new Promise((res) => setTimeout(res, 1));
  };

  it('held under two minutes it keeps waiting; held over two minutes it stops, by name', async () => {
    const cluster = liveCluster([failedAttachEvent(ONE_MINUTE_IN)]);
    const r = rollout();
    const done = watchDbAttach(r.wait, {
      kubectl: cluster.kubectl,
      pollMs: 1,
      attachRefusals: VULTR,
    }).catch((e: Error) => e);
    await until(() => cluster.eventReads() >= 5);
    expect(r.aborted()).toBe(false);
    // The same refusal, now 906 s old (x15 over 15m).
    cluster.set([failedAttachEvent()]);
    const err = await done;
    expect(r.aborted()).toBe(true);
    expect(err).toBeInstanceOf(VolumeAttachRefusedError);
    expect(err).toMatchObject({
      provider: 'Vultr',
      volume: 'pvc-8d578e6fd25c44b0',
      count: 15,
      persistedS: 906,
      providerMessage: 'Block storage is not compatible with this server',
    });
    const msg = (err as Error).message;
    expect(msg).toContain(
      'Vultr refused to attach the db volume pvc-8d578e6fd25c44b0 to the database node, ' +
        '15 times over 906s, in its own words: "Block storage is not compatible with this server".',
    );
    expect(msg).toMatch(/waiting does not change that/i);
    expect(msg).toContain("Vultr's support can say why this server cannot take the volume");
    expect(msg).toMatch(/run the command that failed again/);
    expect(msg).toContain('Nothing was retried or replaced.');
    // No invented command, no em or en dash.
    expect(msg).not.toMatch(/`|vibecarbon |kubectl /);
    expect(msg).not.toMatch(/[–—]/);
  });

  it('the events.k8s.io shape stops it too', async () => {
    const cluster = liveCluster([
      failedAttachEvent({
        firstTimestamp: null,
        lastTimestamp: null,
        count: null,
        eventTime: '2026-11-27T04:58:41.000000Z',
        series: { count: 15, lastObservedTime: '2026-11-27T05:13:47.000000Z' },
      }),
    ]);
    const r = rollout();
    await expect(
      watchDbAttach(r.wait, { kubectl: cluster.kubectl, pollMs: 1, attachRefusals: VULTR }),
    ).rejects.toBeInstanceOf(VolumeAttachRefusedError);
    expect(r.aborted()).toBe(true);
  });

  /** A rollout that times out on its own once the watch has polled `polls` times. */
  const timesOutAfter = (cluster: { eventReads: () => number }, polls: number, boom: Error) => {
    let aborted = false;
    const wait = (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        const timer = setInterval(() => {
          if (cluster.eventReads() >= polls) {
            clearInterval(timer);
            reject(boom);
          }
        }, 1);
        signal.addEventListener('abort', () => {
          aborted = true;
          clearInterval(timer);
          reject(new Error('aborted'));
        });
      });
    return { wait, aborted: () => aborted };
  };

  it("a wording not on the list never stops it: the wait's own timeout is today's", async () => {
    const cluster = liveCluster([failedAttachEvent({ message: NOT_ON_THE_LIST })]);
    const boom = new Error('error: timed out waiting for the condition');
    const r = timesOutAfter(cluster, 8, boom);
    await expect(
      watchDbAttach(r.wait, { kubectl: cluster.kubectl, pollMs: 1, attachRefusals: VULTR }),
    ).rejects.toBe(boom);
    expect(r.aborted()).toBe(false);
  });

  it('a provider that declares nothing never stops on the measured words either', async () => {
    for (const attachRefusals of [undefined, { provider: 'Hetzner Cloud', permanent: [] }]) {
      const cluster = liveCluster([failedAttachEvent()]);
      const boom = new Error('error: timed out waiting for the condition');
      const r = timesOutAfter(cluster, 5, boom);
      await expect(
        watchDbAttach(r.wait, { kubectl: cluster.kubectl, pollMs: 1, attachRefusals }),
      ).rejects.toBe(boom);
      expect(r.aborted()).toBe(false);
    }
  });

  it('k8sDbRolloutWait hands the list to the watch', async () => {
    const { k8sDbRolloutWait } = await import('../../../src/lib/deploy/replication.js');
    const cluster = liveCluster([failedAttachEvent()]);
    const kubectl = (
      _ip: string,
      argv: string[],
      opts: { signal?: AbortSignal; timeout?: number } = {},
    ) => {
      if (argv.includes('rollout')) {
        return new Promise<string>((_r, reject) =>
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }
      return cluster.kubectl(argv);
    };
    await expect(
      k8sDbRolloutWait({ kubectl, ip: '10.0.0.9', pollMs: 1, attachRefusals: VULTR }),
    ).rejects.toBeInstanceOf(VolumeAttachRefusedError);
  });
});

// ---------------------------------------------------------------------------
// Census: every db rollout wait is handed its provider's refusal list
// ---------------------------------------------------------------------------

describe('attach-refusal census: every watched db wait knows its provider', () => {
  /**
   * The calls that reach watchDbAttach, directly or by handing the list on:
   * each must pass `attachRefusals`, built by attachRefusalsOf(<the provider
   * class>) where the caller knows it, or forwarded by name.
   */
  const CHAIN = new Set([
    'watchDbAttach',
    'k8sDbRolloutWait',
    'awaitDbRollout',
    'reseedStandbyInPlace',
    'reseedStandbyFromPrimary',
    'setupReplication',
    'settleK8sDb',
  ]);

  /**
   * Injected seams whose default is a CHAIN function, by file: the failover
   * calls its reseed through `reseed` (default reseedStandbyOrAbort, which
   * hands the list on to reseedStandbyFromPrimary).
   */
  const SEAMS: Record<string, Set<string>> = { 'failover.js': new Set(['reseed']) };

  /**
   * Calls in CHAIN that may go without the list, by `file:function`, each
   * with why. Empty: every caller knows its provider.
   */
  const NOT_WIRED: Record<string, string> = {};

  /**
   * The innermost NAMED function a node sits in: a declaration, or a function
   * bound to a const. An unnamed callback (a `settle: (ip) => ...` property,
   * an argument) reads as the function around it.
   */
  const enclosing = (ancestors: AstNode[]) => {
    for (let i = ancestors.length - 1; i >= 0; i -= 1) {
      const a = ancestors[i];
      if (!isFunctionNode(a)) continue;
      if (a.id?.name) return a.id.name;
      const parent = ancestors[i - 1];
      if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
    }
    return '(top level)';
  };

  /** Why a call's `attachRefusals` is missing or not a real list, or null when it is fine. */
  const findingOf = (call: AstNode): string | null => {
    const props = call.arguments
      .filter((a: AstNode) => a.type === 'ObjectExpression')
      .flatMap((o: AstNode) => o.properties)
      .filter((p: AstNode) => p.type === 'Property' && p.key?.name === 'attachRefusals');
    if (props.length === 0) return 'passes no attachRefusals';
    const v = props[0].value;
    if (v.type === 'Identifier' && v.name === 'attachRefusals') return null;
    if (v.type === 'MemberExpression' && v.property?.name === 'attachRefusals') return null;
    if (v.type === 'CallExpression' && calleeName(v) === 'attachRefusalsOf') return null;
    return 'attachRefusals is neither attachRefusalsOf(...) nor forwarded by name';
  };

  const scan = (path: string, source: string) => {
    const sites: { site: string; callee: string; finding: string | null }[] = [];
    walkAst(parseAst(source), (n, ancestors) => {
      if (n.type !== 'CallExpression') return;
      const callee = calleeName(n);
      if (!callee || !(CHAIN.has(callee) || SEAMS[path]?.has(callee))) return;
      sites.push({ site: `${path}:${enclosing(ancestors)}`, callee, finding: findingOf(n) });
    });
    return sites;
  };

  it('the census sees a call that passes nothing, and one that passes a made-up value', () => {
    const bad = scan(
      'x.js',
      'async function a() { await watchDbAttach(w, { kubectl, pollMs }); }\n' +
        'async function b() { await k8sDbRolloutWait({ kubectl, ip, attachRefusals: [] }); }\n' +
        'async function c() { await settleK8sDb({ ip, attachRefusals: attachRefusalsOf(P) }); }\n' +
        'const d = () => reseedStandbyInPlace({ kubectl, attachRefusals: options.attachRefusals });',
    );
    expect(bad).toEqual([
      { site: 'x.js:a', callee: 'watchDbAttach', finding: 'passes no attachRefusals' },
      {
        site: 'x.js:b',
        callee: 'k8sDbRolloutWait',
        finding: 'attachRefusals is neither attachRefusalsOf(...) nor forwarded by name',
      },
      { site: 'x.js:c', callee: 'settleK8sDb', finding: null },
      { site: 'x.js:d', callee: 'reseedStandbyInPlace', finding: null },
    ]);
  });

  it('every call in src passes the list, or is listed with why it cannot', () => {
    const sites = sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] }).flatMap((abs) =>
      scan(relative(join(REPO_ROOT, 'src'), abs), readFileSync(abs, 'utf-8')),
    );
    const offenders = sites
      .filter((s) => s.finding && !(s.site in NOT_WIRED))
      .map((s) => `${s.site} (${s.callee}): ${s.finding}`);
    expect(offenders).toEqual([]);
    for (const [site, why] of Object.entries(NOT_WIRED)) {
      expect(
        sites.some((s) => s.site === site && s.finding),
        `${site} is wired now; take it out`,
      ).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
    // Positive control: the deploy, restore, failover, reseed and fence
    // chains, each callee seen, and the list built where the provider is known.
    expect(new Set(sites.map((s) => s.callee))).toEqual(new Set([...CHAIN, 'reseed']));
    expect(sites.length).toBeGreaterThanOrEqual(12);
    const roots = sites.map((s) => s.site);
    for (const root of [
      'lib/deploy/k8s/k3s.js:awaitDb',
      'restore.js:runK8sRestore',
      'failover.js:reseedStandbyOrAbort',
      'failover.js:catchUpReseedAndPromote',
      'lib/deploy/effects/k8s-ha.js:haK8sConfigureReplication',
      'lib/deploy/retired-fence.js:k8sBackend',
    ]) {
      expect(roots, root).toContain(root);
    }
  });

  it("the deploy's db wait records the provider's view on a refusal: the deploy builds it, awaitDb hands it on", () => {
    const k3s = readFileSync(join(REPO_ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const handed: string[] = [];
    walkAst(parseAst(k3s), (n, ancestors) => {
      if (n.type !== 'CallExpression') return;
      const props = n.arguments
        .filter((a: AstNode) => a.type === 'ObjectExpression')
        .flatMap((o: AstNode) => o.properties);
      const prop = (name: string) =>
        props.find((p: AstNode) => p.type === 'Property' && p.key?.name === name)?.value;
      const callee = calleeName(n);
      if (
        callee === 'awaitDbRollout' &&
        prop('onAttachRefused')?.name === 'describeAttachRefusal'
      ) {
        handed.push(`${enclosing(ancestors)}:awaitDbRollout`);
      }
      if (callee === 'applyK3sManifests' && prop('describeAttachRefusal')) {
        handed.push(`${enclosing(ancestors)}:applyK3sManifests`);
      }
      if (callee === 'logAttachRefusalView')
        handed.push(`${enclosing(ancestors)}:logAttachRefusalView`);
    });
    expect(handed.sort()).toEqual(
      [
        'awaitDb:awaitDbRollout',
        'deployK3sSteps:applyK3sManifests',
        'describeAttachRefusal:logAttachRefusalView',
      ].sort(),
    );
  });
});
