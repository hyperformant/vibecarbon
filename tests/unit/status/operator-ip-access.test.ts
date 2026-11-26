/**
 * `status`, run in a terminal outside CI, lets the operator's current
 * address through every deployed environment's firewall before its first
 * remote read, as `shell` and `diagnose` do. Without it, status from a new
 * address showed remote health as unavailable with no reason. A status run
 * by cron, a CI job or a pipe never detects, saves or pushes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    config: null as null | Record<string, unknown>,
    warnAll: vi.fn(),
    /** Every remote read: SSH and the public-domain probe. */
    remote: async () => {
      order.push('remote');
      throw new Error('no remote reads in unit tests');
    },
  };
});

vi.mock('../../../src/lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/config.js')>()),
  loadProjectConfig: () => m.config,
}));
vi.mock('../../../src/lib/operator-ip.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/operator-ip.js')>()),
  ensureOperatorIpAccessWarnAll: m.warnAll,
}));

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  sshRun: m.remote,
  sshRunScript: m.remote,
  sshKubectl: m.remote,
}));
vi.mock('../../../src/lib/deploy/public-domain-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/deploy/public-domain-probe.js')>()),
  fetchPublicDomain: m.remote,
}));

import { run } from '../../../src/status.js';
import { createTempDir } from '../../_shared/temp-dir.js';

class Exit extends Error {}

let dir: string;

const deployed = (name: string) => ({
  provider: 'hetzner',
  deployMode: 'compose',
  servers: [{ name, ip: '203.0.113.10', id: 1 }],
});

function project(environments: Record<string, object>) {
  m.config = { projectName: 'demo', operatorCidrs: [], environments };
}

async function status(argv: string[]) {
  await expect(run(argv)).rejects.toBeInstanceOf(Exit);
}

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
function setTTY(isTTY: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
}

beforeEach(() => {
  dir = createTempDir('vc-status-ip-');
  // The deploy key exists, so status gets as far as a remote read.
  mkdirSync(join(dir, '.vibecarbon'));
  for (const env of ['prod', 'staging']) {
    writeFileSync(join(dir, '.vibecarbon', `deploy_key_${env}`), 'key\n', { mode: 0o600 });
  }
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  // No provider API read: the server-info row stays out of it.
  vi.stubEnv('HETZNER_API_TOKEN', '');
  m.order.length = 0;
  m.warnAll.mockReset();
  m.warnAll.mockImplementation(async () => {
    m.order.push('operator-ip');
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Exit();
  }) as never);
  // The -json document.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // An operator's terminal, outside CI (the unit tier runs with CI=true).
  setTTY(true);
  vi.stubEnv('CI', '');
});

afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('status and the operator address', () => {
  it('in a terminal outside CI, lets the address through before the first remote read', async () => {
    project({ prod: deployed('prod') });
    await status(['-json']);
    expect(m.order[0]).toBe('operator-ip');
    expect(m.order).toContain('remote');
  });

  it('passes yes: true and only the environments with servers', async () => {
    project({ prod: deployed('prod'), staging: { ...deployed('staging'), servers: [] } });
    await status(['-json']);
    expect(m.warnAll).toHaveBeenCalledTimes(1);
    expect(m.warnAll).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: m.config,
        environments: ['prod'],
        yes: true,
        cwd: dir,
      }),
    );
  });

  it('nothing deployed: no address check', async () => {
    project({
      prod: { ...deployed('prod'), servers: [] },
      staging: { ...deployed('staging'), servers: [] },
    });
    await status(['-json']);
    expect(m.warnAll).not.toHaveBeenCalled();
  });

  it('-env prod checks only prod', async () => {
    project({ prod: deployed('prod'), staging: deployed('staging') });
    await status(['-env', 'prod', '-json']);
    expect(m.warnAll).toHaveBeenCalledWith(expect.objectContaining({ environments: ['prod'] }));
  });

  it('not in a terminal (cron, a pipe, -json | jq): no address check, still the remote reads', async () => {
    setTTY(false);
    project({ prod: deployed('prod') });
    await status(['-json']);
    expect(m.warnAll).not.toHaveBeenCalled();
    expect(m.order).toContain('remote');
  });

  it('in a terminal under CI: no address check', async () => {
    vi.stubEnv('CI', 'true');
    project({ prod: deployed('prod') });
    await status(['-json']);
    expect(m.warnAll).not.toHaveBeenCalled();
  });
});
