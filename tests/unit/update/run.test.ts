import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  out: [] as string[],
  json: [] as unknown[],
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  requireTTYOrFlags: vi.fn(),
  exitCancelled: vi.fn(),
  exitDeclined: vi.fn(),
  listUpdateTargets: vi.fn(),
  inspectAll: vi.fn(),
  executeUpdatePlan: vi.fn(),
  releaseLeftoverCordons: vi.fn(),
  ensureOperatorIpAccess: vi.fn(),
  exists: true,
}));

vi.mock('@clack/prompts', () => {
  const log = (m_: string) => m.out.push(String(m_));
  return {
    log: { info: log, warn: log, error: log, success: log, step: log, message: log },
    outro: log,
    confirm: m.confirm,
    isCancel: m.isCancel,
  };
});
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  existsSync: () => m.exists,
}));
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => ({ projectName: 'proj', environments: { prod: {} } }),
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/cli/env-context.js', () => ({
  resolveEnvContext: async () => ({
    envName: 'prod',
    envConfig: { deployMode: 'compose', domain: 'app.example.com', servers: [] },
  }),
}));
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ requireTTYOrFlags: m.requireTTYOrFlags }));
vi.mock('../../../src/lib/cli/exit-guard.js', () => ({
  exitCancelled: m.exitCancelled,
  exitDeclined: m.exitDeclined,
}));
vi.mock('../../../src/lib/cli/json-mode.js', () => ({ writeJson: (v: unknown) => m.json.push(v) }));
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: m.ensureOperatorIpAccess,
}));
vi.mock('../../../src/lib/providers/index.js', () => ({
  providerIdFor: () => 'hetzner',
  resolveProviderToken: () => 'tok',
}));
vi.mock('../../../src/lib/ssh.js', () => ({ sshKeyPathFor: () => '/keys/prod' }));
vi.mock('../../../src/lib/update/inventory.js', () => ({ listUpdateTargets: m.listUpdateTargets }));
vi.mock('../../../src/lib/update/inspect.js', () => ({ inspectAll: m.inspectAll }));
vi.mock('../../../src/lib/update/execute.js', () => ({
  executeUpdatePlan: m.executeUpdatePlan,
  releaseLeftoverCordons: m.releaseLeftoverCordons,
}));

import { AmbiguousPrimaryError } from '../../../src/lib/cli/resolve-primary.js';
import {
  allClearLine,
  confirmQuestion,
  nothingToDoLine,
  recheckSkippedLine,
  unexpectedRestartYesLine,
} from '../../../src/lib/update/text.js';
import { run } from '../../../src/update.js';

const target = {
  name: 'master',
  ip: '1.2.3.4',
  side: 'primary',
  role: 'server',
  kind: 'compose',
};
const host = (rebootRequired: boolean) => ({ rebootRequired, packages: [] });
const state = (ubuntu: string[], rebootRequired = false) => ({
  host: host(rebootRequired),
  bootId: 'b',
  ubuntu,
  docker: null,
});
const outcome = (over = {}) => ({
  name: 'master',
  installed: 2,
  docker: null,
  restarted: false,
  outageSeconds: 0,
  error: null,
  hint: null,
  ...over,
});

function setup({ ubuntu = ['a', 'b'], skipped = [] as unknown[] } = {}) {
  m.listUpdateTargets.mockResolvedValue({ tier: 'compose', targets: [target], skipped });
  m.inspectAll.mockResolvedValue({ inspected: [{ target, state: state(ubuntu) }], skipped: [] });
}

let exitCode: number | null;

