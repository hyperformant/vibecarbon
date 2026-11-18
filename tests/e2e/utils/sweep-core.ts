/**
 * What the per-provider orphan sweeps (sweep-<provider>.ts) share: the
 * project-name guard, the counts and the "incomplete" flag, the outline of a
 * pass over one resource class, the volume ownership rule, the bucket pass,
 * and the closing banner.
 *
 * Each provider file keeps what is its own: which resource classes exist,
 * how each is listed, owned and deleted, the order of the passes, and its
 * protected bucket set. Nothing here knows a provider. The Hetzner sweep
 * uses the guard, the bucket pass and the banner only; its compute passes
 * are its own.
 */
import type { SweepBreakdown } from '../metrics/db.js';
import { classifyBucketDeleteError } from './bucket-already-gone.js';

/**
 * An empty or short prefix would match resources that are not ours; the
 * shortest legitimate e2e project name is `testapp-…` / `citest-…`.
 */
export function assertSweepableProjectName(cloud: string, projectName: string): void {
  if (!projectName || projectName.length < 4) {
    throw new Error(
      `[sweep] refusing to sweep ${cloud} with project name ${JSON.stringify(projectName)}`,
    );
  }
}

export interface Sweep {
  readonly tag: string;
  readonly cloud: string;
  readonly projectName: string;
  /** Resources the sweep deleted, per class. A pass increments its own. */
  readonly counts: SweepBreakdown;
  /**
   * A listing could not be read to its end: warn, and the sweep can no
   * longer say "clean".
   */
  markIncomplete(what: string): void;
  /** A delete failed (the pass prints its own line): same consequence. */
  fail(): void;
  /** What the sweep function returns. */
  result(): { counts: SweepBreakdown; enumFailed: boolean };
}

/**
 * Start a sweep: refuse an unsafe project name, print the opening line and
 * hand back the counts and the incomplete flag.
 *
 * `optionalCounts` are the classes this cloud has beyond the eight every
 * cloud reports (load balancers, app storage keys); they start at 0 so the
 * ledger records "looked, found none" and not "never looked".
 */
export function createSweep(
  tag: string,
  cloud: string,
  projectName: string,
  optionalCounts: Pick<SweepBreakdown, 'loadBalancers' | 'storageKeys'> = {},
): Sweep {
  assertSweepableProjectName(cloud, projectName);
  console.log(`${tag} Sweeping orphaned ${cloud} resources for ${projectName}...`);
  const counts: SweepBreakdown = {
    servers: 0,
    volumes: 0,
    placementGroups: 0,
    firewalls: 0,
    floatingIps: 0,
    networks: 0,
    s3Buckets: 0,
    sshKeys: 0,
    ...optionalCounts,
  };
  let enumFailed = false;
  return {
    tag,
    cloud,
    projectName,
    counts,
    markIncomplete(what: string) {
      enumFailed = true;
      console.warn(
        `${tag} [sweep] ${what} enumeration incomplete — residue past the last readable page cannot be ruled out`,
      );
    },
    fail() {
      enumFailed = true;
    },
    result: () => ({ counts, enumFailed }),
  };
}

/** One resource class of a sweep: its listing, which rows are this run's, how one is deleted. */
export interface SweepPass<T> {
  /** The listing's name in the "enumeration incomplete" line, e.g. `firewall list`. */
  listing: string;
  /** Opens the line printed when the pass ends on a throw, e.g. `Firewall cleanup failed`. */
  cleanupFailed: string;
  /** The class a delete is counted under. */
  count: keyof SweepBreakdown;
  /** Every row of the class, and whether the listing was read to its end. */
  list(): Promise<{ items: T[]; complete: boolean }>;
  /** True for a resource of this run. It may print why a near miss is left alone. */
  owned(item: T): boolean;
  /** The line that announces the delete, after the `[sweep]` marker. */
  announce(item: T): string;
  /**
   * Delete one resource and say what happened:
   *   - `true`: deleted (or the API says it is already gone), and counted;
   *   - a string: not deleted. The sweep fails and prints that line;
   *   - `null`: nothing was left to delete. Not counted, not a failure
   *     (the pass prints its own line).
   */
  remove(item: T): Promise<true | string | null>;
  /**
   * What a throw from `remove` means, which differs by class and is kept
   * as each sweep had it.
   *
   * Given: the throw stops at that one resource. The sweep fails, prints
   * `<thrown(item)>: <message>`, and the pass goes on to the next row.
   *
   * Left out: the throw ends the pass, as a throw from the listing does.
   * The listing is marked incomplete and the rows after it are not tried.
   */
  thrown?(item: T): string;
}

