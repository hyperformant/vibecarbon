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
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

function hintFor(provider: string): string[] {
  clackMock.log.info.mockClear();
  const commands: string[] = [];
  logFailoverModeHint({ provider }, (line: string) => commands.push(strip(line)));
  return [...clackMock.log.info.mock.calls.map(([line]: [string]) => strip(line)), ...commands];
}

describe('logFailoverModeHint', () => {
  it.each(['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway'])(
    'points %s at a new k8s-ha environment',
    (provider) => {
      const lines = hintFor(provider);
      expect(lines.join('\n')).toContain('deploy a new environment in k8s-ha mode');
      expect(lines).toContain('  vibecarbon deploy <new-env> -mode k8s-ha');
    },
  );

  it('tells a provider with no k8s-ha tier it has no failover mode yet', () => {
    // No registered provider lacks k8s-ha now, so a stub stands in.
    class ComposeOnly extends BaseProvider {
      static NAME = 'Acme Cloud';
      static SUPPORTED_TIERS = ['compose', 'compose-ha'];
    }
    (PROVIDERS as Record<string, unknown>).acme = ComposeOnly;
    try {
      expect(hintFor('acme')).toEqual([
        'Acme Cloud has no failover mode yet, so recovery is a new server and a restore.',
      ]);
    } finally {
      delete (PROVIDERS as Record<string, unknown>).acme;
    }
  });

  it.each(['hetzner', 'vultr', 'scaleway'])('never names compose-ha on %s', (provider) => {
    expect(hintFor(provider).join('\n')).not.toMatch(/compose[- ]ha/i);
  });
});
