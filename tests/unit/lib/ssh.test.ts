import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownHostsPath, knownHostsPathForKey } from '../../../src/lib/host-keys.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('../../../src/lib/command.js', () => ({
  runCommandAsync: vi.fn(),
}));

// vi.useFakeTimers() does not fake `node:timers/promises` (sinon limitation),
// so route runWithRetry's sleep through the faked global setTimeout — mirrors
// tests/unit/lib/retry.test.ts and tests/unit/deploy/k3s-kubectl-retry.test.ts.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms?: number, value?: unknown) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms)),
}));

const progressLogMock = vi.fn();
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (...args: unknown[]) => progressLogMock(...args),
}));

import { runCommandAsync } from '../../../src/lib/command.js';
import {
  getPostgresPod,
  getSSHKeyPath,
  isNeverStartedSshTransportFailure,
  SSH_TRANSPORT_NEVER_STARTED_RE,
  scpDownload,
  scpUpload,
  sshKubectl,
  sshRun,
  sshRunScript,
} from '../../../src/lib/ssh.js';

// pollUntil/runWithRetry schedule a NEW timer after each attempt, so a single
// runAllTimersAsync can't drain the chain — advance the clock in fixed steps
// and stop as soon as the promise actually settles. Mirrors retry.test.ts.
async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  while (!done) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return r;
}

function transportError(stderr: string, status: number) {
  const err = new Error(`Command failed: ssh ...\n${stderr}`);
  (err as Error & { stderr: string; status: number }).stderr = stderr;
  (err as Error & { stderr: string; status: number }).status = status;
  return err;
}

const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockRun = runCommandAsync as unknown as ReturnType<typeof vi.fn>;

describe('getSSHKeyPath', () => {
  const cwd = process.cwd();

  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  it('strips -primary suffix and returns base key when it exists', () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === join(cwd, '.vibecarbon', 'deploy_key_prod'),
    );
    expect(getSSHKeyPath('prod-primary')).toBe(join(cwd, '.vibecarbon', 'deploy_key_prod'));
  });

  it('strips -standby suffix and returns base key when it exists', () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === join(cwd, '.vibecarbon', 'deploy_key_prod'),
    );
    expect(getSSHKeyPath('prod-standby')).toBe(join(cwd, '.vibecarbon', 'deploy_key_prod'));
  });

  it('falls back to exact name when base key does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(getSSHKeyPath('prod-primary')).toBe(join(cwd, '.vibecarbon', 'deploy_key_prod-primary'));
  });

  it('returns exact name for non-HA environments', () => {
    mockExistsSync.mockReturnValue(false);
    expect(getSSHKeyPath('staging')).toBe(join(cwd, '.vibecarbon', 'deploy_key_staging'));
  });

  it('returns base key path for non-HA environment when it exists', () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === join(cwd, '.vibecarbon', 'deploy_key_staging'),
    );
    expect(getSSHKeyPath('staging')).toBe(join(cwd, '.vibecarbon', 'deploy_key_staging'));
  });
});

