import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMaintenance } from '@shared/host-maintenance';

vi.mock('@server/db/client', () => ({ adminDb: {}, pool: {} }));
vi.mock('@server/lib/env', () => ({ env: { SITE_URL: 'https://app.test/' } }));
vi.mock('@server/lib/email', () => ({ isEmailConfigured: () => true, sendEmail: vi.fn() }));
vi.mock('@server/lib/host-maintenance', () => ({ readHostMaintenance: vi.fn() }));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const {
  HOST_MAINTENANCE_LOCK_KEY,
  NOTICE_KEY,
  msUntilNextDailyRun,
  startHostMaintenanceEmails,
  runHostMaintenanceCheck,
} = await import('@server/jobs/host-maintenance-email');
type NoticeRecord = import('@server/jobs/host-maintenance-email').NoticeRecord;
type CheckDeps = import('@server/jobs/host-maintenance-email').CheckDeps;
const { hostRestartDueEmail } = await import('@server/emails/templates');

const SUBJECT = 'Restart needed to finish security updates';
const SINCE = '2026-11-15T06:42:10Z';

const due = (since = SINCE): HostMaintenance => ({
  runtime: 'compose',
  envName: 'prod',
  rebootRequired: true,
  since,
  servers: [
    {
      name: 'web-1',
      reporting: true,
      rebootRequired: true,
      since,
      packages: ['linux-image-6.8.0-90-generic'],
    },
    { name: 'db-1', reporting: true, rebootRequired: false, since: null, packages: [] },
  ],
});
const clear = (): HostMaintenance => ({
  runtime: 'compose',
  envName: 'prod',
  rebootRequired: false,
  since: null,
  servers: [],
});

type Harness = {
  deps: CheckDeps;
  record: { current: NoticeRecord | null };
  sent: Array<{ to: string[]; subject: string; html: string }>;
  writes: NoticeRecord[];
};

function harness(over: Partial<CheckDeps> = {}, hosts: HostMaintenance = due()): Harness {
  const h: Harness = { record: { current: null }, sent: [], writes: [], deps: undefined as never };
  const state = { hosts };
  h.deps = {
    emailConfigured: () => true,
    withTryLock: async (fn) => fn(),
    inRecovery: async () => false,
    readRecord: async () => h.record.current,
    writeRecord: async (r) => {
      h.writes.push(r);
      h.record.current = r;
    },
    readHosts: async () => state.hosts,
    listRecipients: async () => ['a@x.test', 'b@x.test'],
    send: async (to, email) => {
      h.sent.push({ to, ...email });
    },
    ...over,
  };
  (h as Harness & { setHosts: (x: HostMaintenance) => void }).setHosts = (x) => {
    state.hosts = x;
  };
  return h;
}

const at = (iso: string) => new Date(iso);

describe('constants', () => {
  it('uses the planned lock and record keys', () => {
    expect(HOST_MAINTENANCE_LOCK_KEY).toBe('7264519330021877');
    expect(NOTICE_KEY).toBe('host_maintenance_notice');
  });
});

describe('msUntilNextDailyRun', () => {
  it('is the time left before 09:00 UTC', () => {
    expect(msUntilNextDailyRun(at('2026-11-16T08:59:00Z'))).toBe(60_000);
  });
  it('is a full day at exactly 09:00:00.000', () => {
    expect(msUntilNextDailyRun(at('2026-11-16T09:00:00Z'))).toBe(86_400_000);
  });
  it('rolls to the next day after 09:00', () => {
    expect(msUntilNextDailyRun(at('2026-11-16T10:00:00Z'))).toBe(23 * 3_600_000);
  });
});

