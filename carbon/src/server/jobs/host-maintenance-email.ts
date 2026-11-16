import { eq, sql } from 'drizzle-orm';
import type { HostMaintenance } from '../../shared/host-maintenance';
import { adminDb, pool } from '../db/client';
import { appSettings, user } from '../db/schema';
import { hostRestartDueEmail } from '../emails/templates';
import { isEmailConfigured, sendEmail } from '../lib/email';
import { env } from '../lib/env';
import { readHostMaintenance } from '../lib/host-maintenance';
import { logger } from '../lib/logger';

/**
 * Daily email to the super admins when servers need a restart to finish
 * security updates. One email when a restart first becomes due, then a
 * reminder every 7 UTC calendar days while it stays due.
 *
 * Every replica runs the timer; a Postgres advisory lock lets one of them do
 * the check, and the record in app_settings (key NOTICE_KEY) makes a second
 * run on the same UTC date a no-op, so a replica restarting after 09:00 never
 * sends twice.
 */

export const HOST_MAINTENANCE_LOCK_KEY = '7264519330021877';
export const NOTICE_KEY = 'host_maintenance_notice';

const RUN_HOUR_UTC = 9;
const REMINDER_DAYS = 7;
const DAY_MS = 86_400_000;
const SUBJECT_DOCS_PATH = '/docs/cli#update';

export type NoticeRecord = {
  since: string | null;
  firstSeenAt: string | null;
  lastEmailedAt: string | null;
  lastCheckedAt: string | null;
};

export type CheckOutcome =
  | 'skipped-no-email'
  | 'skipped-locked'
  | 'skipped-standby'
  | 'skipped-already-checked'
  | 'none-due'
  | 'sent-first'
  | 'sent-reminder'
  | 'not-due-yet'
  | 'error';

export type CheckDeps = {
  emailConfigured(): boolean;
  withTryLock<T>(fn: () => Promise<T>): Promise<T | 'locked'>;
  inRecovery(): Promise<boolean>;
  readRecord(): Promise<NoticeRecord | null>;
  writeRecord(r: NoticeRecord): Promise<void>;
  readHosts(): Promise<HostMaintenance>;
  listRecipients(): Promise<string[]>;
  send(to: string[], email: { subject: string; html: string }): Promise<void>;
};

/** Milliseconds until the next `hourUtc`:00 UTC. Always above zero. */
export function msUntilNextDailyRun(now: Date, hourUtc = RUN_HOUR_UTC): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  const ms = next - now.getTime();
  return ms > 0 ? ms : ms + DAY_MS;
}

