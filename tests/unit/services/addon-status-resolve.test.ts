import { describe, expect, it } from 'vitest';
import {
  ADDON_STATUS_READ_CMD,
  parseAddonStatusFile,
  resolveAddonStates,
} from '../../../src/lib/services/addon-start.js';

/**
 * I-A1 / M-A5: what `vibecarbon status` and the e2e addons_ready check read.
 *   - A file from the job of the current deploy (or failover) is trusted, and
 *     an add-on it still says is `starting` with no live job reads `stopped`.
 *   - No file (a promoted node that never ran the job), or a file from before
 *     the current deploy or failover (a stale "running" after failback): the
 *     add-ons' own containers decide.
 */
const EXPECTED = [
  { name: 'observability', services: ['grafana', 'loki'] },
  { name: 'n8n', services: ['n8n'] },
];
const ATTEMPT = 'a1b2c3d4e5f6';
const healthy = { health: 'healthy', label: 'healthy' };

describe('parseAddonStatusFile', () => {
  it('reads the start stamp, the states and the liveness marker', () => {
    expect(
      parseAddonStatusFile(
        `#attempt ${ATTEMPT}\nobservability\trunning\t\nn8n\tstarting\t\n#live\n`,
      ),
    ).toEqual({
      attempt: ATTEMPT,
      live: true,
      addons: [
        { name: 'observability', state: 'running', reason: '' },
        { name: 'n8n', state: 'starting', reason: '' },
      ],
    });
    expect(parseAddonStatusFile('')).toEqual({ attempt: null, live: false, addons: [] });
  });

  it('the remote read prints the file and #live only for a real job pid', () => {
    const cmd = ADDON_STATUS_READ_CMD('demo');
    expect(cmd).toContain('cat /opt/demo/.vc-addons/status');
    expect(cmd).toContain('/proc/');
    expect(cmd).toContain('addons-start.sh');
    expect(cmd).toContain("echo '#live'");
  });
});

describe('resolveAddonStates', () => {
  const fresh = (body: string, live = false) =>
    `#attempt ${ATTEMPT}\n${body}${live ? '#live\n' : ''}`;

  it('a current file is trusted', () => {
    expect(
      resolveAddonStates({
        text: fresh('observability\trunning\t\nn8n\tfailed\tsetup n8n-setup exited 1\n'),
        expected: EXPECTED,
        attemptId: ATTEMPT,
      }),
    ).toEqual([
      { name: 'observability', state: 'running', reason: '' },
      { name: 'n8n', state: 'failed', reason: 'setup n8n-setup exited 1' },
    ]);
  });

  it('M-A5: starting with no live job reads stopped', () => {
    const states = resolveAddonStates({
      text: fresh('observability\trunning\t\nn8n\tstarting\t\n'),
      expected: EXPECTED,
      attemptId: ATTEMPT,
    });
    expect(states[1]).toEqual({
      name: 'n8n',
      state: 'stopped',
      reason: 'the add-on job stopped before n8n came up',
    });
    // With the job alive it is still starting.
    expect(
      resolveAddonStates({
        text: fresh('n8n\tstarting\t\n', true),
        expected: [EXPECTED[1]],
        attemptId: ATTEMPT,
      })[0].state,
    ).toBe('starting');
  });

  it('no file (a promoted node never ran the job): the containers decide', () => {
    const states = resolveAddonStates({
      text: '',
      expected: EXPECTED,
      attemptId: ATTEMPT,
      containers: new Map([
        ['grafana', healthy],
        ['loki', { health: 'starting', label: 'starting' }],
        ['n8n', { health: 'unhealthy', label: 'exited' }],
      ]),
    });
    expect(states).toEqual([
      { name: 'observability', state: 'starting', reason: 'no add-on status; from its containers' },
      { name: 'n8n', state: 'failed', reason: 'n8n exited' },
    ]);
  });

  it('a "running" file from another attempt (before the last deploy, scale or failover) is not trusted', () => {
    const states = resolveAddonStates({
      text: `#attempt 0ldattempt000\nobservability\trunning\t\nn8n\trunning\t\n`,
      expected: EXPECTED,
      attemptId: ATTEMPT,
      containers: new Map([['grafana', healthy]]),
    });
    expect(states).toEqual([
      { name: 'observability', state: 'stopped', reason: 'no loki container' },
      { name: 'n8n', state: 'stopped', reason: 'no n8n container' },
    ]);
  });

  it('all containers healthy with no file: running', () => {
    expect(
      resolveAddonStates({
        text: '',
        expected: [EXPECTED[1]],
        attemptId: ATTEMPT,
        containers: new Map([['n8n', healthy]]),
      }),
    ).toEqual([{ name: 'n8n', state: 'running', reason: '' }]);
  });
});
