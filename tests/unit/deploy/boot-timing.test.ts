/**
 * First-boot timing: the parsers behind `[perf] deploy.<prefix>.boot.<stage>`
 * and the collector's never-throw contract.
 *
 * The analyze fixtures in tests/fixtures/cloud-init-analyze/ follow the exact
 * format strings of cloud-init's own `analyze show` (print format
 * `%I%D @%Es +%ds`, `Finished stage: (%n) %d seconds`, `Total Time: %3.5f
 * seconds`) and `analyze blame` (`     %ds (%n)`, string-sorted in reverse,
 * one `-- Boot Record NN --` block per boot), from cloudinit/analyze/show.py
 * and cloudinit/analyze/__init__.py. The systemd fixture is a real
 * `systemd-analyze` first line shape (kernel + userspace, minutes included).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BOOT_MARK_LOG,
  BOOT_TIMING_SCRIPT,
  bootTimingPerfName,
  collectBootTiming,
  parseAnalyzeBlame,
  parseAnalyzeShow,
  parseBootMarkers,
  parseBootReport,
  parseSystemdAnalyze,
  summarizeBootTiming,
} from '../../../src/lib/deploy/boot-timing.js';

const fx = (name: string) =>
  readFileSync(join(__dirname, '../../fixtures/cloud-init-analyze', name), 'utf-8');

/** The report the remote script prints: one `==> <section> <==` per source. */
function report(parts: { markers?: string; show?: string; blame?: string; systemd?: string }) {
  return [
    '==> markers <==',
    parts.markers ?? '',
    '==> show <==',
    parts.show ?? '',
    '==> blame <==',
    parts.blame ?? '',
    '==> systemd <==',
    parts.systemd ?? '',
  ].join('\n');
}

describe('parseBootMarkers', () => {
  it('times each sequential phase up to the next mark, and the whole script', () => {
    const { phases, spans, totalMs } = parseBootMarkers(fx('k3s-master-markers.log'));
    expect(phases).toEqual([
      { name: 'preamble', ms: 282 },
      { name: 'apt', ms: 37516 },
      { name: 'network', ms: 7290 },
      { name: 'k3s.install', ms: 32346 },
      { name: 'k3s.ready', ms: 21456 },
      { name: 'addons', ms: 42300 },
    ]);
    expect(spans).toEqual([]);
    expect(totalMs).toBe(141190);
  });

  it('keeps a background span (begin/end) out of the sequential chain', () => {
    const { phases, spans, totalMs } = parseBootMarkers(fx('compose-markers.log'));
    expect(phases).toEqual([
      { name: 'docker', ms: 2800 },
      { name: 'apt', ms: 21600 },
      { name: 'ufw', ms: 2500 },
    ]);
    expect(spans).toEqual([{ name: 'bootPull', ms: 44300 }]);
    expect(totalMs).toBe(26900);
  });

  it('drops a span that never ended and ignores lines that are not marks', () => {
    const text = [
      'bootPull.begin 100.0',
      'garbage',
      'docker 100.5',
      'apt 101.5 trailing',
      'apt',
      'done 103.0',
      '',
    ].join('\n');
    const { phases, spans, totalMs } = parseBootMarkers(text);
    expect(phases).toEqual([{ name: 'docker', ms: 2500 }]);
    expect(spans).toEqual([]);
    expect(totalMs).toBe(2500);
  });

  it('returns nothing for an empty log, and never a negative duration', () => {
    expect(parseBootMarkers('')).toEqual({ phases: [], spans: [], totalMs: null });
    // A clock step backwards between marks must not become a negative timing.
    const { phases } = parseBootMarkers('a 200.0\nb 150.0\nc 160.0\n');
    expect(phases).toEqual([{ name: 'b', ms: 10000 }]);
  });
});

describe('parseAnalyzeShow', () => {
  it('reads the total and every stage of the boot record', () => {
    expect(parseAnalyzeShow(fx('k3s-show.txt'))).toEqual({
      totalMs: 144025,
      stages: [
        { name: 'init-local', ms: 1296 },
        { name: 'init-network', ms: 1237 },
        { name: 'modules-config', ms: 217 },
        { name: 'modules-final', ms: 141275 },
      ],
    });
  });

  it('reads only the first boot record (the provisioning boot) after a reboot', () => {
    const parsed = parseAnalyzeShow(fx('rebooted-show.txt'));
    expect(parsed?.totalMs).toBe(144025);
    expect(parsed?.stages).toHaveLength(4);
  });

  it('returns null when there is no boot record', () => {
    expect(parseAnalyzeShow('')).toBeNull();
    expect(parseAnalyzeShow('cloud-init: command not found\n')).toBeNull();
  });
});

