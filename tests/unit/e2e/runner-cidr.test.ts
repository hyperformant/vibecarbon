/**
 * E2E opens SSH (22) and the k8s API (6443) to the machine running it, and to
 * nothing wider, as a customer's firewall admits only the customer's own
 * operator CIDR.
 *
 * It used to open both to 0.0.0.0/0,::/0. On Linode, which hands the same
 * public IPs back to an account, one recycled address reset sshd's key
 * exchange outside any restart, four times across runs 44623637422 and
 * 44653733007: something on the internet kept hitting it, and the world-open
 * port let it reach sshd. These tests hold the harness to the runner's own
 * address: detected with the product's detector, required by every child env,
 * and never widened.
 */

import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, scenarioContext } from '../../e2e/utils/cli-runner.js';
import { detectRunnerCidr, e2eCliEnv } from '../../e2e/utils/e2e-env.js';

const detectOperatorIp = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/operator-ip.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/operator-ip.js')>()),
  detectOperatorIp,
}));

afterEach(() => detectOperatorIp.mockReset());

// Documentation ranges (RFC 5737, RFC 3849).
const V4 = '203.0.113.7/32';
const V6 = '2001:db8::7/128';

describe('e2eCliEnv opens the firewall to the runner only', () => {
  it('passes the detected address as ALLOWED_SSH_IPS', () => {
    expect(e2eCliEnv({}, {}, { runnerCidr: V4 }).ALLOWED_SSH_IPS).toBe(V4);
    expect(e2eCliEnv({}, {}, { runnerCidr: V6 }).ALLOWED_SSH_IPS).toBe(V6);
  });

  it('never passes a world-open range, even when the shell exports one', () => {
    const shell = { ALLOWED_SSH_IPS: '0.0.0.0/0,::/0' } as NodeJS.ProcessEnv;
    const env = e2eCliEnv({}, shell, { runnerCidr: V4 });
    expect(env.ALLOWED_SSH_IPS).toBe(V4);
    for (const value of Object.values(env)) {
      expect(value).not.toContain('0.0.0.0/0');
      expect(value).not.toContain('::/0');
    }
  });

  it('refuses to build a child env without the detected address', () => {
    for (const opts of [undefined, {}, { runnerCidr: '' }, { runnerCidr: undefined }]) {
      expect(() => e2eCliEnv({}, {}, opts)).toThrow(/no runnerCidr/);
    }
    // An inherited value is no substitute for the detection.
    expect(() => e2eCliEnv({}, { ALLOWED_SSH_IPS: '203.0.113.7/32' } as NodeJS.ProcessEnv)).toThrow(
      /no runnerCidr.*no world-open fallback/s,
    );
  });

  it.each([
    '0.0.0.0/0',
    '::/0',
    '0.0.0.0/0,::/0',
    '10.0.0.0/8',
    '203.0.113.0/24',
    '203.0.113.7',
    '203.0.113.7/32,198.51.100.1/32',
    '203.0.113.7/128',
    '2001:db8::7/64',
    '2001:db8::7/32',
    'runner/32',
  ])('refuses %s, which is not exactly one host', (runnerCidr) => {
    expect(() => e2eCliEnv({}, {}, { runnerCidr })).toThrow(/must be one host address/);
  });

  it('refuses a per-call ALLOWED_SSH_IPS', () => {
    expect(() => e2eCliEnv({ ALLOWED_SSH_IPS: '0.0.0.0/0' }, {}, { runnerCidr: V4 })).toThrow(
      /not a per-call value/,
    );
    expect(() => e2eCliEnv({ ALLOWED_SSH_IPS: V4 }, {}, { runnerCidr: V4 })).toThrow(
      /not a per-call value/,
    );
  });
});

describe('detectRunnerCidr', () => {
  it("formats the product detector's answer as one host", async () => {
    detectOperatorIp.mockResolvedValueOnce({ ip: '203.0.113.7', version: 4 });
    await expect(detectRunnerCidr()).resolves.toBe(V4);
    detectOperatorIp.mockResolvedValueOnce({ ip: '2001:db8::7', version: 6 });
    await expect(detectRunnerCidr()).resolves.toBe(V6);
    expect(detectOperatorIp).toHaveBeenCalledTimes(2);
  });

  it('stops the run with the cause when the address cannot be detected', async () => {
    detectOperatorIp.mockRejectedValueOnce(
      new Error('Unable to detect operator IP: https://api.ipify.org: HTTP 503'),
    );
    const err = await detectRunnerCidr().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Cannot detect this machine's public address/);
    expect(err?.message).toContain('HTTP 503');
    expect(err?.message).toContain('https://api.ipify.org');
  });

  it('refuses an answer that is not one host address', async () => {
    await expect(
      detectRunnerCidr({ detect: async () => ({ ip: 'garbage', version: 4 }) }),
    ).rejects.toThrow(/must be one host address/);
  });
});

describe('runCli', () => {
  // A fake env never reaches here: runCli throws before it spawns anything.
  const options = { cwd: tmpdir(), timeout: 5_000, echo: false };

  it('refuses outside a scenario context that carries the runner address', async () => {
    await expect(runCli('status', options)).rejects.toThrow(/no runnerCidr/);
    await expect(
      scenarioContext.run({ provider: 'hetzner' }, () => runCli('status', options)),
    ).rejects.toThrow(/no runnerCidr/);
  });
});