describe('sshRun', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue('');
  });

  it('throws on non-array argv', async () => {
    await expect(sshRun('1.2.3.4', '/k', 'whoami' as unknown as string[])).rejects.toThrow(
      /argv array/,
    );
  });

  it('throws on empty argv', async () => {
    await expect(sshRun('1.2.3.4', '/k', [])).rejects.toThrow(/argv array/);
  });

  it('places -- before the hostname and POSIX-quotes each argv element into one remote-command string', async () => {
    await sshRun('1.2.3.4', '/key', ['echo', '$(id)', '`whoami`', 'a\nb']);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const dashIdx = cmd.indexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    // Hostname must come AFTER the -- separator, not before it.
    expect(cmd[dashIdx + 1]).toBe('root@1.2.3.4');
    // Everything after the hostname is ONE element — a POSIX-quoted remote
    // command string. OpenSSH joins post-hostname argv with single spaces
    // without re-quoting, so we quote every element ourselves so the remote
    // shell word-splits back into the exact tokens we intended.
    expect(cmd.slice(dashIdx + 2)).toEqual(["'echo' '$(id)' '`whoami`' 'a\nb'"]);
  });

  it('preserves multi-word sh -c scripts across the ssh wire (regression: ssh joins argv with spaces)', async () => {
    // Without POSIX-quoting, ssh would send `sh -c gunzip -c /f | psql` to
    // the remote — remote sh would take `gunzip` as its -c script and run
    // `psql` in the outer shell. Quoting keeps the script intact.
    await sshRun('1.2.3.4', '/key', ['sh', '-c', 'gunzip -c /f | psql']);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const dashIdx = cmd.indexOf('--');
    expect(cmd.slice(dashIdx + 2)).toEqual(["'sh' '-c' 'gunzip -c /f | psql'"]);
  });

  it('uses accept-new host-key mode on firstConnect', async () => {
    await sshRun('1.2.3.4', '/key', ['whoami'], { env: 'prod', firstConnect: true });
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    expect(cmd).toContain('StrictHostKeyChecking=accept-new');
  });

  it('uses strict host-key checking by default when env is provided', async () => {
    await sshRun('1.2.3.4', '/key', ['whoami'], { env: 'prod' });
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    expect(cmd).toContain(`UserKnownHostsFile=${knownHostsPath('prod')}`);
    expect(cmd).toContain('StrictHostKeyChecking=yes');
  });

  it('pins to the per-env known_hosts DERIVED from the key path when no env is given (H-1)', async () => {
    // No-env callers (backup/restore/scale/failover) only thread the key path.
    // We derive .vibecarbon/known_hosts_<env> from it and use accept-new — which
    // still REJECTS a changed key for an already-pinned host (MITM on an
    // established env fails) while TOFU-ing a fresh/recycled IP. The bypass
    // (UserKnownHostsFile=/dev/null + StrictHostKeyChecking=no) is gone.
    await sshRun('1.2.3.4', '/home/u/.vibecarbon/deploy_key_prod', ['whoami']);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    expect(cmd).toContain(
      `UserKnownHostsFile=${knownHostsPathForKey('/home/u/.vibecarbon/deploy_key_prod')}`,
    );
    expect(cmd).toContain('GlobalKnownHostsFile=/dev/null');
    expect(cmd).toContain('StrictHostKeyChecking=accept-new');
    expect(cmd).not.toContain('UserKnownHostsFile=/dev/null');
    expect(cmd).not.toContain('StrictHostKeyChecking=no');
  });

  it('sets ServerAliveInterval+CountMax so banner-exchange hangs fail fast', async () => {
    // RCA from iter-confirm 2026-05-02: a freshly-provisioned VPS accepted
    // TCP on 22 but never sent the SSH banner; ssh hung ~600s waiting.
    // ConnectTimeout only covers TCP connect — keepalives are how we bound
    // banner-exchange / mid-protocol hangs. 15s × 4 = 60s of inactivity
    // tolerance before ssh exits with code 255 so the retry layer kicks in.
    await sshRun('1.2.3.4', '/key', ['whoami']);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    expect(cmd).toContain('ServerAliveInterval=15');
    expect(cmd).toContain('ServerAliveCountMax=4');
  });

  it('multiplexes connections so our own fan-outs stop DoS-ing sshd', async () => {
    // Root fix for mitigation-audit cluster 3 (2026-08-16). Two of the seven
    // "ssh transport blip" members were proven OURS: MaxStartups drops under
    // our verify fan-out, and sshd missing the banner while CPU-starved by our
    // concurrent reconcile (7d045250). MaxStartups counts CONNECTIONS, not
    // channels — with ControlMaster, one TCP+auth per host and every later
    // ssh/scp rides the master socket, so the pressure disappears
    // structurally instead of being retried around. %C hashes host+port+user
    // below the unix-socket path-length limit; ControlPersist keeps the
    // master warm across a deploy step's bursts.
    await sshRun('1.2.3.4', '/key', ['whoami']);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    expect(cmd).toContain('ControlMaster=auto');
    expect(cmd.some((t: string) => t.startsWith('ControlPath=') && t.includes('%C'))).toBe(true);
    expect(cmd).toContain('ControlPersist=90s');
  });

  it('the mux socket directory exists with owner-only permissions', async () => {
    // ssh will not mkdir the ControlPath parent, and a world-readable socket
    // dir would hand the session to any local user.
    const { SSH_MUX_DIR } = await import('../../../src/lib/host-keys.js');
    const { statSync } = await import('node:fs');
    const mode = statSync(SSH_MUX_DIR).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('SSH_TRANSPORT_NEVER_STARTED_RE / isNeverStartedSshTransportFailure', () => {
  it('matches each never-started transport signature individually', () => {
    for (const sig of [
      'kex_exchange_identification: Connection timed out during banner exchange',
      'ssh: connect to host 1.2.3.4 port 22: Connection timed out',
      'ssh: connect to host 1.2.3.4 port 22: Connection refused',
      'kex_exchange_identification: Connection closed by remote host',
      'Connection reset by peer',
    ]) {
      expect(SSH_TRANSPORT_NEVER_STARTED_RE.test(sig)).toBe(true);
    }
  });

  it('requires exit code 255 (OpenSSH-own-failure sentinel), not just a matching string', () => {
    // A remote command that RAN, printed something coincidentally similar,
    // and exited non-zero on its own must never be treated as transport-level.
    const ranAndFailed = transportError(
      'psql: error: connection to server failed: Connection refused',
      1,
    );
    expect(isNeverStartedSshTransportFailure(ranAndFailed)).toBe(false);
  });

  it('requires a matching signature, not just exit code 255', () => {
    const authFailure = transportError('Permission denied (publickey).', 255);
    expect(isNeverStartedSshTransportFailure(authFailure)).toBe(false);
  });

  it('matches when both the 255 sentinel and a transport signature are present', () => {
    const transient = transportError('Connection timed out during banner exchange', 255);
    expect(isNeverStartedSshTransportFailure(transient)).toBe(true);
  });
});

describe('sshRun transport retry (never-started failures only)', () => {
  beforeEach(() => {
    mockRun.mockReset();
    progressLogMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a banner-exchange transport failure and resolves on the 2nd attempt', async () => {
    mockRun
      .mockRejectedValueOnce(
        transportError(
          'kex_exchange_identification: Connection timed out during banner exchange',
          255,
        ),
      )
      .mockResolvedValueOnce('ok-output');

    const r = await settled(sshRun('1.2.3.4', '/key', ['wg', 'pubkey']));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.v).toBe('ok-output');
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(progressLogMock).toHaveBeenCalledTimes(1);
    expect(progressLogMock.mock.calls[0][0]).toMatch(
      /^\[ssh\] transport failure \(attempt 1\/3\), retrying in 5s: /,
    );
  });

  it('does not retry a command that ran and exited non-zero with real output (single attempt)', async () => {
    const err = transportError('remote-script: line 4: unexpected token', 1);
    mockRun.mockRejectedValueOnce(err);

    const r = await settled(sshRun('1.2.3.4', '/key', ['whoami']));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e).toBe(err);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(progressLogMock).not.toHaveBeenCalled();
  });

  it('exhausts all 3 attempts and throws the transport error when every attempt fails', async () => {
    mockRun
      .mockRejectedValueOnce(transportError('Connection timed out during banner exchange', 255))
      .mockRejectedValueOnce(transportError('Connection timed out during banner exchange', 255))
      .mockRejectedValueOnce(
        transportError('Connection timed out during banner exchange (final)', 255),
      );

    const r = await settled(sshRun('1.2.3.4', '/key', ['wg', 'pubkey']));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e.message).toMatch(/banner exchange \(final\)/);
    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(progressLogMock).toHaveBeenCalledTimes(2);
    expect(progressLogMock.mock.calls[1][0]).toMatch(
      /^\[ssh\] transport failure \(attempt 2\/3\), retrying in 15s: /,
    );
  });
});

