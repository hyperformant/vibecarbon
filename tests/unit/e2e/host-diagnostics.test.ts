/**
 * Unit tests for the host-level half of the e2e failure bundle
 * (tests/e2e/utils/host-diagnostics.ts).
 *
 * Motivation: a DO k8s-ha deploy failed while the standby's pgdata swap pod
 * ran. The standby master's k3s API refused :6443 and never came back within
 * 5 minutes, and every kubectl section for that cluster said only
 * "connection refused". Why k3s died (OOM on an s-2vcpu-4gb master, a full
 * disk, a crash loop) lives on the host, reachable over ssh while the API is
 * not.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildHostDiagnosticScript,
  collectHostDiagnostics,
  findClusterHosts,
  HOST_DIAG_SECTIONS,
  HOST_DIAG_SSH_TIMEOUT_MS,
  hostDiagnosticArgv,
  redactHostDiagnostics,
  splitHostDiagnosticOutput,
} from '../../e2e/utils/host-diagnostics.js';

describe('buildHostDiagnosticScript', () => {
  const server = buildHostDiagnosticScript('k3s');
  const agent = buildHostDiagnosticScript('k3s-agent');

  it('runs the asked-for commands against the k3s unit on a server', () => {
    expect(server).toContain('systemctl status k3s --no-pager -l');
    expect(server).toContain('journalctl -u k3s --since=-30min --no-pager');
    expect(server).toContain('tail -200');
    expect(server).toContain(
      "dmesg -T 2>&1 | grep -i -E 'oom|killed process|out of memory' | tail -40",
    );
    expect(server).toContain('free -m');
    expect(server).toContain('df -h /var/lib/rancher /var/lib/kubelet /');
    expect(server).toContain('uptime');
    expect(server).toContain('ps -eo pid,rss,etime,cmd --sort=-rss');
    expect(server).toContain('head -15');
  });

  it('uses k3s-agent on an agent node', () => {
    expect(agent).toContain('systemctl status k3s-agent --no-pager -l');
    expect(agent).toContain('journalctl -u k3s-agent --since=-30min --no-pager');
    expect(agent).not.toMatch(/-u k3s /);
  });

  it('refuses a unit it does not know', () => {
    expect(() => buildHostDiagnosticScript('sshd; rm -rf /' as never)).toThrow();
  });

  it('bounds every command with timeout and marks every section', () => {
    for (const script of [server, agent]) {
      const cmds = ['systemctl', 'journalctl', 'dmesg', 'free', 'df', 'uptime', 'ps'];
      for (const c of cmds) expect(script).toMatch(new RegExp(`timeout \\d+ ${c}\\b`));
      const unit = script === server ? 'k3s' : 'k3s-agent';
      for (const s of HOST_DIAG_SECTIONS) {
        expect(script).toContain(`@@vc-section ${s.name.replace('{unit}', unit)}`);
      }
      // The script always exits 0: a failed probe is output, not an ssh error.
      expect(script.trimEnd().endsWith('true')).toBe(true);
    }
  });

  it('is one bash -c argv for sshRun (which quotes each element)', () => {
    expect(hostDiagnosticArgv('k3s')).toEqual(['bash', '-c', server]);
  });
});

describe('splitHostDiagnosticOutput', () => {
  it('splits by section marker and caps each section', () => {
    const big = 'x'.repeat(50_000);
    const out = [
      'noise before',
      '@@vc-section k3s status',
      'active (running)',
      '@@vc-section k3s journal',
      big,
      '@@vc-section top processes by RSS',
      '  PID   RSS ELAPSED CMD',
    ].join('\n');
    const sections = splitHostDiagnosticOutput(out);
    expect(sections.map(([n]) => n)).toEqual(['k3s status', 'k3s journal', 'top processes by RSS']);
    expect(sections[0][1]).toBe('active (running)');
    const journalCap = HOST_DIAG_SECTIONS.find((s) => s.name === '{unit} journal')?.maxChars ?? 0;
    expect(sections[1][1].length).toBeLessThanOrEqual(journalCap + 40);
    expect(sections[1][1]).toContain('(truncated');
  });

  it('keeps the tail of a capped section (the newest journal lines)', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line-${i}`).join('\n');
    const [[, text]] = splitHostDiagnosticOutput(`@@vc-section k3s journal\n${lines}`);
    expect(text).toContain('line-3999');
    expect(text).not.toContain('line-0\n');
  });

  it('empty output is one placeholder section', () => {
    expect(splitHostDiagnosticOutput('')).toEqual([['output', '(no output)']]);
  });
});

describe('redactHostDiagnostics', () => {
  const K3S_TOKEN = `K10${'a1'.repeat(32)}::server:${'f0'.repeat(16)}`;
  const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

  it('masks a k3s join token wherever it appears', () => {
    const out = redactHostDiagnostics(`k3s[812]: joining with ${K3S_TOKEN} now`);
    expect(out).not.toContain(K3S_TOKEN);
    expect(out).not.toContain('f0f0f0f0');
    expect(out).toContain('<redacted>');
  });

  it('masks --token and --agent-token flags in a process list', () => {
    const ps = `  812 900000 1:02 /usr/local/bin/k3s server --token s3cr3tvalue --agent-token=an0ther --node-ip 10.0.0.2`;
    const out = redactHostDiagnostics(ps);
    expect(out).not.toContain('s3cr3tvalue');
    expect(out).not.toContain('an0ther');
    expect(out).toContain('--node-ip 10.0.0.2');
  });

  it('masks JWTs, bootstrap tokens and key=value credentials', () => {
    const out = redactHostDiagnostics(
      [
        `Authorization: Bearer ${JWT}`,
        `serviceaccount token ${JWT}`,
        'bootstrap token abcdef.0123456789abcdef used',
        'K3S_TOKEN=plainsecret',
        'url https://user:pw@example.com/x',
      ].join('\n'),
    );
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('0123456789abcdef');
    expect(out).not.toContain('plainsecret');
    expect(out).not.toContain('user:pw');
  });

  it('leaves ordinary diagnostics alone', () => {
    const text = [
      'Active: failed (Result: oom-kill) since Sun 2026-11-01 10:00:00 UTC',
      '[Sun Nov  1 10:00:00 2026] Out of memory: Killed process 812 (k3s-server)',
      'Mem:           3911        3800          20',
      '/dev/vda1        78G   12G   66G  16% /',
    ].join('\n');
    expect(redactHostDiagnostics(text)).toBe(text);
  });
});

describe('findClusterHosts', () => {
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hostdiag-'));
    mkdirSync(join(dir, '.vibecarbon'));
    return dir;
  };
  const state = (dir: string, stackEnv: string, result: Record<string, unknown>) =>
    writeFileSync(
      join(dir, '.vibecarbon', `deploy-state-${stackEnv}.json`),
      JSON.stringify({ version: 2, steps: { 'k3s-infra': { status: 'completed', result } } }),
    );

  it('reads master and db of both HA clusters from the deploy state, mid-deploy', () => {
    const dir = project();
    state(dir, 'e3-primary', { masterIp: '1.1.1.1', dbIp: '1.1.1.2' });
    state(dir, 'e3-standby', { masterIp: '2.2.2.1', dbIp: '2.2.2.2' });
    // Another env's state is not this scenario's.
    state(dir, 'e30', { masterIp: '9.9.9.9', dbIp: '9.9.9.8' });
    expect(findClusterHosts(dir, 'e3')).toEqual([
      { label: 'e3-primary master', ip: '1.1.1.1', unit: 'k3s' },
      { label: 'e3-primary db', ip: '1.1.1.2', unit: 'k3s-agent' },
      { label: 'e3-standby master', ip: '2.2.2.1', unit: 'k3s' },
      { label: 'e3-standby db', ip: '2.2.2.2', unit: 'k3s-agent' },
    ]);
  });

  it('reads a single cluster from the deploy state', () => {
    const dir = project();
    state(dir, 'e3', { masterIp: '1.1.1.1', dbIp: '1.1.1.2' });
    expect(findClusterHosts(dir, 'e3').map((h) => h.label)).toEqual(['e3 master', 'e3 db']);
  });

  it('falls back to .vibecarbon.json, then to the kubeconfig server address', () => {
    const dir = project();
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        environments: {
          e3: { ha: { enabled: true, primary: { masterIp: '1.1.1.1', dbIp: '1.1.1.2' } } },
        },
      }),
    );
    writeFileSync(
      join(dir, '.vibecarbon', 'kubeconfig-e3-standby'),
      'apiVersion: v1\nclusters:\n- cluster:\n    server: https://2.2.2.1:6443\n  name: default\n',
    );
    expect(findClusterHosts(dir, 'e3')).toEqual([
      { label: 'primary master', ip: '1.1.1.1', unit: 'k3s' },
      { label: 'primary db', ip: '1.1.1.2', unit: 'k3s-agent' },
      { label: 'kubeconfig-e3-standby master', ip: '2.2.2.1', unit: 'k3s' },
    ]);
  });

  it('nothing on disk is no hosts, never a throw', () => {
    expect(findClusterHosts(project(), 'e3')).toEqual([]);
    expect(findClusterHosts('/nonexistent/dir', 'e3')).toEqual([]);
  });

  it('never reads an address that is not an IPv4 literal', () => {
    const dir = project();
    state(dir, 'e3', { masterIp: '1.1.1.1; reboot', dbIp: 'db.example.com' });
    expect(findClusterHosts(dir, 'e3')).toEqual([]);
  });
});

describe('collectHostDiagnostics', () => {
  const hosts = [
    { label: 'e3-standby master', ip: '2.2.2.1', unit: 'k3s' as const },
    { label: 'e3-standby db', ip: '2.2.2.2', unit: 'k3s-agent' as const },
  ];

  it('one bounded ssh per host with the scenario key, sections labelled and redacted', async () => {
    const run = vi.fn(async (ip: string) =>
      ip === '2.2.2.1'
        ? '@@vc-section k3s status\nActive: failed (Result: oom-kill)\n@@vc-section top processes by RSS\nk3s server --token hunter2'
        : '@@vc-section k3s-agent status\nActive: active (running)',
    );
    const sections = await collectHostDiagnostics({
      hosts,
      sshKeyPath: '/p/.vibecarbon/deploy_key_e3',
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    const [ip, key, argv, opts] = run.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(ip).toBe('2.2.2.1');
    expect(key).toBe('/p/.vibecarbon/deploy_key_e3');
    expect(argv).toEqual(hostDiagnosticArgv('k3s'));
    expect(opts).toMatchObject({ timeout: HOST_DIAG_SSH_TIMEOUT_MS, transportRetry: false });
    expect((run.mock.calls[1] as unknown as [string, string, string[]])[2]).toEqual(
      hostDiagnosticArgv('k3s-agent'),
    );
    expect(sections.map(([l]) => l)).toEqual([
      'host e3-standby master (2.2.2.1): k3s status',
      'host e3-standby master (2.2.2.1): top processes by RSS',
      'host e3-standby db (2.2.2.2): k3s-agent status',
    ]);
    expect(sections.map(([, t]) => t).join('\n')).not.toContain('hunter2');
  });

  it('an ssh failure is one section naming it, redacted, and the others still run', async () => {
    const run = vi.fn(async (ip: string) => {
      if (ip === '2.2.2.1') {
        throw Object.assign(new Error('Command failed: ssh ... --token leaked\nmore'), {
          stdout: 'partial K3S_TOKEN=abc',
        });
      }
      return '@@vc-section k3s-agent status\nok';
    });
    const sections = await collectHostDiagnostics({ hosts, sshKeyPath: '/k', run });
    expect(sections[0][0]).toBe('host e3-standby master (2.2.2.1)');
    expect(sections[0][1]).toMatch(/^\(ssh failed: /);
    expect(sections[0][1]).not.toContain('leaked');
    expect(sections[0][1]).not.toContain('abc');
    expect(sections[1][0]).toBe('host e3-standby db (2.2.2.2): k3s-agent status');
  });

  it('no key or no hosts is one skip section', async () => {
    const run = vi.fn();
    expect(await collectHostDiagnostics({ hosts, sshKeyPath: null, run })).toEqual([
      ['host diagnostics', '(skipped: no ssh key for this scenario)'],
    ]);
    expect(await collectHostDiagnostics({ hosts: [], sshKeyPath: '/k', run })).toEqual([
      ['host diagnostics', '(skipped: no cluster node addresses in deploy state or config)'],
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});
