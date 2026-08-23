/**
 * scp transport retry (2026-08-11 compose-ha warm-deploy failure).
 *
 * A hetzner/compose-ha warm deploy died at step merge-walg-role because
 * `mergeRemoteDotenv`'s single scp attempt hit a transport blip:
 *
 *   ssh: connect to host 78.46.123.112 port 22: Connection timed out during
 *        banner exchange
 *   Connection to 78.46.123.112 port 22 timed out
 *   scp: Connection closed
 *
 * SSH to the same host succeeded seconds before and after. `sshRunAsync`
 * already retried exactly this wording for `ssh`, but every scp call site in
 * the deploy path spawned `runCommandAsync(['scp', ...])` bare — zero
 * attempts of retry. `scpWithRetry` closes that gap for the whole family;
 * the call-site sweep lives in scp-call-site-census.test.ts.
 *
 * These are BEHAVIORAL: a fake `scp` executable on a temp PATH is really
 * spawned by the real runCommandAsync, so the retry loop, the classifier and
 * the ignoreError contract are exercised end to end. No node: builtin is
 * mocked (the unit suite runs in parallel) and no network is touched.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTransientSshCommandError, scpWithRetry } from '../../../src/lib/ssh.js';

/** The exact stderr from the 2026-08-11 merge-walg-role failure. */
const TONIGHT_STDERR = [
  'ssh: connect to host 78.46.123.112 port 22: Connection timed out during banner exchange',
  'Connection to 78.46.123.112 port 22 timed out',
  'scp: Connection closed',
].join('\n');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Put a fake `scp` on a private PATH that fails (exit 255, `stderr`) for its
 * first `failTimes` invocations and then succeeds. Returns the PATH to hand
 * to scpWithRetry plus an attempt counter.
 */