describe('parseAnalyzeBlame', () => {
  it('lists the first boot record modules, slowest first by number', () => {
    const modules = parseAnalyzeBlame(fx('k3s-blame.txt'));
    expect(modules.slice(0, 3)).toEqual([
      { name: 'modules-final/config-scripts_user', ms: 141207 },
      { name: 'init-local/search-Hetzner', ms: 1284 },
      { name: 'init-network/config-ssh', ms: 611 },
    ]);
    // Only the provisioning boot: the reboot record adds nothing.
    expect(parseAnalyzeBlame(fx('rebooted-blame.txt'))).toEqual(modules);
  });

  it('sorts numerically, not by the padded strings cloud-init sorts', () => {
    const text = [
      '-- Boot Record 01 --',
      '     37.91200s (modules-final/config-scripts_user)',
      '     141.20700s (modules-final/config-package_update_upgrade_install)',
      '     01.28400s (init-local/search-Hetzner)',
      '',
      '1 boot records analyzed',
    ].join('\n');
    expect(parseAnalyzeBlame(text).map((m) => m.ms)).toEqual([141207, 37912, 1284]);
  });
});

describe('parseSystemdAnalyze', () => {
  it('reads every phase and the total, minutes included', () => {
    expect(parseSystemdAnalyze(fx('systemd-analyze.txt'))).toEqual([
      { name: 'kernel', ms: 2115 },
      { name: 'userspace', ms: 101336 },
      { name: 'total', ms: 103451 },
    ]);
  });

  it('reads firmware and loader phases and millisecond values', () => {
    const line =
      'Startup finished in 4.328s (firmware) + 2.895s (loader) + 811ms (kernel) + 10.994s (userspace) = 19.028s \n';
    expect(parseSystemdAnalyze(line)).toEqual([
      { name: 'firmware', ms: 4328 },
      { name: 'loader', ms: 2895 },
      { name: 'kernel', ms: 811 },
      { name: 'userspace', ms: 10994 },
      { name: 'total', ms: 19028 },
    ]);
  });

  it('returns nothing while boot is still running', () => {
    expect(
      parseSystemdAnalyze(
        'Bootup is not yet finished (org.freedesktop.systemd1.Manager.FinishTimestampMonotonic=0).\n',
      ),
    ).toEqual([]);
  });
});

describe('parseBootReport', () => {
  it('splits the remote report into its sections', () => {
    const parsed = parseBootReport(report({ markers: 'a 1.0\nb 2.0', systemd: 'x' }));
    expect(parsed).toEqual({
      skipped: null,
      markers: 'a 1.0\nb 2.0',
      show: '',
      blame: '',
      systemd: 'x',
    });
  });

  it('reports a skip with its reason', () => {
    expect(parseBootReport('==> skip <==\nalready-reported\n').skipped).toBe('already-reported');
  });
});

describe('summarizeBootTiming', () => {
  it('names every stage a k3s master reports', () => {
    const stages = summarizeBootTiming(
      parseBootReport(
        report({
          markers: fx('k3s-master-markers.log'),
          show: fx('k3s-show.txt'),
          blame: fx('k3s-blame.txt'),
          systemd: fx('systemd-analyze.txt'),
        }),
      ),
    );
    expect(stages).toEqual([
      { stage: 'cloudInit.total', ms: 144025 },
      { stage: 'cloudInit.stage.init-local', ms: 1296 },
      { stage: 'cloudInit.stage.init-network', ms: 1237 },
      { stage: 'cloudInit.stage.modules-config', ms: 217 },
      { stage: 'cloudInit.stage.modules-final', ms: 141275 },
      { stage: 'cloudInit.module.scripts_user', ms: 141207 },
      { stage: 'cloudInit.module.search-Hetzner', ms: 1284 },
      { stage: 'cloudInit.module.ssh', ms: 611 },
      { stage: 'cloudInit.module.growpart', ms: 412 },
      { stage: 'cloudInit.module.apt_configure', ms: 203 },
      { stage: 'script.total', ms: 141190 },
      { stage: 'script.preamble', ms: 282 },
      { stage: 'script.apt', ms: 37516 },
      { stage: 'script.network', ms: 7290 },
      { stage: 'script.k3s.install', ms: 32346 },
      { stage: 'script.k3s.ready', ms: 21456 },
      { stage: 'script.addons', ms: 42300 },
      { stage: 'script.unmarked', ms: 17 },
      { stage: 'systemd.kernel', ms: 2115 },
      { stage: 'systemd.userspace', ms: 101336 },
      { stage: 'systemd.total', ms: 103451 },
    ]);
  });

  it('times the unmarked runcmd head (a provider docker install) and the boot pull on compose', () => {
    const stages = summarizeBootTiming(
      parseBootReport(
        report({
          markers: fx('compose-markers.log'),
          show: fx('compose-show.txt'),
          blame: fx('compose-blame.txt'),
        }),
      ),
    );
    const byName = Object.fromEntries(stages.map((s) => [s.stage, s.ms]));
    expect(byName['cloudInit.total']).toBe(59167);
    expect(byName['cloudInit.module.package_update_upgrade_install']).toBe(18442);
    expect(byName['script.bootPull']).toBe(44300);
    expect(byName['script.unmarked']).toBe(37912 - 26900);
  });

  it('returns nothing for a skipped report', () => {
    expect(summarizeBootTiming(parseBootReport('==> skip <==\nno-marker-log\n'))).toEqual([]);
  });
});