describe('scpDownload / scpUpload use argv form', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue('');
  });

  it('scpDownload puts remote:path before localPath (download direction)', async () => {
    await scpDownload('1.2.3.4', '/key', '/remote/file', '/local/file');
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const dashIdx = cmd.indexOf('--');
    expect(cmd[dashIdx + 1]).toBe('root@1.2.3.4:/remote/file');
    expect(cmd[dashIdx + 2]).toBe('/local/file');
  });

  it('scpUpload puts localPath before remote:path (upload direction)', async () => {
    await scpUpload('1.2.3.4', '/key', '/local/file', '/remote/file');
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const dashIdx = cmd.indexOf('--');
    expect(cmd[dashIdx + 1]).toBe('/local/file');
    expect(cmd[dashIdx + 2]).toBe('root@1.2.3.4:/remote/file');
  });
});

describe('getPostgresPod', () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it('uses the Supabase Helm chart db pod label selector', async () => {
    mockRun.mockResolvedValue('supabase-supabase-db-0');
    await getPostgresPod('1.2.3.4', '/path/to/key');
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const joined = cmd.join(' ');
    // Each remote argv token is POSIX-quoted; the label value survives intact.
    // Supabase community Helm chart labels the db StatefulSet with
    // app.kubernetes.io/name=supabase-db (release=supabase + subchart=db).
    expect(joined).toContain("'-l' 'app.kubernetes.io/name=supabase-db'");
  });

  it('returns the trimmed pod name', async () => {
    mockRun.mockResolvedValue('  supabase-supabase-db-0  \n');
    expect(await getPostgresPod('1.2.3.4', '/path/to/key')).toBe('supabase-supabase-db-0');
  });
});