function fakeScp({ failTimes, stderr }: { failTimes: number; stderr: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-fake-scp-'));
  tempDirs.push(dir);
  const counter = join(dir, 'attempts');
  const script = [
    '#!/bin/sh',
    `n=$(cat ${counter} 2>/dev/null || echo 0)`,
    'n=$((n + 1))',
    `echo "$n" > ${counter}`,
    `if [ "$n" -le ${failTimes} ]; then`,
    `  cat >&2 <<'VC_EOF'`,
    stderr,
    'VC_EOF',
    '  exit 255',
    'fi',
    'exit 0',
  ].join('\n');
  const bin = join(dir, 'scp');
  writeFileSync(bin, `${script}\n`);
  chmodSync(bin, 0o755);
  return {
    // Prepended, not replacing: the fake shadows the real scp while the
    // script itself still resolves `cat`.
    path: `${dir}:${process.env.PATH}`,
    attempts: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf-8').trim()) : 0),
  };
}

describe('isTransientSshCommandError', () => {
  it('classifies the 2026-08-11 scp banner-exchange failure as transient', () => {
    expect(isTransientSshCommandError(new Error(`Command failed: scp\n${TONIGHT_STDERR}`))).toBe(
      true,
    );
  });

  it('classifies an established-session drop — Broken pipe — as transient (2026-08-23 family sweep)', () => {
    // The kubectl sibling of this classifier missed the `broken pipe`
    // spelling and a DO restore re-deploy died unretried (run 32659821814).
    // This classifier's consumers are declared re-runnable, and it already
    // retries `Connection closed`; `client_loop: send disconnect: Broken
    // pipe` is the same established-connection-drop class in ssh's own
    // canonical wording.
    expect(
      isTransientSshCommandError(
        new Error('Command failed: ssh\nclient_loop: send disconnect: Broken pipe'),
      ),
    ).toBe(true);
  });

  it('does NOT classify a real remote answer as transient', () => {
    // A missing source file is a real answer, not a blip — retrying it just
    // burns the deploy's clock three times over.
    const err = new Error('Command failed: scp\nscp: /opt/app/.env: No such file or directory');
    expect(isTransientSshCommandError(err)).toBe(false);
  });

  it('still unions in the DNS-not-settled branch it shares with sshRunAsync', () => {
    // The classifier is shared: sshRunAsync widens its LADDER on this class,
    // scp only borrows the CLASSIFICATION (see the ladder test below). If a
    // refactor drops this branch, sshRunAsync silently stops retrying
    // fresh-server DNS blips — the 2026-08-11 DNS fix regressing via a
    // move it never asked for.
    expect(
      isTransientSshCommandError(new Error('Command failed: ...\nTemporary failure resolving')),
    ).toBe(true);
    expect(
      isTransientSshCommandError(new Error('Command failed: ...\ngetaddrinfo EAI_AGAIN')),
    ).toBe(true);
  });
});

describe('scpWithRetry', () => {
  it('retries a transient transport failure and succeeds on the next attempt', async () => {
    const scp = fakeScp({ failTimes: 1, stderr: TONIGHT_STDERR });
    await scpWithRetry(['/local/.env', 'root@1.2.3.4:/opt/app/.env'], {
      env: { PATH: scp.path },
    });
    expect(scp.attempts(), 'one transient blip must not fail the deploy').toBe(2);
  }, 20_000);

  it('gives up immediately on a non-transient failure (no wasted backoff)', async () => {
    const scp = fakeScp({
      failTimes: 99,
      stderr: 'scp: /opt/app/.env: No such file or directory',
    });
    await expect(
      scpWithRetry(['/local/.env', 'root@1.2.3.4:/opt/app/.env'], { env: { PATH: scp.path } }),
    ).rejects.toThrow(/No such file or directory/);
    expect(scp.attempts()).toBe(1);
  });

  it('honors the caller retries option as a total attempt count', async () => {
    const scp = fakeScp({ failTimes: 99, stderr: TONIGHT_STDERR });
    await expect(
      scpWithRetry(['/local/.env', 'root@1.2.3.4:/opt/app/.env'], {
        env: { PATH: scp.path },
        retries: 1,
      }),
    ).rejects.toThrow(/Connection closed/);
    expect(scp.attempts(), 'retries:1 is a deliberate single-attempt opt-out').toBe(1);
  });

  it('applies ignoreError only AFTER the retries are exhausted', async () => {
    // The bare call sites passed ignoreError:true, which made runCommandAsync
    // resolve(null) on the first failure — the error never surfaced, so no
    // retry loop could ever see it. The helper must strip ignoreError from the
    // inner call and apply it itself.
    const scp = fakeScp({ failTimes: 99, stderr: TONIGHT_STDERR });
    const result = await scpWithRetry(['/local/.env', 'root@1.2.3.4:/opt/app/.env'], {
      env: { PATH: scp.path },
      retries: 2,
      ignoreError: true,
    });
    expect(result).toBeNull();
    expect(scp.attempts(), 'ignoreError must not disable the retry ladder').toBe(2);
  }, 20_000);

  it('stays on the 5s TRANSPORT ladder for a DNS wording — no DNS widening', async () => {
    // The shared classifier retries DNS-not-settled wordings, and sshRunAsync
    // widens to DNS_NOT_SETTLED_RETRY_DELAYS_MS ([10s,15s,20s]) when it sees
    // one. scp deliberately does NOT: it runs no remote command, so
    // container-resolver wordings cannot reach it, and a 45s tail would only
    // slow down a genuinely dead host. Pinned by ELAPSED TIME because that is
    // the only externally visible difference between the two ladders — a
    // first delay of 10s instead of 5s fails this.
    const scp = fakeScp({
      failTimes: 1,
      stderr: 'ssh: Could not resolve hostname h: Temporary failure in name resolution',
    });
    const started = Date.now();
    await scpWithRetry(['/local/.env', 'root@1.2.3.4:/opt/app/.env'], {
      env: { PATH: scp.path },
    });
    const elapsed = Date.now() - started;
    expect(scp.attempts(), 'a DNS wording is still transient — it must retry').toBe(2);
    expect(elapsed, `expected the 5s transport rung, got ${elapsed}ms`).toBeLessThan(8_000);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
  }, 20_000);

  it('prepends the scp executable so no caller has to spawn it', async () => {
    const scp = fakeScp({ failTimes: 0, stderr: '' });
    await scpWithRetry(['-r', '/local/grafana', 'root@1.2.3.4:/opt/app/'], {
      env: { PATH: scp.path },
    });
    expect(scp.attempts()).toBe(1);
  });
});