describe('runHostMaintenanceCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skipped-no-email: touches nothing', async () => {
    const lock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    const h = harness({ emailConfigured: () => false, withTryLock: lock as never });
    expect(await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps)).toBe(
      'skipped-no-email'
    );
    expect(lock).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it('skipped-locked: another replica holds the lock', async () => {
    const h = harness({ withTryLock: async () => 'locked' });
    expect(await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps)).toBe(
      'skipped-locked'
    );
    expect(h.sent).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('skipped-standby: a replica database is read-only', async () => {
    const h = harness({ inRecovery: async () => true });
    expect(await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps)).toBe(
      'skipped-standby'
    );
    expect(h.sent).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('skipped-already-checked: same UTC date, even 09:00 then 14:00', async () => {
    const h = harness();
    expect(await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps)).toBe('sent-first');
    expect(await runHostMaintenanceCheck(at('2026-11-16T14:00:00Z'), h.deps)).toBe(
      'skipped-already-checked'
    );
    expect(h.sent).toHaveLength(2);
    expect(h.writes).toHaveLength(1);
  });

  it('error: a failed host read is not "not due" and writes nothing', async () => {
    const h = harness({
      readHosts: async () => {
        throw new Error('k8s down');
      },
    });
    expect(await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps)).toBe('error');
    expect(h.writes).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('none-due: records the check and clears the notice state', async () => {
    const h = harness({}, clear());
    h.record.current = {
      since: SINCE,
      firstSeenAt: '2026-11-10T09:00:00.000Z',
      lastEmailedAt: '2026-11-10T09:00:00.000Z',
      lastCheckedAt: '2026-11-15T09:00:00.000Z',
    };
    const now = at('2026-11-16T09:00:00Z');
    expect(await runHostMaintenanceCheck(now, h.deps)).toBe('none-due');
    expect(h.writes).toEqual([
      { since: null, firstSeenAt: null, lastEmailedAt: null, lastCheckedAt: now.toISOString() },
    ]);
    expect(h.sent).toEqual([]);
  });

  it('sent-first: one email to every recipient and the record written', async () => {
    const h = harness();
    const now = at('2026-11-16T09:00:00Z');
    expect(await runHostMaintenanceCheck(now, h.deps)).toBe('sent-first');
    expect(h.sent.map((m) => m.to)).toEqual([['a@x.test'], ['b@x.test']]);
    expect(h.sent.every((m) => m.subject === SUBJECT)).toBe(true);
    expect(h.sent[0]?.html).toContain('vibecarbon update prod');
    expect(h.sent[0]?.html).toContain('href="https://app.test/docs/cli#update"');
    expect(h.writes).toEqual([
      {
        since: SINCE,
        firstSeenAt: now.toISOString(),
        lastEmailedAt: now.toISOString(),
        lastCheckedAt: now.toISOString(),
      },
    ]);
  });

  it('no recipients: only lastCheckedAt is written, and the first notice goes out once one exists', async () => {
    let recipients: string[] = [];
    const h = harness({ listRecipients: async () => recipients });
    const day1 = at('2026-11-16T09:00:00Z');
    expect(await runHostMaintenanceCheck(day1, h.deps)).toBe('not-due-yet');
    expect(h.sent).toEqual([]);
    expect(h.writes).toEqual([
      { since: null, firstSeenAt: null, lastEmailedAt: null, lastCheckedAt: day1.toISOString() },
    ]);
    recipients = ['a@x.test'];
    expect(await runHostMaintenanceCheck(at('2026-11-17T09:00:00Z'), h.deps)).toBe('sent-first');
    expect(h.sent.map((m) => m.to)).toEqual([['a@x.test']]);
  });

  it('only the due servers are named', async () => {
    const h = harness();
    await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps);
    expect(h.sent[0]?.html).toContain('web-1');
    expect(h.sent[0]?.html).not.toContain('db-1');
  });

  it('not-due-yet at 6 days, sent-reminder at 7 calendar days', async () => {
    const h = harness();
    await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps);
    expect(await runHostMaintenanceCheck(at('2026-11-22T09:00:00Z'), h.deps)).toBe('not-due-yet');
    expect(h.sent).toHaveLength(2);
    expect(h.writes.at(-1)).toMatchObject({
      lastEmailedAt: '2026-11-16T09:00:00.000Z',
      lastCheckedAt: '2026-11-22T09:00:00.000Z',
    });

    const now = at('2026-11-23T09:00:00Z');
    expect(await runHostMaintenanceCheck(now, h.deps)).toBe('sent-reminder');
    expect(h.sent).toHaveLength(4);
    expect(h.sent[2]?.subject).toBe(`Reminder: ${SUBJECT}`);
    expect(h.sent.slice(2).map((m) => m.to)).toEqual([['a@x.test'], ['b@x.test']]);
    expect(h.record.current).toMatchObject({
      since: SINCE,
      firstSeenAt: '2026-11-16T09:00:00.000Z',
      lastEmailedAt: now.toISOString(),
      lastCheckedAt: now.toISOString(),
    });
  });

  it('counts calendar days, not 24 hour spans', async () => {
    const h = harness();
    await runHostMaintenanceCheck(at('2026-11-16T23:30:00Z'), h.deps);
    expect(await runHostMaintenanceCheck(at('2026-11-23T09:00:00Z'), h.deps)).toBe('sent-reminder');
  });

  it('a restart then a new due condition mails again as first', async () => {
    const h = harness() as Harness & { setHosts: (x: HostMaintenance) => void };
    await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps);
    h.setHosts(clear());
    expect(await runHostMaintenanceCheck(at('2026-11-17T09:00:00Z'), h.deps)).toBe('none-due');
    h.setHosts(due('2026-11-18T03:00:00Z'));
    expect(await runHostMaintenanceCheck(at('2026-11-18T09:00:00Z'), h.deps)).toBe('sent-first');
    expect(h.sent).toHaveLength(4);
    expect(h.sent[2]?.subject).toBe(SUBJECT);
  });

  it('a failed first send writes only lastCheckedAt; same day skips, next day sends', async () => {
    let fail = true;
    const h = harness({
      send: async (to, email) => {
        if (fail) throw new Error('smtp down');
        h.sent.push({ to, ...email });
      },
    });
    const day1 = at('2026-11-16T09:00:00Z');
    expect(await runHostMaintenanceCheck(day1, h.deps)).toBe('error');
    expect(h.writes).toEqual([
      { since: null, firstSeenAt: null, lastEmailedAt: null, lastCheckedAt: day1.toISOString() },
    ]);
    fail = false;
    expect(await runHostMaintenanceCheck(at('2026-11-16T14:00:00Z'), h.deps)).toBe(
      'skipped-already-checked'
    );
    expect(h.sent).toEqual([]);
    expect(await runHostMaintenanceCheck(at('2026-11-17T09:00:00Z'), h.deps)).toBe('sent-first');
    expect(h.sent.map((m) => m.to)).toEqual([['a@x.test'], ['b@x.test']]);
  });

  it('a failed reminder keeps the record and retries the next date', async () => {
    let fail = false;
    const h = harness({
      send: async (to, email) => {
        if (fail) throw new Error('smtp down');
        h.sent.push({ to, ...email });
      },
    });
    await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps);
    fail = true;
    const day8 = at('2026-11-23T09:00:00Z');
    expect(await runHostMaintenanceCheck(day8, h.deps)).toBe('error');
    expect(h.record.current).toEqual({
      since: SINCE,
      firstSeenAt: '2026-11-16T09:00:00.000Z',
      lastEmailedAt: '2026-11-16T09:00:00.000Z',
      lastCheckedAt: day8.toISOString(),
    });
    fail = false;
    expect(await runHostMaintenanceCheck(at('2026-11-24T09:00:00Z'), h.deps)).toBe('sent-reminder');
    expect(h.sent.at(-1)?.subject).toBe(`Reminder: ${SUBJECT}`);
  });

  it('one bad address does not stop the others, and is not a failure', async () => {
    const h = harness({
      send: async (to, email) => {
        if (to[0] === 'a@x.test') throw new Error('bad address');
        h.sent.push({ to, ...email });
      },
    });
    expect(await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps)).toBe('sent-first');
    expect(h.sent.map((m) => m.to)).toEqual([['b@x.test']]);
    expect(h.record.current?.lastEmailedAt).toBe('2026-11-16T09:00:00.000Z');
  });

  it('logs why a send failed without the address the SMTP server rejected', async () => {
    const { logger } = await import('@server/lib/logger');
    vi.mocked(logger.warn).mockClear();
    const h = harness({
      send: async () => {
        throw Object.assign(new Error('550 5.1.1 <secret.person@x.test>: user unknown'), {
          code: 'EENVELOPE',
          responseCode: 550,
        });
      },
    });
    await runHostMaintenanceCheck(at('2026-11-16T09:00:00Z'), h.deps);
    const calls = vi.mocked(logger.warn).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain('secret.person');
    expect(JSON.stringify(calls)).not.toContain('a@x.test');
    expect(calls[0]).toEqual([
      { code: 'EENVELOPE', responseCode: 550 },
      'host-maintenance-email: one recipient could not be emailed',
    ]);
  });

  it('a send that never resolves times out at 60 s, releases the lock, and counts as failed', async () => {
    vi.useFakeTimers();
    try {
      let released = false;
      const h = harness({
        send: () => new Promise<void>(() => {}),
        withTryLock: async (fn) => {
          try {
            return await fn();
          } finally {
            released = true;
          }
        },
      });
      const now = at('2026-11-16T09:00:00Z');
      const run = runHostMaintenanceCheck(now, h.deps);
      await vi.advanceTimersByTimeAsync(60_000 * 2 + 1);
      expect(await run).toBe('error');
      expect(released).toBe(true);
      expect(h.writes).toEqual([
        { since: null, firstSeenAt: null, lastEmailedAt: null, lastCheckedAt: now.toISOString() },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hostRestartDueEmail', () => {
  const servers = due().servers.slice(0, 1);
  it('uses the notice sentences, packages and docs link', () => {
    const e = hostRestartDueEmail({
      servers,
      command: 'vibecarbon update prod',
      docsUrl: 'https://app.test/docs/cli#update',
      reminder: false,
    });
    expect(e.subject).toBe(SUBJECT);
    expect(e.html).toContain('A restart is needed to finish security updates');
    expect(e.html).toContain(
      'Security updates are installed on web-1 and take effect after a restart. Nothing restarts on its own. To restart safely, run vibecarbon update prod from your project.'
    );
    expect(e.html).toContain('linux-image-6.8.0-90-generic');
    expect(e.html).toContain('href="https://app.test/docs/cli#update"');
    expect(e.html).not.toMatch(/[–—]/);
  });
  it('escapes the placeholder command and hostile names', () => {
    const e = hostRestartDueEmail({
      servers: [{ ...servers[0]!, name: '<b>x</b>', packages: ['<i>'] }],
      command: 'vibecarbon update <your environment>',
      docsUrl: 'https://app.test/docs/cli#update',
      reminder: true,
    });
    expect(e.subject).toBe(`Reminder: ${SUBJECT}`);
    expect(e.html).toContain('vibecarbon update &lt;your environment&gt;');
    expect(e.html).not.toContain('<b>x</b>');
    expect(e.html).not.toContain('<i>');
  });
});

describe('startHostMaintenanceEmails', () => {
  it('waits for 09:00 UTC, survives a throwing run, re-arms, and stops', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at('2026-11-16T08:00:00Z'));
      const emailConfigured = vi.fn(() => {
        throw new Error('boom');
      });
      const h = harness({ emailConfigured });
      const stop = startHostMaintenanceEmails(h.deps);
      await vi.advanceTimersByTimeAsync(59 * 60_000);
      expect(emailConfigured).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(emailConfigured).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(emailConfigured).toHaveBeenCalledTimes(2);
      stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * 86_400_000);
      expect(emailConfigured).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
