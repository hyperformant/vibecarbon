/**
 * The SSH-unreachability memo that stops verify steps from burning a full
 * retry budget per check against a host whose :22 is black-holed.
 *
 * The load-bearing distinction is connect-timeout (host/firewall property —
 * memoize, fail fast) vs banner-exchange timeout (sshd answered and dropped us
 * under MaxStartups — keep retrying). Getting that backwards would turn the
 * verify fan-out's own SSH saturation into hard failures.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  continuityTargetSameAsOriginMessage,
  continuityTransportFailed,
  isContinuityTargetSameAsMarkerOrigin,
} from '../../e2e/checks/replication.js';
import { collectResourceMetrics } from '../../e2e/utils/ssh.js';
import {
  isSshConnectTimeout,
  noteHttpEvidence,
  noteSshConnectTimeout,
  resetSshReachability,
  sshUnreachableDiagnosis,
  sshUnreachableSince,
} from '../../e2e/utils/ssh-reachability.js';

beforeEach(() => resetSshReachability());

describe('isSshConnectTimeout', () => {
  it('matches the OpenSSH connect-timeout line verbatim (2026-08-11 d2 failure)', () => {
    expect(
      isSshConnectTimeout('ssh: connect to host 159.203.64.163 port 22: Connection timed out'),
    ).toBe(true);
  });

  it('does NOT match a banner-exchange timeout — sshd answered, retry is correct', () => {
    expect(
      isSshConnectTimeout(
        'kex_exchange_identification: Connection timed out during banner exchange',
      ),
    ).toBe(false);
  });

  it('does NOT match connection refused — something answered, firewall is not the story', () => {
    expect(isSshConnectTimeout('ssh: connect to host 10.0.0.1 port 22: Connection refused')).toBe(
      false,
    );
  });

  it('matches no-route/unreachable errors', () => {
    expect(isSshConnectTimeout('ssh: connect to host 10.0.0.1 port 22: No route to host')).toBe(
      true,
    );
  });

  it('is false for empty, null, and unrelated remote failures', () => {
    expect(isSshConnectTimeout('')).toBe(false);
    expect(isSshConnectTimeout(null)).toBe(false);
    expect(isSshConnectTimeout(undefined)).toBe(false);
    expect(isSshConnectTimeout('psql: FATAL: database "postgres" does not exist')).toBe(false);
    expect(isSshConnectTimeout('Permission denied (publickey).')).toBe(false);
  });
});

describe('the memo', () => {
  it('reports a host unreachable only after it is recorded', () => {
    expect(sshUnreachableSince('1.2.3.4')).toBeNull();
    noteSshConnectTimeout('1.2.3.4', 'ssh: connect to host 1.2.3.4 port 22: Connection timed out');
    expect(sshUnreachableSince('1.2.3.4')).toContain('Connection timed out');
  });

  it('keeps hosts independent — one dead node does not condemn the other', () => {
    noteSshConnectTimeout('1.2.3.4', 'timed out');
    expect(sshUnreachableSince('5.6.7.8')).toBeNull();
  });

  it('keeps the FIRST error text (the one that proved it), not later overwrites', () => {
    noteSshConnectTimeout('1.2.3.4', 'first');
    noteSshConnectTimeout('1.2.3.4', 'second');
    expect(sshUnreachableSince('1.2.3.4')).toBe('first');
  });

  it('resets between scenarios', () => {
    noteSshConnectTimeout('1.2.3.4', 'timed out');
    resetSshReachability();
    expect(sshUnreachableSince('1.2.3.4')).toBeNull();
  });
});

describe('sshUnreachableDiagnosis', () => {
  it('blames operator ACCESS only when HTTP evidence supports it', () => {
    const msg = sshUnreachableDiagnosis('159.203.64.163', true);
    expect(msg).toContain('159.203.64.163');
    expect(msg).toContain('operatorCidrs');
    expect(msg).toContain('vibecarbon access add');
    expect(msg).toContain('api.ipify.org');
    expect(msg).toContain('PASSED');
  });

  it('stays neutral without HTTP evidence — a downed node also black-holes :22', () => {
    const msg = sshUnreachableDiagnosis('159.203.64.163', false);
    expect(msg).toContain('unreachable on :22');
    expect(msg).toContain('node being down');
    // Must NOT hand triage a firewall headline it has not earned.
    expect(msg).not.toContain('vibecarbon access add');
    expect(msg).not.toContain('almost certainly');
  });

  it('defaults to the neutral wording until HTTP evidence is recorded', () => {
    expect(sshUnreachableDiagnosis('1.2.3.4')).toContain('node being down');
    noteHttpEvidence(true);
    expect(sshUnreachableDiagnosis('1.2.3.4')).toContain('only operator ACCESS is broken');
  });

  it('drops recorded HTTP evidence on reset — it must not leak across scenarios', () => {
    noteHttpEvidence(true);
    resetSshReachability();
    expect(sshUnreachableDiagnosis('1.2.3.4')).toContain('node being down');
  });
});

describe('the continuity false-green guard', () => {
  it('fires when role resolution still names the marker origin', () => {
    expect(isContinuityTargetSameAsMarkerOrigin('1.2.3.4', '1.2.3.4')).toBe(true);
  });

  it('does not fire once resolution has moved to the promoted node', () => {
    expect(isContinuityTargetSameAsMarkerOrigin('5.6.7.8', '1.2.3.4')).toBe(false);
  });

  it('does not fire on missing inputs — a self-skip is not a false green', () => {
    expect(isContinuityTargetSameAsMarkerOrigin(null, '1.2.3.4')).toBe(false);
    expect(isContinuityTargetSameAsMarkerOrigin('1.2.3.4', null)).toBe(false);
    expect(isContinuityTargetSameAsMarkerOrigin(null, null)).toBe(false);
    expect(isContinuityTargetSameAsMarkerOrigin(undefined, undefined)).toBe(false);
    expect(isContinuityTargetSameAsMarkerOrigin('', '')).toBe(false);
  });

  it('explains that reading the marker off its own origin proves nothing', () => {
    const msg = continuityTargetSameAsOriginMessage('159.203.64.163');
    expect(msg).toContain('159.203.64.163');
    expect(msg).toContain('WRITTEN to');
    // The specific claim, not just the word "pass" — the message has to say
    // WHY the read is worthless, or it reads as a generic complaint.
    expect(msg).toContain('would succeed no matter what replication did');
    // It must not claim data loss — nothing here is evidence of that.
    expect(msg).not.toContain('was lost');
  });
});

describe('the metrics path is memo-READ-only', () => {
  // TEST-NET-1 (RFC 5737) — reserved for documentation and black-holed, so the
  // connect attempt times out rather than resolving anywhere real.
  const DEAD = '192.0.2.1';

  it('a metrics probe timeout does NOT condemn the host', async () => {
    expect(await collectResourceMetrics(DEAD, '/nonexistent-key')).toBeNull();
    // A single-shot 5s probe with no retry is far too weak an instrument to
    // latch a verdict the continuity check would then obey. One unlucky window
    // (uplink stall, sshd under MaxStartups during the verify fan-out) must not
    // make every later SSH-gated check give up on a healthy promoted primary —
    // the continuity path still gets its full retry budget.
    expect(sshUnreachableSince(DEAD)).toBeNull();
  }, 30_000);

  it('but it CONSUMES a condemnation made by a stronger signal, without re-probing', async () => {
    noteSshConnectTimeout(DEAD, `ssh: connect to host ${DEAD} port 22: Connection timed out`);
    const started = Date.now();
    expect(await collectResourceMetrics(DEAD, '/nonexistent-key')).toBeNull();
    // Early return — no SSH attempted at all (three round-trips saved, one of
    // which carries a built-in 1s sleep).
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('continuityTransportFailed', () => {
  it('fires for a condemned host', () => {
    expect(continuityTransportFailed({ ok: false }, true)).toBe(true);
  });

  it('fires for a transport failure the memo never condemned (exhausted banner exchange)', () => {
    // The class, not the instance: sshd answered and dropped us under
    // MaxStartups until the retries ran out. Never a connect timeout, so never
    // memoized — and previously reported as "data written pre-failover was lost".
    expect(continuityTransportFailed({ ok: false, failureKind: 'ssh-transport' }, false)).toBe(
      true,
    );
  });

  it('does NOT fire for a remote psql failure — that reached a database', () => {
    expect(continuityTransportFailed({ ok: false, failureKind: 'remote' }, false)).toBe(false);
  });

  it('does NOT fire when the lookup succeeded', () => {
    expect(continuityTransportFailed({ ok: true }, false)).toBe(false);
  });
});