describe('sshRunScript', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue('');
  });

  it('uploads script then executes via bash remote-path then removes it', async () => {
    await sshRunScript('1.2.3.4', '/key', 'echo hello\necho world');

    // Three runCommandAsync calls expected: scp upload, ssh bash, ssh rm -f.
    expect(mockRun).toHaveBeenCalledTimes(3);

    const [upload] = mockRun.mock.calls[0] as [string[]];
    expect(upload[0]).toBe('scp');

    // Remote argv is POSIX-quoted + joined into one command string.
    const [exec] = mockRun.mock.calls[1] as [string[]];
    const execDashIdx = exec.indexOf('--');
    expect(exec[execDashIdx + 1]).toBe('root@1.2.3.4');
    expect(exec[execDashIdx + 2]).toMatch(/^'bash' '\/tmp\/vb-script-[^']+\.sh'$/);

    const [cleanup] = mockRun.mock.calls[2] as [string[]];
    const cleanDashIdx = cleanup.indexOf('--');
    expect(cleanup[cleanDashIdx + 1]).toBe('root@1.2.3.4');
    expect(cleanup[cleanDashIdx + 2]).toMatch(/^'rm' '-f' '\/tmp\/vb-script-[^']+\.sh'$/);
  });

  it('runs remote cleanup even when the script execution throws', async () => {
    // First call succeeds (scp upload), second rejects (bash), third is cleanup.
    mockRun
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('remote exit 1'))
      .mockResolvedValueOnce('');

    await expect(sshRunScript('1.2.3.4', '/key', 'false')).rejects.toThrow(/remote exit 1/);
    // Cleanup (3rd call) must still have been invoked.
    expect(mockRun).toHaveBeenCalledTimes(3);
    const [cleanup] = mockRun.mock.calls[2] as [string[]];
    expect(cleanup.some((s) => /^'rm' '-f'/.test(s))).toBe(true);
  });
});

describe('sshKubectl', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue('');
  });

  it('throws when given a string instead of argv', async () => {
    await expect(
      sshKubectl('1.2.3.4', '/key', 'kubectl get pods' as unknown as string[]),
    ).rejects.toThrow(/argv array/);
  });

  it('throws on an empty argv array', async () => {
    await expect(sshKubectl('1.2.3.4', '/key', [])).rejects.toThrow(/argv array/);
  });

  it('prepends env KUBECONFIG=... kubectl and POSIX-quotes the full remote argv', async () => {
    await sshKubectl('1.2.3.4', '/key', ['get', 'pods', '-n', 'vibecarbon']);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const dashIdx = cmd.indexOf('--');
    // Hostname, then one joined remote-command string. sshKubectl prepends
    // `env KUBECONFIG=... kubectl` in front of the user argv; sshRun quotes
    // every token so whitespace/metacharacters survive the remote shell's parse.
    expect(cmd[dashIdx + 1]).toBe('root@1.2.3.4');
    expect(cmd.slice(dashIdx + 2)).toEqual([
      "'env' 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml' 'kubectl' 'get' 'pods' '-n' 'vibecarbon'",
    ]);
  });

  it('preserves multi-word sh -c scripts inside kubectl exec (regression)', async () => {
    // The common pattern — kubectl exec POD -- sh -c '<pipeline>'. Before the
    // posix-quoting fix, the final token got word-split on the remote shell and
    // only the first word of the pipeline reached the pod's sh.
    await sshKubectl('1.2.3.4', '/key', [
      'exec',
      '-n',
      'vibecarbon',
      'postgres-0',
      '--',
      'sh',
      '-c',
      'gunzip -c /tmp/f.gz | psql -U supabase_admin postgres',
    ]);
    const [cmd] = mockRun.mock.calls[0] as [string[]];
    const dashIdx = cmd.indexOf('--');
    expect(cmd.slice(dashIdx + 2)).toEqual([
      "'env' 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml' 'kubectl' 'exec' '-n' 'vibecarbon' 'postgres-0' '--' 'sh' '-c' 'gunzip -c /tmp/f.gz | psql -U supabase_admin postgres'",
    ]);
  });
});