beforeEach(() => {
  vi.resetAllMocks();
  m.out.length = 0;
  m.json.length = 0;
  m.exists = true;
  exitCode = null;
  m.confirm.mockResolvedValue(true);
  m.isCancel.mockReturnValue(false);
  m.releaseLeftoverCordons.mockResolvedValue({ released: [], failed: [] });
  m.ensureOperatorIpAccess.mockResolvedValue({ added: false });
  m.executeUpdatePlan.mockResolvedValue({ outcomes: [outcome()], becameDue: [], stoppedAt: null });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit ${code}`);
  }) as never);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

const go = async (args: string[]) => {
  try {
    await run(args);
  } catch (e) {
    if (!/^exit /.test((e as Error).message)) throw e;
  }
};
const text = () => m.out.join('\n');

describe('update run', () => {
  it('inspects with the env name so the ssh key resolves', async () => {
    setup({ ubuntu: [] });
    await go(['prod']);
    expect(m.inspectAll.mock.calls[0][1]).toMatchObject({ envName: 'prod' });
  });

  it('refreshes the operator-IP firewall allowlist before touching servers', async () => {
    setup({ ubuntu: [] });
    await go(['prod']);
    expect(m.ensureOperatorIpAccess).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'prod', apiToken: 'tok' }),
    );
  });

  it('nothing to do: prints the line, no confirm, exit 0', async () => {
    setup({ ubuntu: [] });
    await go(['prod']);
    expect(text()).toContain(nothingToDoLine('prod'));
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
    expect(exitCode).toBeNull();
  });

  it('nothing to do with -json prints the JSON', async () => {
    setup({ ubuntu: [] });
    await go(['prod', '-json']);
    expect(m.json).toHaveLength(1);
    expect(m.json[0]).toMatchObject({
      env: 'prod',
      tier: 'compose',
      plan: [expect.anything()],
      outcomes: [],
    });
  });

  it('off a TTY without -y: prints the plan, asks for -y, never executes', async () => {
    setup();
    m.requireTTYOrFlags.mockImplementation(() => {
      throw new Error('exit 1');
    });
    await go(['prod']);
    expect(text()).toContain('update plan for prod (compose)');
    expect(m.requireTTYOrFlags).toHaveBeenCalledWith({
      requirements: [
        {
          flag: 'y',
          description: 'apply this plan without the confirmation prompt',
          satisfied: false,
        },
      ],
    });
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
  });

  it('on a TTY, asks the confirm question and runs on yes', async () => {
    setup();
    await go(['prod']);
    expect(m.confirm).toHaveBeenCalledWith({
      message: confirmQuestion('prod'),
      initialValue: false,
    });
    expect(m.executeUpdatePlan).toHaveBeenCalledTimes(1);
  });

  it('a declined confirm exits through exitDeclined and never executes', async () => {
    setup();
    m.confirm.mockResolvedValue(false);
    m.exitDeclined.mockImplementation(() => {
      throw new Error('exit 1');
    });
    await go(['prod']);
    expect(m.exitDeclined).toHaveBeenCalled();
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
  });

  it('a cancelled confirm exits through exitCancelled', async () => {
    setup();
    m.isCancel.mockReturnValue(true);
    m.exitCancelled.mockImplementation(() => {
      throw new Error('exit 130');
    });
    await go(['prod']);
    expect(m.exitCancelled).toHaveBeenCalled();
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
  });

  it('-y skips the prompt and the TTY guard', async () => {
    setup();
    await go(['prod', '-y']);
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.requireTTYOrFlags).not.toHaveBeenCalled();
    expect(m.executeUpdatePlan).toHaveBeenCalledTimes(1);
    const ctx = m.executeUpdatePlan.mock.calls[0][1];
    expect(ctx).toMatchObject({
      envName: 'prod',
      sshKeyPath: '/keys/prod',
      domain: 'app.example.com',
      projectName: 'proj',
      yes: true,
    });
  });

  it('prints the summary, then the all-clear when no restart is due after', async () => {
    setup();
    await go(['prod', '-y']);
    expect(text()).toContain('master: installed 2 updates');
    expect(text()).toContain(allClearLine());
  });

  it('no all-clear when a reached server still needs a restart', async () => {
    setup();
    m.inspectAll
      .mockResolvedValueOnce({ inspected: [{ target, state: state(['a', 'b']) }], skipped: [] })
      .mockResolvedValueOnce({ inspected: [{ target, state: state([], true) }], skipped: [] });
    await go(['prod', '-y']);
    expect(text()).not.toContain(allClearLine());
  });

  it('prints a line for a restart that became due', async () => {
    setup();
    m.executeUpdatePlan.mockResolvedValue({
      outcomes: [outcome()],
      becameDue: [{ name: 'master', package: 'linux-image' }],
      stoppedAt: null,
    });
    await go(['prod', '-y']);
    expect(text()).toContain(
      unexpectedRestartYesLine({ envName: 'prod', name: 'master', pkg: 'linux-image' }),
    );
    expect(text()).not.toContain(allClearLine());
  });

  it('a stopped run prints error and hint, exits 1, and never re-reads', async () => {
    setup();
    m.executeUpdatePlan.mockResolvedValue({
      outcomes: [outcome({ error: 'could not install', hint: 'run it again' })],
      becameDue: [],
      stoppedAt: { name: 'master', error: 'could not install', hint: 'run it again' },
    });
    await go(['prod', '-y']);
    expect(m.inspectAll).toHaveBeenCalledTimes(1);
    expect(text()).toContain('could not install');
    expect(text()).toContain('run it again');
    expect(exitCode).toBe(1);
  });

  it('-json -y prints a parseable document with measuredDowntimeSeconds', async () => {
    setup();
    m.executeUpdatePlan.mockResolvedValue({
      outcomes: [outcome({ outageSeconds: 12.5 }), outcome({ name: 'x', outageSeconds: null })],
      becameDue: [],
      stoppedAt: null,
    });
    await go(['prod', '-json', '-y']);
    const doc = JSON.parse(JSON.stringify(m.json[0]));
    expect(doc.measuredDowntimeSeconds).toBe(12.5);
    expect(doc.plan[0]).toEqual({
      name: 'master',
      role: 'server',
      side: 'primary',
      install: 2,
      docker: null,
      restart: 'none',
      restartReason: null,
      installReporter: false,
      expectedSeconds: null,
    });
    expect(doc.expectedDowntime).toBeNull();
    expect(doc.skipped).toEqual([]);
    expect(doc.becameDue).toEqual([]);
    expect(doc.uncordon).toEqual([]);
    expect(doc.uncordonFailed).toEqual([]);
    expect(doc.stillDue).toEqual([]);
  });

  it('measuredDowntimeSeconds is null when every step is unmeasured', async () => {
    setup();
    m.executeUpdatePlan.mockResolvedValue({
      outcomes: [outcome({ outageSeconds: null })],
      becameDue: [],
      stoppedAt: null,
    });
    await go(['prod', '-json', '-y']);
    expect((m.json[0] as { measuredDowntimeSeconds: unknown }).measuredDowntimeSeconds).toBeNull();
  });

  it('-json without -y prints the plan with no outcomes and changes nothing', async () => {
    setup();
    await go(['prod', '-json']);
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.json[0]).toMatchObject({ outcomes: [], env: 'prod' });
    expect(exitCode).toBeNull();
  });

  it('an ambiguous primary prints why and exits 1 without planning', async () => {
    m.listUpdateTargets.mockRejectedValue(new AmbiguousPrimaryError('two primaries', 'prod'));
    await go(['prod', '-y']);
    expect(text()).toContain('two primaries');
    expect(exitCode).toBe(1);
    expect(m.inspectAll).not.toHaveBeenCalled();
  });

  it('a missing ssh key exits 1 before listing anything', async () => {
    m.exists = false;
    await go(['prod', '-y']);
    expect(exitCode).toBe(1);
    expect(m.listUpdateTargets).not.toHaveBeenCalled();
  });

  describe('a node an interrupted update left cordoned', () => {
    const w = {
      ...target,
      role: 'worker',
      kind: 'k8s',
      masterIp: '9.9.9.9',
      name: 'w1',
      nodeName: 'w1',
      reporting: true,
    };
    const mm = { ...w, role: 'master', name: 'm', nodeName: 'm' };
    const leftovers = [{ name: 'w1', masterIp: '9.9.9.9' }];
    const idle = state([]);
    const k8sSetup = () => {
      m.listUpdateTargets.mockResolvedValue({
        tier: 'k8s',
        targets: [w, mm],
        skipped: [],
        leftovers,
      });
      m.inspectAll.mockResolvedValue({
        inspected: [
          { target: w, state: idle },
          { target: mm, state: idle },
        ],
        skipped: [],
      });
      m.releaseLeftoverCordons.mockResolvedValue({ released: ['w1'], failed: [] });
    };
    const UNCORDON_LINE = 'uncordon w1, left cordoned by an interrupted update';

    it('is in the plan and counts as work, released only after the confirmation', async () => {
      k8sSetup();
      const order: string[] = [];
      m.confirm.mockImplementation(async () => {
        order.push('confirm');
        return true;
      });
      m.releaseLeftoverCordons.mockImplementation(async () => {
        order.push('release');
        return { released: ['w1'], failed: [] };
      });
      m.executeUpdatePlan.mockImplementation(async () => {
        order.push('execute');
        return { outcomes: [outcome({ name: 'w1' })], becameDue: [], stoppedAt: null };
      });
      await go(['prod']);
      expect(text()).toContain(UNCORDON_LINE);
      expect(text()).not.toContain(nothingToDoLine('prod'));
      expect(order).toEqual(['confirm', 'release', 'execute']);
      expect(m.releaseLeftoverCordons).toHaveBeenCalledWith(
        leftovers,
        expect.objectContaining({ sshKeyPath: '/keys/prod' }),
      );
      expect(text()).toContain('uncordoned w1, left from an earlier update');
      expect(exitCode).toBeNull();
    });

    it('a -json dry run lists it and changes nothing in the cluster', async () => {
      k8sSetup();
      await go(['prod', '-json']);
      expect(m.releaseLeftoverCordons).not.toHaveBeenCalled();
      expect(m.executeUpdatePlan).not.toHaveBeenCalled();
      expect((m.json[0] as { uncordon: unknown }).uncordon).toEqual(['w1']);
    });

    it('a declined prompt changes nothing in the cluster', async () => {
      k8sSetup();
      m.confirm.mockResolvedValue(false);
      m.exitDeclined.mockImplementation(() => {
        throw new Error('exit 1');
      });
      await go(['prod']);
      expect(text()).toContain(UNCORDON_LINE);
      expect(m.releaseLeftoverCordons).not.toHaveBeenCalled();
    });

    it('a release that fails is named and the run exits 1', async () => {
      k8sSetup();
      m.releaseLeftoverCordons.mockResolvedValue({
        released: [],
        failed: [{ name: 'w1', reason: 'kubectl said: timed out' }],
      });
      await go(['prod', '-y']);
      expect(text()).toContain(
        'could not uncordon w1 (kubectl said: timed out), so it stays cordoned until the next update',
      );
      expect(m.executeUpdatePlan).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(1);
      m.json.length = 0;
      await go(['prod', '-y', '-json']);
      expect((m.json[0] as { uncordonFailed: unknown }).uncordonFailed).toEqual([
        { name: 'w1', reason: 'kubectl said: timed out' },
      ]);
    });
  });

  describe('a server without the restart reporter', () => {
    it('compose: the only work is the reporter, so the plan names it and the run goes ahead', async () => {
      m.listUpdateTargets.mockResolvedValue({ tier: 'compose', targets: [target], skipped: [] });
      m.inspectAll.mockResolvedValue({
        inspected: [{ target, state: { ...state([]), reporter: false } }],
        skipped: [],
      });
      await go(['prod', '-y']);
      expect(text()).toContain('  install the restart reporter');
      expect(text()).toContain('no downtime expected');
      expect(text()).not.toContain(nothingToDoLine('prod'));
      expect(m.executeUpdatePlan).toHaveBeenCalledTimes(1);
    });

    it('k8s: a node without the host-state annotation gets it', async () => {
      const node = {
        ...target,
        role: 'worker',
        kind: 'k8s',
        masterIp: '9.9.9.9',
        name: 'w1',
        nodeName: 'w1',
        reporting: false,
      };
      m.listUpdateTargets.mockResolvedValue({ tier: 'k8s', targets: [node], skipped: [] });
      m.inspectAll.mockResolvedValue({
        inspected: [{ target: node, state: state([]) }],
        skipped: [],
      });
      await go(['prod', '-y']);
      expect(text()).toContain('  install the restart reporter');
      expect(m.executeUpdatePlan).toHaveBeenCalledTimes(1);
    });
  });

  describe('a restart still due at the end', () => {
    const dueAfter = () => {
      setup();
      m.inspectAll
        .mockResolvedValueOnce({ inspected: [{ target, state: state(['a', 'b']) }], skipped: [] })
        .mockResolvedValueOnce({ inspected: [{ target, state: state([], true) }], skipped: [] });
    };

    it('is named with the command to run, and the run exits 1', async () => {
      dueAfter();
      await go(['prod', '-y']);
      expect(text()).toContain(
        'a restart is still due on master, so run vibecarbon update prod again',
      );
      expect(text()).not.toContain(allClearLine());
      expect(exitCode).toBe(1);
    });

    it('is listed as stillDue in the JSON, and the run exits 1', async () => {
      dueAfter();
      await go(['prod', '-y', '-json']);
      expect((m.json[0] as { stillDue: unknown }).stillDue).toEqual(['master']);
      expect(exitCode).toBe(1);
    });

    it('stillDue is empty when nothing is due, and the run exits 0', async () => {
      setup();
      await go(['prod', '-y', '-json']);
      expect((m.json[0] as { stillDue: unknown }).stillDue).toEqual([]);
      expect(exitCode).toBeNull();
    });

    it('a restart that became due exits 1, named once', async () => {
      setup();
      m.inspectAll
        .mockResolvedValueOnce({ inspected: [{ target, state: state(['a', 'b']) }], skipped: [] })
        .mockResolvedValueOnce({ inspected: [{ target, state: state([], true) }], skipped: [] });
      m.executeUpdatePlan.mockResolvedValue({
        outcomes: [outcome()],
        becameDue: [{ name: 'master', package: 'linux-image' }],
        stoppedAt: null,
      });
      await go(['prod', '-y']);
      expect(text()).toContain(
        unexpectedRestartYesLine({ envName: 'prod', name: 'master', pkg: 'linux-image' }),
      );
      expect(text()).not.toContain('a restart is still due on master');
      expect(exitCode).toBe(1);
    });
  });

  it('no servers at all: says so with the deploy hint, exits 1, inspects nothing', async () => {
    m.listUpdateTargets.mockResolvedValue({ tier: 'compose', targets: [], skipped: [] });
    await go(['prod', '-y']);
    expect(text()).toContain('could not find any servers for prod');
    expect(text()).toContain('Run vibecarbon deploy prod to record them before you try again');
    expect(text()).not.toContain(nothingToDoLine('prod'));
    expect(m.inspectAll).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  const skippedOne = { name: 'gone', ip: '5.5.5.5', reason: 'timed out' };

  it('all skipped at plan time: prints them, no nothing-to-do line, exit 1', async () => {
    m.listUpdateTargets.mockResolvedValue({ tier: 'compose', targets: [], skipped: [skippedOne] });
    m.inspectAll.mockResolvedValue({ inspected: [], skipped: [] });
    await go(['prod', '-y']);
    expect(text()).toContain('gone (5.5.5.5): skipped, timed out.');
    expect(text()).not.toContain(nothingToDoLine('prod'));
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it('some skipped, the rest updated: exit 1 and no all-clear', async () => {
    m.listUpdateTargets.mockResolvedValue({
      tier: 'compose',
      targets: [target],
      skipped: [skippedOne],
    });
    m.inspectAll.mockResolvedValue({ inspected: [{ target, state: state(['a']) }], skipped: [] });
    await go(['prod', '-y']);
    expect(m.executeUpdatePlan).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain(allClearLine());
    expect(exitCode).toBe(1);
  });

  it('skipped servers do not change the preview exits', async () => {
    m.listUpdateTargets.mockResolvedValue({
      tier: 'compose',
      targets: [target],
      skipped: [skippedOne],
    });
    m.inspectAll.mockResolvedValue({ inspected: [{ target, state: state(['a']) }], skipped: [] });
    await go(['prod', '-json']);
    expect(exitCode).toBeNull();
    expect(m.executeUpdatePlan).not.toHaveBeenCalled();
  });

  it('a re-check that cannot read a server warns, withholds the all-clear, exits 0', async () => {
    setup();
    m.inspectAll
      .mockResolvedValueOnce({ inspected: [{ target, state: state(['a', 'b']) }], skipped: [] })
      .mockResolvedValueOnce({
        inspected: [],
        skipped: [{ name: 'master', ip: '1.2.3.4', reason: 'timed out' }],
      });
    await go(['prod', '-y', '-json']);
    expect((m.json[0] as { recheckSkipped: unknown }).recheckSkipped).toEqual([
      { name: 'master', reason: 'timed out' },
    ]);
    expect(exitCode).toBeNull();
    m.out.length = 0;
    m.json.length = 0;
    m.inspectAll
      .mockResolvedValueOnce({ inspected: [{ target, state: state(['a', 'b']) }], skipped: [] })
      .mockResolvedValueOnce({
        inspected: [],
        skipped: [{ name: 'master', ip: '1.2.3.4', reason: 'timed out' }],
      });
    await go(['prod', '-y']);
    expect(text()).toContain(recheckSkippedLine(['master']));
    expect(text()).not.toContain(allClearLine());
    expect(exitCode).toBeNull();
  });

  it('recheckSkipped is empty when every server was read', async () => {
    setup();
    await go(['prod', '-y', '-json']);
    expect((m.json[0] as { recheckSkipped: unknown }).recheckSkipped).toEqual([]);
  });

  it('the summary prints no null, NaN or 0s for an unmeasured outage', async () => {
    setup();
    m.executeUpdatePlan.mockResolvedValue({
      outcomes: [outcome({ outageSeconds: null })],
      becameDue: [],
      stoppedAt: null,
    });
    await go(['prod', '-y']);
    expect(text()).not.toMatch(/null|NaN|0s/);
  });

  describe('text from a server never reaches the terminal raw', () => {
    // OSC 52 sets the clipboard, CSI 2K erases the line, CR returns to its start.
    const H = 'x\u001b]52;c;ZXZpbA==\u0007\u001b[2K\r';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
    const RAW = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
    // The CLI's own colors (c.dim, c.success) are SGR codes; H holds none, so
    // dropping them leaves only what came from the server.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's own color codes
    const shown = () => text().replace(/\u001b\[\d+m/g, '');

    it('a failed command tail in stoppedAt.error, and its hint, are filtered', async () => {
      setup();
      m.executeUpdatePlan.mockResolvedValue({
        outcomes: [],
        becameDue: [],
        stoppedAt: { name: 'master', error: `could not install: it exited 100\n  ${H}`, hint: H },
      });
      await go(['prod', '-y']);
      expect(exitCode).toBe(1);
      expect(text()).toContain('could not install: it exited 100\n  x�]52;c;ZXZpbA==');
      expect(shown()).not.toMatch(RAW);
    });

    it('what the run logs while it executes is filtered', async () => {
      setup();
      m.executeUpdatePlan.mockImplementation(async (_plan, ctx) => {
        ctx.log.step(`${H}: restarting`);
        ctx.log.info(H);
        ctx.log.warn(H);
        return { outcomes: [outcome()], becameDue: [], stoppedAt: null };
      });
      await go(['prod', '-y']);
      expect(text()).toContain('x�]52;c;ZXZpbA==��[2K�: restarting');
      expect(shown()).not.toMatch(RAW);
    });

    it('a skipped reason and the names and packages in the summary are filtered', async () => {
      setup({ skipped: [{ name: H, ip: '1.1.1.9', reason: `could not check for updates: ${H}` }] });
      m.executeUpdatePlan.mockResolvedValue({
        outcomes: [outcome({ name: H, docker: [{ name: 'docker-ce', from: H, to: H }] })],
        becameDue: [{ name: H, package: H }],
        stoppedAt: null,
      });
      await go(['prod', '-y']);
      expect(text()).toContain('could not check for updates: x�]52');
      expect(shown()).not.toMatch(RAW);
      // JSON stays raw: JSON.stringify escapes control characters itself.
      m.json.length = 0;
      await go(['prod', '-y', '-json']);
      expect(JSON.stringify(m.json[0])).toContain('\\u001b]52');
    });
  });
});