/**
 * One pass: list the class, delete this run's resources, count each delete
 * or fail the sweep, and mark the sweep incomplete when the listing stopped
 * early or the pass threw. What was read before a listing stopped is still
 * swept. Nothing escapes: teardown must complete.
 */
export async function sweepClass<T>(
  sweep: Pick<Sweep, 'tag' | 'counts' | 'markIncomplete' | 'fail'>,
  pass: SweepPass<T>,
): Promise<void> {
  const { tag, counts } = sweep;
  try {
    const { items, complete } = await pass.list();
    if (!complete) sweep.markIncomplete(pass.listing);
    for (const item of items) {
      if (!pass.owned(item)) continue;
      console.log(`${tag} [sweep] ${pass.announce(item)}`);
      let outcome: true | string | null;
      try {
        outcome = await pass.remove(item);
      } catch (err) {
        if (!pass.thrown) throw err;
        outcome = `${pass.thrown(item)}: ${err instanceof Error ? err.message : err}`;
      }
      if (outcome === true) counts[pass.count] = (counts[pass.count] ?? 0) + 1;
      else if (outcome !== null) {
        sweep.fail();
        console.warn(`${tag} [sweep] ${outcome}`);
      }
    }
  } catch (e) {
    sweep.markIncomplete(pass.listing);
    console.warn(`${tag} [sweep] ${pass.cleanupFailed}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * The volume rule of the four non-Hetzner sweeps. An attached volume is
 * never this pass's. An unattached one is the run's when its name starts
 * with the project name, or when it is a CSI volume whose project tag is
 * the run's. A CSI volume without that tag is reported and left: an
 * unscoped pvc sweep from a concurrent run deleted a live rig's data
 * volumes on Hetzner (2026-07-18).
 *
 * `pvcPrefix` is what each sweep reads as a CSI volume name, kept as each
 * had it: `pvc-` on DigitalOcean, `pvc` on the other three. `project` is
 * the tag value to match when the provider stores it changed (Linode
 * squeezes a tag past 50 characters); the project name otherwise.
 */
export function sweepOwnsVolume(
  sweep: Pick<Sweep, 'tag' | 'projectName'>,
  volume: { name: string; attached: boolean; projectTag: () => string | undefined },
  rule: { pvcPrefix: 'pvc-' | 'pvc'; project?: string },
): boolean {
  const { tag, projectName } = sweep;
  if (volume.attached) return false;
  const ownedByName = volume.name.startsWith(projectName);
  const isPvc = volume.name.startsWith(rule.pvcPrefix);
  const ownedByTag = isPvc && volume.projectTag() === (rule.project ?? projectName);
  if (ownedByName || ownedByTag) return true;
  if (isPvc) {
    console.warn(
      `${tag} [sweep] Unattached CSI volume ${volume.name} carries no project=${projectName} tag — ` +
        'NOT deleting (could belong to a concurrent run); review manually if it persists.',
    );
  }
  return false;
}

/** A bucket store as most sweeps already shape it (one region or cluster). */
export interface SweepBucketStore {
  /** Bucket names the store lists; null (or a throw) = unreadable. */
  listBuckets(): Promise<string[] | null>;
  emptyAndDeleteBucket(name: string): Promise<{ objectsRemoved: number }>;
  /**
   * The region holding the bucket (a HeadBucket in every region the keys
   * reach), or null when none does; throws when a region cannot tell.
   */
  locateBucket(name: string): Promise<string | null>;
}

/** A bucket as a listing showed it: its name and where it is (region or cluster, '' for none). */
interface ListedBucket {
  name: string;
  where: string;
}

/** One listing of buckets and how to act on what it lists. */
export interface SweepBucketSource {
  /** The buckets this listing shows now; null (or a throw) = unreadable. */
  listBuckets(): Promise<ListedBucket[] | null>;
  emptyAndDeleteBucket(bucket: ListedBucket): Promise<{ objectsRemoved: number }>;
  locateBucket(bucket: ListedBucket): Promise<string | null>;
  /** The listing was null or threw (`err` when it threw). */
  unreadable(err?: unknown): void;
}

/** A source over a store that has the three methods and sits in one place. */
export function bucketSource(
  store: SweepBucketStore,
  where: string,
  unreadable: (err?: unknown) => void,
): SweepBucketSource {
  return {
    async listBuckets() {
      const names = await store.listBuckets();
      return names === null ? null : names.map((name) => ({ name, where }));
    },
    async emptyAndDeleteBucket(bucket: ListedBucket) {
      return store.emptyAndDeleteBucket(bucket.name);
    },
    async locateBucket(bucket: ListedBucket) {
      return store.locateBucket(bucket.name);
    },
    unreadable,
  };
}

/**
 * The bucket pass: in each source, delete the buckets whose name starts
 * with the project name, and decide what a failed delete means.
 *
 * A bucket the sweep cannot delete fails the sweep, unless the delete said
 * "no such bucket", no region holds it, and a second read of the same
 * listing no longer shows it: a stale listing, the goal state. That decision
 * is classifyBucketDeleteError's (bucket-already-gone.ts); this is its one
 * call site for all five sweeps, and bucket-gone-census.test.ts reads it.
 *
 * `protectedNames` are never deleted, whatever prefix matches them.
 * `dedupe` skips a name an earlier source already handled (DigitalOcean,
 * where the guard against one bucket listed by two regions is kept).
 */
export async function sweepBuckets(
  sweep: Pick<Sweep, 'tag' | 'projectName' | 'counts' | 'fail'>,
  noun: string,
  sources: SweepBucketSource[],
  opts: { protectedNames?: ReadonlySet<string>; dedupe?: boolean } = {},
): Promise<void> {
  const { tag, projectName, counts } = sweep;
  const handled = new Set<string>();
  for (const source of sources) {
    let buckets: ListedBucket[] | null;
    let listErr: unknown;
    try {
      buckets = await source.listBuckets();
    } catch (err) {
      buckets = null;
      listErr = err;
    }
    if (buckets === null) {
      source.unreadable(listErr);
      continue;
    }
    for (const bucket of buckets) {
      const { name, where } = bucket;
      if (opts.dedupe && handled.has(name)) continue;
      if (opts.protectedNames?.has(name)) {
        handled.add(name);
        continue;
      }
      if (!name.startsWith(projectName)) continue;
      handled.add(name);
      console.log(`${tag} [sweep] Deleting ${noun} ${name}${where ? ` (${where})` : ''}`);
      try {
        const { objectsRemoved } = await source.emptyAndDeleteBucket(bucket);
        console.log(`${tag} [sweep]   deleted ${name} (${objectsRemoved} obj)`);
        counts.s3Buckets++;
      } catch (err) {
        const verdict = await classifyBucketDeleteError(
          err,
          name,
          () => source.locateBucket(bucket),
          async () => (await source.listBuckets())?.map((b) => b.name) ?? null,
        );
        if (verdict.gone) {
          // Stale listing: destroy already removed it, and a second listing
          // no longer shows it. Goal state, not an enumeration failure. A
          // bucket the listing still shows is never called gone: a new
          // Hetzner bucket can answer NoSuchBucket for up to 15 minutes
          // (bucketQuietMs in hetzner-s3.js) while it exists and bills.
          console.log(`${tag} [sweep]   ${name} already gone (stale listing): ${verdict.why}`);
        } else {
          sweep.fail();
          console.warn(`${tag} [sweep]   FAILED ${name}: ${verdict.why}`);
        }
      }
    }
  }
}

/**
 * The closing banner. One warn-level line with the grep-stable
 * `[sweep] REGRESSION` marker when destroy left anything, or when the sweep
 * could not look; otherwise the clean line, which names the cloud it
 * verified (until 2026-08-07 a sweep of the wrong cloud printed "clean").
 *
 * `rows` are the classes this cloud reports, in the order the breakdown
 * prints them. A class missing from `rows` is missing from the total, which
 * is how the Vultr banner once said "no orphans" after deleting a reserved
 * IP.
 */
export function reportSweep(sweep: Sweep, rows: Array<[label: string, key: keyof SweepBreakdown]>) {
  const { tag, cloud, counts } = sweep;
  const total = rows.reduce((sum, [, key]) => sum + (counts[key] ?? 0), 0);
  if (total > 0) {
    const breakdown = rows.map(([label, key]) => `${label}=${counts[key] ?? 0}`).join(', ');
    console.warn(
      `${tag} [sweep] REGRESSION: destroy left ${total} ${cloud} orphan resource(s) (${breakdown}). vibecarbon destroy did not free these — fix the corresponding destroy code path.`,
    );
  } else if (sweep.result().enumFailed) {
    console.warn(
      `${tag} [sweep] REGRESSION: could not enumerate one or more ${cloud} resource types — orphan check is incomplete, treat as a destroy regression.`,
    );
  } else {
    console.log(`${tag} [sweep] No ${cloud} orphans found — destroy worked cleanly.`);
  }
}