describe('SSH_TUNNEL_NO_MUX_OPTS — port-forward tunnels bypass multiplexing', () => {
  it('every -L tunnel argv in src carries ControlMaster=no AFTER the shared opts', async () => {
    // Run 31921730114: with mux on, EVERY compose admin tunnel first attempt
    // ECONNREFUSED through its whole reach poll (forward registration raced
    // the shared master); the pre-mux baseline had zero. Tunnels are one
    // long-lived connection — mux buys nothing and races lifecycle. This
    // census walks every `-L` ssh argv and demands the opt-out.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(process.cwd(), 'src', 'lib');
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.js')) files.push(p);
      }
    })(root);
    let tunnels = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (!/'-L',/.test(src)) continue;
      // Every argv block containing '-L' must also reference the opt-out.
      const blocks = src.split(/\]\s*[,)]/);
      for (const b of blocks) {
        if (!b.includes("'-L',") || !b.includes("'ssh'") === false) {
          if (b.includes("'-L',")) {
            tunnels++;
            expect(
              b.includes('SSH_TUNNEL_NO_MUX_OPTS'),
              `${file}: an ssh -L tunnel argv without SSH_TUNNEL_NO_MUX_OPTS — a muxed tunnel ` +
                'races its forward through the shared master',
            ).toBe(true);
          }
        }
      }
    }
    expect(tunnels).toBeGreaterThanOrEqual(2); // compose admin tunnel + registry push tunnel
  });

  it('the opt-out really overrides: OpenSSH takes the FIRST -o value, so it must PRECEDE the shared opts', async () => {
    // ssh_config(5): "unless noted otherwise, the first obtained value for
    // each parameter is used" — command-line -o included. Verified against
    // OpenSSH 9.6: `ssh -o ControlMaster=auto -o ControlMaster=no -G host`
    // resolves `controlmaster auto`. Run 31927810430 (post-band-aid-removal
    // verdict): the opt-out APPENDED after the shared opts was inert, both
    // compose scenarios failed at create-admin-user. This census walks every
    // `-L` tunnel argv in src and demands the opt-out spread come BEFORE the
    // shared-opts spread, so it is the value OpenSSH actually obtains first.
    const { SSH_TUNNEL_NO_MUX_OPTS, SSH_CONNECTION_OPTS } = await import(
      '../../../src/lib/host-keys.js'
    );
    expect(SSH_TUNNEL_NO_MUX_OPTS).toContain('ControlMaster=no');
    expect(SSH_TUNNEL_NO_MUX_OPTS).toContain('ControlPath=none');
    // Shared opts still carry mux for the per-call churn that needed it.
    expect(SSH_CONNECTION_OPTS).toContain('ControlMaster=auto');

    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(process.cwd(), 'src', 'lib');
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.js')) files.push(p);
      }
    })(root);
    // The spreads that inject ControlMaster=auto into an argv.
    const SHARED_OPT_SPREADS =
      /composeSshOpts\(|buildHostKeyOpts(?:ForPath)?\(|SSH_CONNECTION_OPTS/;
    let tunnels = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (!/'-L',/.test(src)) continue;
      for (const b of src.split(/\]\s*[,)]/)) {
        if (!b.includes("'-L',")) continue;
        tunnels++;
        const optOutIdx = b.indexOf('SSH_TUNNEL_NO_MUX_OPTS');
        const sharedMatch = SHARED_OPT_SPREADS.exec(b);
        expect(
          optOutIdx,
          `${file}: an ssh -L tunnel argv without SSH_TUNNEL_NO_MUX_OPTS`,
        ).toBeGreaterThan(-1);
        if (sharedMatch) {
          expect(
            optOutIdx,
            `${file}: SSH_TUNNEL_NO_MUX_OPTS appears AFTER the mux-carrying shared opts — ` +
              'OpenSSH takes the first -o value, so the opt-out is inert there',
          ).toBeLessThan(sharedMatch.index);
        }
      }
    }
    expect(tunnels).toBeGreaterThanOrEqual(2); // compose admin tunnel + registry push tunnel
  });
});
