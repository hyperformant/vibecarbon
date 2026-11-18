/**
 * requireOperatorIpAccess is the one operator-IP gate of backup, restore,
 * update, failover and both scale paths. These pin what each of those
 * commands did when it carried its own copy: skip without a token, say when
 * the firewall changed, exit 1 on a failed check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ensureOperatorIpAccess: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
  resolveProviderToken: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({ log: m.log }));
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: m.ensureOperatorIpAccess,
}));
vi.mock('../../../src/lib/providers/index.js', () => ({
  providerIdFor: (envConfig: { provider?: string }) => envConfig.provider ?? 'hetzner',
  resolveProviderToken: m.resolveProviderToken,
}));

import {
  requireEnvOperatorIpAccess,
  requireOperatorIpAccess,
} from '../../../src/lib/operator-ip-gate.js';
import { REPO_ROOT } from '../../_shared/source-files.js';

const SRC = join(REPO_ROOT, 'src');
const base = {
  projectConfig: { projectName: 'demo' },
  environment: 'production',
  isHA: true,
  apiToken: 'token',
  yes: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireOperatorIpAccess', () => {
  it('does nothing without a provider token', async () => {
    await requireOperatorIpAccess({ ...base, apiToken: null });
    expect(m.ensureOperatorIpAccess).not.toHaveBeenCalled();
  });

  it('passes its inputs through and stays silent when the IP was already allowed', async () => {
    m.ensureOperatorIpAccess.mockResolvedValue({ added: false, cidr: '203.0.113.7/32' });
    await requireOperatorIpAccess(base);
    expect(m.ensureOperatorIpAccess).toHaveBeenCalledWith({
      ...base,
      onMessage: expect.any(Function),
    });
    m.ensureOperatorIpAccess.mock.calls[0][0].onMessage('detected');
    expect(m.log.info).toHaveBeenCalledWith('detected');
    expect(m.log.success).not.toHaveBeenCalled();
  });

  it('says what the firewall now allows when it added the IP', async () => {
    m.ensureOperatorIpAccess.mockResolvedValue({ added: true, cidr: '203.0.113.7/32' });
    await requireOperatorIpAccess(base);
    expect(m.log.success).toHaveBeenCalledWith(
      'Firewall updated: SSH/k8s API now allow 203.0.113.7/32',
    );
  });

  it("keeps the compose scale's own wording", async () => {
    m.ensureOperatorIpAccess.mockResolvedValue({ added: true, cidr: '203.0.113.7/32' });
    await requireOperatorIpAccess({ ...base, opened: 'SSH now allows' });
    expect(m.log.success).toHaveBeenCalledWith('Firewall updated: SSH now allows 203.0.113.7/32');
  });

  it('exits 1 with the reason when the check fails', async () => {
    m.ensureOperatorIpAccess.mockRejectedValue(new Error('no detector answered'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(requireOperatorIpAccess(base)).rejects.toThrow('exit');
      expect(m.log.error).toHaveBeenCalledWith('Operator-IP check failed: no detector answered');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});

describe('requireEnvOperatorIpAccess', () => {
  const env = (envConfig: Record<string, unknown>) => ({
    projectConfig: { projectName: 'demo' },
    envName: 'production',
    envConfig,
    yes: false,
  });

  it('gates both firewalls for compose-HA and k8s HA, one otherwise, with the provider token', async () => {
    m.ensureOperatorIpAccess.mockResolvedValue({ added: false, cidr: '203.0.113.7/32' });
    m.resolveProviderToken.mockImplementation((id: string) => `token-${id}`);
    await requireEnvOperatorIpAccess(env({ provider: 'linode', deployMode: 'compose-ha' }));
    await requireEnvOperatorIpAccess(env({ deployMode: 'k8s', ha: { enabled: true } }));
    await requireEnvOperatorIpAccess(env({ deployMode: 'compose' }));
    expect(m.resolveProviderToken.mock.calls).toEqual([['linode'], ['hetzner'], ['hetzner']]);
    expect(
      m.ensureOperatorIpAccess.mock.calls.map(([o]) => [o.environment, o.isHA, o.apiToken, o.yes]),
    ).toEqual([
      ['production', true, 'token-linode', false],
      ['production', true, 'token-hetzner', false],
      ['production', false, 'token-hetzner', false],
    ]);
  });

  it('does nothing when the operator has no token for the provider', async () => {
    m.resolveProviderToken.mockReturnValue(undefined);
    await requireEnvOperatorIpAccess(env({ deployMode: 'compose' }));
    expect(m.ensureOperatorIpAccess).not.toHaveBeenCalled();
  });
});

describe('the commands that need SSH share the one gate', () => {
  // backup, restore and update gate the env as its record describes it.
  const gates: Record<string, string> = {
    'backup.js': 'await requireEnvOperatorIpAccess({',
    'restore.js': 'await requireEnvOperatorIpAccess({',
    'update.js': 'await requireEnvOperatorIpAccess({',
    'failover.js': 'await requireOperatorIpAccess({',
    'scale.js': 'await requireOperatorIpAccess({',
  };
  for (const [file, call] of Object.entries(gates)) {
    it(`${file} calls the gate and carries no copy`, () => {
      const src = readFileSync(join(SRC, file), 'utf8');
      expect(src).toContain(call);
      expect(src).not.toContain('ensureOperatorIpAccess(');
      expect(src).not.toContain('Operator-IP check failed');
    });
  }
});
