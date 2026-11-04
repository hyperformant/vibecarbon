/**
 * Final review minors on the failover flows.
 *
 * M1 compose: the role swap (which clears the journal) is saved right after
 *    the DNS verdict, before the TLS wait, so a crash during minutes of
 *    certificate issuance never leaves a finished failover looking mid-flight.
 * M2 compose: after the promote the wal-g role is only checked, never moved:
 *    the arm wrote the role file before pg_promote (D2). The post-promote
 *    step reads the role file and runs the audit; it writes nothing and
 *    recreates nothing.
 * M3 k8s: a config without ha.primary / ha.standby is refused in preflight,
 *    before anything is written, instead of reaching the end of a promote
 *    where swapHaRoles could only warn and leave the journal set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { auditComposeWalgRole } from '../../../src/lib/deploy/compose/ha.js';

const ROOT = join(__dirname, '../../..');

describe('M1: compose saves the swap before the TLS wait', () => {
  it('flip < swap save < TLS wait, in failoverComposeHA', () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/compose/ha.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function failoverComposeHA('));
    const flip = body.indexOf('dnsFlip = await flipDns(');
    const swap = body.indexOf('swapRoles(envName');
    const tls = body.indexOf('await waitForTrustedTls(');
    expect(flip).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(flip);
    expect(tls).toBeGreaterThan(swap);
  });
});

describe('M2: auditComposeWalgRole reads the role file and audits; it moves nothing', () => {
  const make = (role: string) => {
    const commands: string[] = [];
    const audit = vi.fn(async () => {});
    const run = vi.fn(async (_ip: string, _k: string, command: string) => {
      commands.push(command);
      if (command.includes('WALG_ROLE_FILE')) return `WALG_ROLE_FILE=${role}\n`;
      return '';
    });
    return {
      commands,
      audit,
      go: () =>
        auditComposeWalgRole({
          promotedIp: '10.0.0.2',
          sshKeyPath: '/k',
          projectName: 'myapp',
          deps: { run, audit, log: () => {} },
        }),
    };
  };

  it('primary: the audit proves it; no role write, no recreate', async () => {
    const m = make('primary');
    await expect(m.go()).resolves.toEqual({ ok: true });
    expect(m.audit).toHaveBeenCalledOnce();
    expect(m.commands[0]).toContain('/opt/myapp/.vibecarbon-role/walg-role');
    expect(m.commands.some((c) => c.includes('walg-role.tmp'))).toBe(false);
    expect(m.commands.some((c) => c.includes('up -d'))).toBe(false);
  });

  it('standby: not ok, names what it read, marks the role not primary; no write, no audit', async () => {
    const m = make('standby');
    const health = await m.go();
    expect(health).toMatchObject({ ok: false, rolePrimary: false });
    expect(health.error?.message).toMatch(/reads "standby"/);
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.commands.some((c) => c.includes('walg-role.tmp'))).toBe(false);
  });
});

describe('M3: k8s preflight refuses a config the swap could not persist', () => {
  it('no ha.primary: exits before any write, with the deploy hint', async () => {
    const { preflightPilotFailover } = await import('../../../src/failover.js');
    const p = await import('@clack/prompts');
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const resolveCreds = vi.fn();
    try {
      await expect(
        preflightPilotFailover(
          'prod',
          {
            ha: {
              enabled: true,
              standbyWorkerSpec: { count: 1, serverType: 'cx33' },
              scaleUpList: [{ name: 'app', replicas: 2 }],
              standby: { masterIp: '10.2.0.1', stack: 'prod-standby' },
            },
          },
          { resolveCreds },
        ),
      ).rejects.toThrow('exit 1');
      expect(error.mock.calls[0][0]).toMatch(/run `vibecarbon deploy` first/);
      expect(resolveCreds).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
