/**
 * compose-ha's setup fan uploads the one rendered bundle to both nodes at
 * once, and the deploy removes that bundle once its dispatch settles
 * (orchestrator). A fan that rejected on the first failure while the other
 * node's upload was still packing the bundle would let the removal pull the
 * dir out from under it. So the fan settles only once both uploads
 * have, and its rejection is the first failure's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  events: [] as string[],
  finishStandby: null as null | (() => void),
}));

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const quiet = () => {};
  return {
    ...actual,
    log: { info: quiet, warn: quiet, success: quiet, message: quiet, error: quiet, step: quiet },
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // The primary's upload fails at once; the standby's is still packing.
    setupServerFiles: vi.fn(async (ip: string) => {
      if (ip === '203.0.113.10') {
        h.events.push('primary:failed');
        throw new Error('primary upload failed');
      }
      await new Promise<void>((resolve) => {
        h.finishStandby = resolve;
      });
      h.events.push('standby:done');
    }),
    dockerLoginOnServer: vi.fn(async () => {}),
  };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    openWireguardPortUfw: vi.fn(async () => {}),
    openWireguardPortHetznerFirewall: vi.fn(async () => {}),
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const E = COMPOSE_HA_EFFECTS as Record<string, (c: Record<string, unknown>) => Promise<void>>;

const ctx = () =>
  ({
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    envConfig: {},
    primary: { ip: '203.0.113.10', stack: 'primary' },
    standby: { ip: '203.0.113.20', stack: 'standby' },
    sshKeyPath: '/tmp/never-used-key',
    bundlePath: '/never/read/here',
    // No early tunnel: it is not under test.
    reconverge: { promoted: {}, retired: {} },
    onProgress: () => {},
  }) as Record<string, unknown>;

beforeEach(() => {
  h.events.length = 0;
  h.finishStandby = null;
});
afterEach(() => vi.clearAllMocks());

describe('the compose-ha setup fan and the bundle it reads', () => {
  it('rejects only after the other upload has settled, with the first failure', async () => {
    const fan = E.haSetupServerFiles(ctx()).then(
      () => h.events.push('fan:resolved'),
      (err: Error) => h.events.push(`fan:rejected ${err.message}`),
    );
    // Long enough for a fail-fast fan to have rejected already.
    await vi.waitFor(() => expect(h.finishStandby).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual(['primary:failed']);
    h.finishStandby?.();
    await fan;
    expect(h.events).toEqual([
      'primary:failed',
      'standby:done',
      'fan:rejected primary upload failed',
    ]);
  });
});