const utcDate = (iso: string): number => {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** UTC calendar days from `from` to `to`. */
function calendarDaysBetween(from: string, to: Date): number {
  return Math.round(
    (Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - utcDate(from)) / DAY_MS
  );
}

function emailFor(hosts: HostMaintenance, reminder: boolean) {
  const siteUrl = env.SITE_URL.replace(/\/+$/, '');
  return hostRestartDueEmail({
    servers: hosts.servers.filter((s) => s.rebootRequired),
    command: `vibecarbon update ${hosts.envName ?? '<your environment>'}`,
    docsUrl: `${siteUrl}${SUBJECT_DOCS_PATH}`,
    reminder,
  });
}

const SEND_TIMEOUT_MS = 60_000;

/**
 * One message to one address, bounded. Resolves false (and logs, without the
 * address) on a failure or a timeout; never throws.
 */
async function sendBounded(
  deps: CheckDeps,
  to: string[],
  email: { subject: string; html: string }
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const sending = deps.send(to, email);
    // A send that outlives its timeout must not become an unhandled rejection.
    sending.catch(() => {});
    await Promise.race([
      sending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('send timed out')), SEND_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return true;
  } catch (err) {
    logger.warn({ err }, 'host-maintenance-email: one recipient could not be emailed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runHostMaintenanceCheck(now: Date, deps: CheckDeps): Promise<CheckOutcome> {
  if (!deps.emailConfigured()) return 'skipped-no-email';

  const outcome = await deps.withTryLock<CheckOutcome>(async () => {
    if (await deps.inRecovery()) return 'skipped-standby';

    const nowIso = now.toISOString();
    const record = await deps.readRecord();
    if (record?.lastCheckedAt && record.lastCheckedAt.slice(0, 10) === nowIso.slice(0, 10)) {
      return 'skipped-already-checked';
    }

    let hosts: HostMaintenance;
    try {
      hosts = await deps.readHosts();
    } catch (err) {
      logger.warn({ err }, 'host-maintenance-email: could not read host state, not deciding today');
      return 'error';
    }

    if (!hosts.rebootRequired) {
      await deps.writeRecord({
        since: null,
        firstSeenAt: null,
        lastEmailedAt: null,
        lastCheckedAt: nowIso,
      });
      return 'none-due';
    }

    const isNew = !record || record.lastEmailedAt === null || record.since !== hosts.since;
    const reminder =
      !isNew && calendarDaysBetween(record.lastEmailedAt as string, now) >= REMINDER_DAYS;
    // The record as it stands, for writes that only note today's check.
    const kept: NoticeRecord = record ?? {
      since: null,
      firstSeenAt: null,
      lastEmailedAt: null,
      lastCheckedAt: null,
    };

    if (isNew || reminder) {
      let to: string[];
      try {
        to = await deps.listRecipients();
      } catch (err) {
        logger.error({ err }, 'host-maintenance-email: could not list recipients');
        await deps.writeRecord({ ...kept, lastCheckedAt: nowIso });
        return 'error';
      }
      if (to.length === 0) {
        // Nobody to tell yet: the first real notice goes out once a super
        // admin exists.
        await deps.writeRecord({ ...kept, lastCheckedAt: nowIso });
        return 'not-due-yet';
      }
      const email = emailFor(hosts, reminder);
      let delivered = 0;
      for (const addr of to) {
        if (await sendBounded(deps, [addr], email)) delivered++;
      }
      if (delivered === 0) {
        logger.error('host-maintenance-email: no email could be sent, will retry tomorrow');
        await deps.writeRecord({ ...kept, lastCheckedAt: nowIso });
        return 'error';
      }
      if (isNew) {
        await deps.writeRecord({
          since: hosts.since,
          firstSeenAt: nowIso,
          lastEmailedAt: nowIso,
          lastCheckedAt: nowIso,
        });
        return 'sent-first';
      }
      await deps.writeRecord({ ...kept, lastEmailedAt: nowIso, lastCheckedAt: nowIso });
      return 'sent-reminder';
    }

    await deps.writeRecord({ ...record, lastCheckedAt: nowIso });
    return 'not-due-yet';
  });

  return outcome === 'locked' ? 'skipped-locked' : outcome;
}

/**
 * Run `fn` holding a session advisory lock taken with try-lock on a dedicated
 * pool client; resolves 'locked' (without running `fn`) when another session
 * holds it. If releasing fails the client is discarded, which ends the
 * session and drops the lock.
 */
export async function withHostMaintenanceLock<T>(fn: () => Promise<T>): Promise<T | 'locked'> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const res = await client.query('select pg_try_advisory_lock($1::bigint) as ok', [
      HOST_MAINTENANCE_LOCK_KEY,
    ]);
    if (res.rows[0]?.ok !== true) return 'locked';
    try {
      return await fn();
    } finally {
      await client
        .query('select pg_advisory_unlock($1::bigint)', [HOST_MAINTENANCE_LOCK_KEY])
        .catch((err: Error) => {
          broken = err;
        });
    }
  } catch (err) {
    broken ??= err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    client.release(broken);
  }
}

const realDeps: CheckDeps = {
  emailConfigured: isEmailConfigured,
  withTryLock: withHostMaintenanceLock,
  async inRecovery() {
    const res = await pool.query('select pg_is_in_recovery() as r');
    return res.rows[0]?.r === true;
  },
  async readRecord() {
    const [row] = await adminDb
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, NOTICE_KEY))
      .limit(1);
    return (row?.value as NoticeRecord | undefined) ?? null;
  },
  async writeRecord(r) {
    await adminDb
      .insert(appSettings)
      .values({ key: NOTICE_KEY, value: r })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: r, updatedAt: sql`now()` } });
  },
  readHosts: readHostMaintenance,
  async listRecipients() {
    const rows = await adminDb
      .select({ email: user.email })
      .from(user)
      .where(
        sql`${user.role} = 'super_admin' and ${user.emailVerified} and ${user.banned} is not true`
      );
    return rows.map((r) => r.email);
  },
  async send(to, email) {
    await sendEmail({ to, subject: email.subject, html: email.html });
  },
};

/**
 * Arm the daily run: first at the next 09:00 UTC (never at startup), then
 * re-armed after every run. Timers are unref'd; `stop` clears the pending one.
 * A run never throws out of the timer.
 */
export function startHostMaintenanceEmails(deps: CheckDeps = realDeps): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        const outcome = await runHostMaintenanceCheck(new Date(), deps);
        logger.info({ outcome }, 'host-maintenance-email: daily check done');
      } catch (err) {
        logger.error({ err }, 'host-maintenance-email: daily check failed');
      }
      arm();
    }, msUntilNextDailyRun(new Date()));
    timer.unref();
  };
  arm();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
