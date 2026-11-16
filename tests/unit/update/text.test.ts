import { describe, expect, it } from 'vitest';
import {
  allClearLine,
  confirmQuestion,
  formatDuration,
  formatPlan,
  formatTotal,
  nothingToDoLine,
  summaryLine,
  unexpectedRestartPrompt,
  unexpectedRestartYesLine,
} from '../../../src/lib/update/text.js';

const target = (name: string, ip: string, over = {}) => ({
  name,
  ip,
  side: 'primary',
  role: 'server',
  kind: 'compose',
  ...over,
});
const step = (over: Record<string, unknown>) => ({
  state: {},
  install: 0,
  docker: null,
  restart: 'none',
  restartReason: null,
  effect: { kind: 'none', seconds: null },
  ...over,
});

const plan = {
  envName: 'prod',
  tier: 'launch',
  steps: [
    step({
      target: target('worker-1', '1.1.1.1', { kind: 'k8s', role: 'worker' }),
      install: 3,
      restart: 'due',
      restartReason: 'linux-image-6.8',
      effect: { kind: 'drained', seconds: null },
    }),
    step({
      target: target('standby', '2.2.2.2', { side: 'standby' }),
      install: 1,
      restart: 'none',
      effect: { kind: 'no-traffic', seconds: null },
    }),
    step({
      target: target('web', '3.3.3.3'),
      install: 2,
      docker: {
        packages: [
          { name: 'docker-ce', from: '1', to: '2' },
          { name: 'containerd.io', from: '3', to: '4' },
        ],
      },
      restart: 'likely',
      restartReason: 'libc6',
      effect: { kind: 'app-offline', seconds: [60, 240] },
    }),
    step({
      target: target('master', '4.4.4.4', { kind: 'k8s', role: 'master' }),
      restart: 'due',
      restartReason: 'dbus',
      effect: { kind: 'app-offline', seconds: [60, 180] },
    }),
    step({
      target: target('db', '5.5.5.5', { kind: 'k8s', role: 'db' }),
      restart: 'due',
      restartReason: 'libc6',
      effect: { kind: 'db-offline', seconds: [60, 180] },
    }),
    step({ target: target('idle', '6.6.6.6') }),
    step({ target: target('tidy', '7.7.7.7'), install: 4 }),
  ],
  skipped: [
    { name: 'a', ip: '8.8.8.8', reason: 'connection refused' },
    { name: 'b', ip: '9.9.9.9', reason: 'could not check for updates: apt exited 100' },
    { name: 'c', ip: null, reason: 'no public address' },
  ],
  total: [120, 360],
  outageServers: ['master', 'db'],
};

describe('formatPlan', () => {
  it('prints every line exactly', () => {
    expect(formatPlan(plan as never)).toEqual([
      'update plan for prod (launch)',
      '1. worker-1 (1.1.1.1)',
      '  install 3 security updates',
      '  restart: due (linux-image-6.8)',
      '  users notice: nothing, the node is drained first and the app keeps running elsewhere',
      '2. standby (2.2.2.2)',
      '  install 1 security update',
      '  no restart expected',
      '  users notice: nothing, this side takes no traffic',
      '3. web (3.3.3.3)',
      '  install 2 security updates',
      '  update Docker: docker-ce 1 to 2, containerd.io 3 to 4',
      '  restart: likely (libc6 is waiting to install)',
      '  users notice: the app is offline for about 1 to 4 minutes',
      '4. master (4.4.4.4)',
      '  restart: due (dbus)',
      '  users notice: the app is offline for about 1 to 3 minutes, Traefik runs only on the master',
      '5. db (5.5.5.5)',
      '  restart: due (libc6)',
      '  users notice: requests that need the database fail for about 1 to 3 minutes',
      '6. idle (6.6.6.6)',
      '  nothing to do',
      '7. tidy (7.7.7.7)',
      '  install 4 security updates',
      '  no restart expected',
      '  users notice: nothing',
      'a (8.8.8.8): skipped, connection refused. Check the server is running, then run vibecarbon update prod again',
      'b (9.9.9.9): skipped, could not check for updates: apt exited 100. The daily security updates may be running, so try vibecarbon update prod again in a few minutes',
      'c (no address): skipped, no public address. vibecarbon reaches servers over their public address, so this one has to be updated by hand',
    ]);
  });

  it('never prints an em or en dash', () => {
    const all = [
      ...formatPlan(plan as never),
      formatTotal(plan as never),
      nothingToDoLine('prod'),
      confirmQuestion('prod'),
      unexpectedRestartPrompt({ target: target('web', '3.3.3.3') as never, pkg: 'libc6' }),
      unexpectedRestartYesLine({ envName: 'prod', name: 'web', pkg: 'libc6' }),
      allClearLine(),
    ].join('\n');
    expect(all).not.toMatch(/[—–]/);
  });
});

