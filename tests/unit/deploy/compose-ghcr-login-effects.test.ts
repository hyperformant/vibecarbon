/**
 * The deploy effects that log compose servers in to ghcr.io hand the one
 * resolved credential (ctx.ghcrPull) to ensureGhcrLoginOn
 * (compose/ghcr-login.js), and nothing else: single compose through the
 * state-gated ghcrLogin effect, compose-ha through its setup fan, on both
 * sides.
 *
 * The gate's inputs are the credential's mode and a keyed fingerprint of its
 * token, never the token. Their shape is new, so the gate an earlier
 * vibecarbon recorded (when it logged the server in with the operator's gh
 * token) never matches: the first deploy after an upgrade always runs the
 * step, and that run is what takes the gh token off an existing server.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const h = vi.hoisted(() => ({
  /** What happened on each server, in order. */
  events: [] as string[],
  ensured: [] as Array<{ ip: string; key: string; pull: unknown }>,
}));

vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['info', 'warn', 'success', 'message', 'error', 'step'],
  }),
);

vi.mock('../../../src/lib/deploy/compose/ghcr-login.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ensureGhcrLoginOn: vi.fn(async (ip: string, key: string, pull: unknown) => {
    h.events.push(`ghcr:${ip}`);
    h.ensured.push({ ip, key, pull });
    return 'stored';
  }),
}));

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  setupServerFiles: vi.fn(async (ip: string) => {
    h.events.push(`files:${ip}`);
  }),
  dockerLoginOnServer: vi.fn(async (ip: string) => {
    // Slower than the ghcr.io step: a fan that ran both at once on a server
    // would finish ghcr.io first.
    await new Promise((r) => setTimeout(r, 20));
    h.events.push(`hub:${ip}`);
  }),
}));

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openWireguardPortUfw: vi.fn(async () => {}),
  openWireguardPortHetznerFirewall: vi.fn(async () => {}),
}));

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { StateTracker } = await import('../../../src/lib/deploy/state.js');
const E = EFFECTS as Record<string, (c: Record<string, unknown>) => Promise<void>>;

const IP = '203.0.113.5';
const KEY = '/project/.vibecarbon/deploy_key_prod';
const GH_TOKEN = `gho_${'vcghsentinel'.padEnd(36, 'G')}`;
const TOKEN = `ghp_${'vcpullsentinel'.padEnd(36, 'Q')}`;
const PULL = { mode: 'token', username: 'octo', token: TOKEN } as const;

let cwd: string;
beforeEach(() => {
  h.events.length = 0;
  h.ensured.length = 0;
  cwd = createTempDir('vc-ghcr-gate-');
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(() => vi.restoreAllMocks());

const stateFile = () => readFileSync(join(cwd, '.vibecarbon', 'deploy-state-prod.json'), 'utf-8');

describe('the ghcrLogin effect (single compose)', () => {
  it('hands ensureGhcrLoginOn the resolved credential, or null', async () => {
    for (const ghcrPull of [PULL, { mode: 'public' }, null]) {
      const state = new StateTracker('shop', 'prod');
      await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull });
      expect(h.ensured.at(-1)).toEqual({ ip: IP, key: KEY, pull: ghcrPull });
      state.clear();
    }
  });

  it('gates on the mode and a fingerprint, and writes no token to the state file', async () => {
    const state = new StateTracker('shop', 'prod');
    await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull: PULL });
    // The same credential again: skipped.
    await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull: PULL });
    expect(h.ensured).toHaveLength(1);
    // Another token, or none: runs.
    const rotated = { ...PULL, token: `ghp_${'vcpullrotated'.padEnd(36, 'R')}` };
    await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull: rotated });
    await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull: { mode: 'public' } });
    await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull: null });
    expect(h.ensured.map((e) => e.pull)).toEqual([PULL, rotated, { mode: 'public' }, null]);
    for (const secret of [TOKEN, rotated.token, Buffer.from(`octo:${TOKEN}`).toString('base64')]) {
      expect(stateFile()).not.toContain(secret);
    }
  });

  it('runs on the first deploy after an upgrade, whatever an earlier vibecarbon recorded', async () => {
    const { fingerprintSecret } = await import('../../../src/lib/deploy/secret-fingerprint.js');
    // The gate an earlier vibecarbon left once it had logged the server in
    // with the operator's gh token: { serverIp, registry, user, tokenFp }.
    const earlier = (token: string) => ({
      serverIp: IP,
      registry: 'ghcr.io',
      user: 'acme',
      tokenFp: fingerprintSecret(token),
    });
    for (const ghcrPull of [null, { mode: 'public' }, PULL]) {
      const state = new StateTracker('shop', 'prod');
      for (const token of [GH_TOKEN, TOKEN]) {
        state.startStep('compose-ghcr-login', earlier(token));
        state.completeStep('compose-ghcr-login', { serverIp: IP });
        h.ensured.length = 0;
        await E.ghcrLogin({ state, serverIp: IP, sshKeyPath: KEY, ghcrPull });
        expect(h.ensured, `after an earlier gate, with ${JSON.stringify(ghcrPull)}`).toHaveLength(
          1,
        );
      }
    }
  });
});

describe('the compose-ha setup fan', () => {
  const ctx = (ghcrPull: unknown) =>
    ({
      projectConfig: { projectName: 'shop' },
      environment: 'prod',
      envConfig: {},
      primary: { ip: IP, stack: 'primary' },
      standby: { ip: '203.0.113.6', stack: 'standby' },
      sshKeyPath: KEY,
      bundlePath: '/never/read/here',
      dockerHubCreds: { username: 'hubuser', token: 'dckr_pat_x' },
      ghcrPull,
      // No early tunnel: it is not under test.
      reconverge: { promoted: {}, retired: {} },
      onProgress: () => {},
    }) as Record<string, unknown>;

  it('logs both sides in with the one credential, each after its Docker Hub login', async () => {
    await E.haSetupServerFiles(ctx(PULL));
    expect(h.ensured).toEqual([
      { ip: IP, key: KEY, pull: PULL },
      { ip: '203.0.113.6', key: KEY, pull: PULL },
    ]);
    // Both edit the one login file on a server: one at a time, never at once.
    for (const ip of [IP, '203.0.113.6']) {
      expect(h.events.indexOf(`hub:${ip}`)).toBeLessThan(h.events.indexOf(`ghcr:${ip}`));
    }
  });

  it('runs for a public image and for none, so a gh token left on either side goes', async () => {
    for (const ghcrPull of [{ mode: 'public' }, null]) {
      h.ensured.length = 0;
      await E.haSetupServerFiles(ctx(ghcrPull));
      expect(h.ensured.map((e) => [e.ip, e.pull])).toEqual([
        [IP, ghcrPull],
        ['203.0.113.6', ghcrPull],
      ]);
    }
  });
});