describe('bootTimingPerfName', () => {
  it('is the deploy.<prefix>.boot.<stage> name the perf parser ingests', () => {
    expect(bootTimingPerfName('k3s.standby.master', 'script.apt')).toBe(
      'deploy.k3s.standby.master.boot.script.apt',
    );
  });
});

describe('BOOT_TIMING_SCRIPT', () => {
  it('reads the marker log, skips a node already reported, and bounds the cloud-init wait', () => {
    expect(BOOT_TIMING_SCRIPT).toContain(BOOT_MARK_LOG);
    expect(BOOT_TIMING_SCRIPT).toContain('==> skip <==');
    expect(BOOT_TIMING_SCRIPT).toMatch(/timeout \d+ cloud-init status --wait/);
    expect(BOOT_TIMING_SCRIPT).toContain('cloud-init analyze show');
    expect(BOOT_TIMING_SCRIPT).toContain('cloud-init analyze blame');
    expect(BOOT_TIMING_SCRIPT).toContain('systemd-analyze');
  });
});

describe('cloud-init phase marks', () => {
  const k3sDir = join(__dirname, '../../../carbon/cloud-init/k3s');
  const marksIn = (text: string) => [...text.matchAll(/^vc_mark (\S+)$/gm)].map((m) => m[1]);

  it.each([
    [
      'master-init.sh',
      ['preamble', 'apt', 'network', 'k3s.install', 'k3s.ready', 'addons', 'done'],
    ],
    [
      'do-master-init.sh',
      ['preamble', 'apt', 'network', 'k3s.install', 'k3s.ready', 'addons', 'done'],
    ],
    ['db-init.sh', ['preamble', 'apt', 'network', 'master.wait', 'k3s.install', 'done']],
    ['do-db-init.sh', ['preamble', 'apt', 'network', 'master.wait', 'k3s.install', 'done']],
    ['worker-init.sh', ['preamble', 'apt', 'network', 'master.wait', 'k3s.install', 'done']],
    ['do-worker-init.sh', ['preamble', 'apt', 'network', 'master.wait', 'k3s.install', 'done']],
  ])('%s marks its phases in order, into the log the collector reads', (file, phases) => {
    const text = readFileSync(join(k3sDir, file), 'utf-8');
    expect(marksIn(text)).toEqual(phases);
    // The helper is defined before its first use and can never fail the script
    // (these run under `set -euo pipefail`).
    const def = text.indexOf('vc_mark() {');
    expect(def).toBeGreaterThan(-1);
    expect(def).toBeLessThan(text.indexOf('vc_mark preamble'));
    expect(text).toContain(`>> ${BOOT_MARK_LOG} || true; }`);
    // The master's ready flag is written after its last mark.
    if (file.includes('master')) {
      expect(text.indexOf('vc_mark done')).toBeLessThan(text.indexOf('touch /tmp/k3s-ready'));
    }
  });

  it('the compose cloud-config marks its runcmd phases and brackets the boot pull', () => {
    const text = readFileSync(
      join(__dirname, '../../../carbon/cloud-init/docker-ce-setup.yaml'),
      'utf-8',
    );
    const runcmdMarks = [
      ...text.matchAll(
        /^ {2}- \[sh, -c, 'echo "(\S+) \$\(date \+%s\.%N\)" >> (\S+) \|\| true'\]$/gm,
      ),
    ];
    expect(runcmdMarks.map((m) => m[1])).toEqual(['docker', 'apt', 'ufw', 'done']);
    for (const m of runcmdMarks) expect(m[2]).toBe(BOOT_MARK_LOG);
    expect(text).toContain(`echo "bootPull.begin $(date +%s.%N)" >> ${BOOT_MARK_LOG} || true`);
    expect(text).toContain(`echo "bootPull.end $(date +%s.%N)" >> ${BOOT_MARK_LOG} || true`);
    // The ready marker the deploy waits on still comes before the last mark.
    expect(text.indexOf('/var/lib/vibecarbon/ready')).toBeLessThan(text.indexOf('"done $(date'));
  });
});