describe('formatTotal', () => {
  it('names the servers that go offline', () => {
    expect(formatTotal(plan as never)).toBe(
      'expected downtime: about 2 to 6 minutes in total, while master, db restart',
    );
  });
  it('says none when there is no outage', () => {
    expect(formatTotal({ ...plan, total: null, outageServers: [] } as never)).toBe(
      'no downtime expected',
    );
  });
});

describe('formatDuration', () => {
  it('uses seconds under a minute and rounded-up minutes otherwise', () => {
    expect(formatDuration([30, 60])).toBe('about 30 to 60 seconds');
    expect(formatDuration([10, 50])).toBe('about 10 to 50 seconds');
    expect(formatDuration([60, 180])).toBe('about 1 to 3 minutes');
    expect(formatDuration([120, 420])).toBe('about 2 to 7 minutes');
    expect(formatDuration([60, 240])).toBe('about 1 to 4 minutes');
    expect(formatDuration([61, 130])).toBe('about 2 to 3 minutes');
  });
});

describe('fixed lines', () => {
  it('matches the brief', () => {
    expect(nothingToDoLine('prod')).toBe('everything on prod is up to date, nothing to do');
    expect(confirmQuestion('prod')).toBe('Update prod now?');
    expect(
      unexpectedRestartPrompt({ target: target('web', '3.3.3.3') as never, pkg: 'libc6' }),
    ).toBe(
      'web now needs a restart for libc6, which the plan did not show. The app is offline for about 1 to 3 minutes while it restarts. Restart it now?',
    );
    expect(unexpectedRestartYesLine({ envName: 'prod', name: 'web', pkg: 'libc6' })).toBe(
      'a restart became due on web (libc6): run vibecarbon update prod again to restart it',
    );
    expect(allClearLine()).toBe('no reboot due on any server');
  });
  it('says what each role really loses in the unexpected restart prompt', () => {
    const prompt = (t: unknown, pkg = 'libc6') =>
      unexpectedRestartPrompt({ target: t as never, pkg });
    const head = (n: string) => `${n} now needs a restart for libc6, which the plan did not show. `;
    expect(prompt(target('m', '1.1.1.1', { kind: 'k8s', role: 'master' }))).toBe(
      `${head('m')}The app is offline for about 1 to 3 minutes while it restarts, since Traefik runs only on the master. Restart it now?`,
    );
    expect(prompt(target('d', '1.1.1.1', { kind: 'k8s', role: 'db' }))).toBe(
      `${head('d')}Requests that need the database fail for about 1 to 3 minutes while it restarts. Restart it now?`,
    );
    expect(prompt(target('w', '1.1.1.1', { kind: 'k8s', role: 'worker' }))).toBe(
      `${head('w')}Users notice nothing: the node is drained first and the app keeps running elsewhere. Restart it now?`,
    );
    expect(prompt(target('s', '1.1.1.1', { side: 'standby' }))).toBe(
      `${head('s')}Users notice nothing: this side takes no traffic. Restart it now?`,
    );
    expect(prompt(target('s', '1.1.1.1', { side: 'standby', kind: 'k8s', role: 'db' }))).toBe(
      `${head('s')}Users notice nothing: this side takes no traffic. Restart it now?`,
    );
  });
  it('says system updates when no package is named', () => {
    const p = {
      ...plan,
      steps: [
        step({
          target: target('web', '3.3.3.3'),
          restart: 'due',
          restartReason: 'system updates',
          effect: { kind: 'app-offline', seconds: [60, 180] },
        }),
      ],
      skipped: [],
    };
    expect(formatPlan(p as never)).toContain('  restart: due (system updates)');
    expect(
      unexpectedRestartPrompt({ target: target('web', '1.1.1.1') as never, pkg: 'system updates' }),
    ).toContain('for system updates, which');
    expect(unexpectedRestartYesLine({ envName: 'prod', name: 'web', pkg: 'system updates' })).toBe(
      'a restart became due on web (system updates): run vibecarbon update prod again to restart it',
    );
  });
  it('says update in the singular for one package', () => {
    const p = {
      ...plan,
      skipped: [],
      steps: [step({ target: target('web', '3.3.3.3'), install: 1 })],
    };
    expect(formatPlan(p as never)).toContain('  install 1 security update');
  });
  it('rounds offline seconds before splitting minutes', () => {
    const r = { name: 'w', installed: 1, docker: null, restarted: true, offlineSeconds: 119.6 };
    expect(summaryLine(r)).toBe('w: installed 1 updates, restarted, app offline 2m 0s');
  });
  it('builds the summary line', () => {
    expect(
      summaryLine({
        name: 'web',
        installed: 5,
        docker: { from: '1', to: '2' },
        restarted: true,
        offlineSeconds: 95,
      }),
    ).toBe('web: installed 5 updates, Docker 1 to 2, restarted, app offline 1m 35s');
    expect(
      summaryLine({
        name: 'w',
        installed: 0,
        docker: null,
        restarted: false,
        offlineSeconds: null,
      }),
    ).toBe('w: installed 0 updates');
  });
});
