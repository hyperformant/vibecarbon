/**
 * The hint a single-server environment gets from `vibecarbon failover`: how to
 * get one-command failover. It names only offered tiers (compose-ha is not
 * offered, OFFERED_TIERS), and it says "a new environment" because the saved
 * mode wins over `-mode` on a redeploy (resolveDeployMode).
 */
import { stripVTControlCharacters as strip } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({ log: ['step', 'info', 'warn', 'error', 'success', 'message'] });
});
vi.mock('@clack/prompts', () => clackMock);

import { logFailoverModeHint } from '../../../src/failover.js';

function hintFor(provider: string): string[] {
  clackMock.log.info.mockClear();
  const commands: string[] = [];
  logFailoverModeHint({ provider }, (line: string) => commands.push(strip(line)));
  return [...clackMock.log.info.mock.calls.map(([line]: [string]) => strip(line)), ...commands];
}

describe('logFailoverModeHint', () => {
  it.each(['hetzner', 'digitalocean', 'linode', 'vultr'])(
    'points %s at a new k8s-ha environment',
    (provider) => {
      const lines = hintFor(provider);
      expect(lines.join('\n')).toContain('deploy a new environment in k8s-ha mode');
      expect(lines).toContain('  vibecarbon deploy <new-env> -mode k8s-ha');
    },
  );

  it.each([['scaleway', 'Scaleway']])('tells %s it has no failover mode yet', (provider, name) => {
    expect(hintFor(provider)).toEqual([
      `${name} has no failover mode yet, so recovery is a new server and a restore.`,
    ]);
  });

  it.each(['hetzner', 'vultr'])('never names compose-ha on %s', (provider) => {
    expect(hintFor(provider).join('\n')).not.toMatch(/compose[- ]ha/i);
  });
});