describe('collectBootTiming', () => {
  const goodReport = report({
    markers: fx('k3s-master-markers.log'),
    show: fx('k3s-show.txt'),
    blame: fx('k3s-blame.txt'),
  });

  it('runs the script over argv-only ssh with a bounded timeout and emits one line per stage', async () => {
    const run = vi.fn(async () => goodReport);
    const emit = vi.fn();
    const warn = vi.fn();
    const result = await collectBootTiming({
      ip: '203.0.113.7',
      sshKeyPath: '/k',
      prefix: 'k3s.master',
      enabled: true,
      run,
      emit,
      warn,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [ip, key, argv, opts] = run.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      { input: string; timeout: number; transportRetry: boolean },
    ];
    expect([ip, key, argv]).toEqual(['203.0.113.7', '/k', ['sh', '-s']]);
    expect(opts.input).toBe(BOOT_TIMING_SCRIPT);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(300_000);
    expect(opts.transportRetry).toBe(false);
    expect(emit).toHaveBeenCalledWith('deploy.k3s.master.boot.cloudInit.total', 144025);
    expect(emit).toHaveBeenCalledWith('deploy.k3s.master.boot.script.k3s.install', 32346);
    expect(warn).not.toHaveBeenCalled();
    expect(result.stages.length).toBe(emit.mock.calls.length);
  });

  it('does nothing when perf tracing is off', async () => {
    const run = vi.fn(async () => goodReport);
    const result = await collectBootTiming({
      ip: '203.0.113.7',
      sshKeyPath: '/k',
      prefix: 'compose',
      enabled: false,
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.stages).toEqual([]);
  });

  it('stays silent on a node already reported or provisioned before the markers', async () => {
    const emit = vi.fn();
    const warn = vi.fn();
    await collectBootTiming({
      ip: 'x',
      sshKeyPath: '/k',
      prefix: 'compose',
      enabled: true,
      run: async () => '==> skip <==\nalready-reported',
      emit,
      warn,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws: an ssh failure becomes one warning', async () => {
    const warn = vi.fn();
    const emit = vi.fn();
    await expect(
      collectBootTiming({
        ip: 'x',
        sshKeyPath: '/k',
        prefix: 'ha.compose.standby',
        enabled: true,
        run: async () => {
          throw new Error('ssh: connect to host x port 22: Connection timed out');
        },
        emit,
        warn,
      }),
    ).resolves.toMatchObject({ stages: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ha.compose.standby');
    expect(String(warn.mock.calls[0][0])).not.toContain('—');
    expect(emit).not.toHaveBeenCalled();
  });

  it('never throws on a synchronous throw, a throwing emitter, or a throwing warner', async () => {
    await expect(
      collectBootTiming({
        ip: 'x',
        sshKeyPath: '/k',
        prefix: 'compose',
        enabled: true,
        run: () => {
          throw new Error('boom');
        },
        warn: () => {
          throw new Error('warn boom');
        },
      }),
    ).resolves.toBeDefined();
    const warn = vi.fn();
    await expect(
      collectBootTiming({
        ip: 'x',
        sshKeyPath: '/k',
        prefix: 'compose',
        enabled: true,
        run: async () => goodReport,
        emit: () => {
          throw new Error('emit boom');
        },
        warn,
      }),
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once when the report has no timing in it', async () => {
    const warn = vi.fn();
    await collectBootTiming({
      ip: 'x',
      sshKeyPath: '/k',
      prefix: 'compose',
      enabled: true,
      run: async () => report({}),
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
