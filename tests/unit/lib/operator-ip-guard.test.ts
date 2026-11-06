import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/command.js', () => ({ runCommandAsync: vi.fn() }));
vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));
vi.mock('../../../src/lib/operator-ip.js', () => ({ detectOperatorIp: vi.fn() }));

import { runCommandAsync } from '../../../src/lib/command.js';
import { detectOperatorIp } from '../../../src/lib/operator-ip.js';
import {
  armOperatorIpGuard,
  assertOperatorIpUnchanged,
  disarmOperatorIpGuard,
} from '../../../src/lib/operator-ip-guard.js';

const detect = detectOperatorIp as unknown as ReturnType<typeof vi.fn>;
const run = runCommandAsync as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  disarmOperatorIpGuard();
  vi.clearAllMocks();
});

function sshDown() {
  return Object.assign(new Error('Command failed: ssh\nssh: connect: Connection timed out'), {
    status: 255,
    stderr: 'ssh: connect: Connection timed out',
  });
}

describe('operator IP guard', () => {
  it('stays quiet when nothing is armed', async () => {
    await expect(assertOperatorIpUnchanged({ detect })).resolves.toBeUndefined();
    expect(detect).not.toHaveBeenCalled();
  });

  it('stays quiet when the IP is unchanged or cannot be read', async () => {
    armOperatorIpGuard({ ip: '1.2.3.4' });
    detect.mockResolvedValueOnce({ ip: '1.2.3.4' });
    await expect(assertOperatorIpUnchanged({ detect })).resolves.toBeUndefined();
    disarmOperatorIpGuard();
    armOperatorIpGuard({ ip: '1.2.3.4' });
    detect.mockRejectedValueOnce(new Error('offline'));
    await expect(assertOperatorIpUnchanged({ detect })).resolves.toBeUndefined();
  });

  it('says what happened and what to do when the IP changed', async () => {
    armOperatorIpGuard({ ip: '1.2.3.4' });
    detect.mockResolvedValue({ ip: '9.9.9.9' });
    await expect(assertOperatorIpUnchanged({ detect })).rejects.toThrow(
      /public IP changed.*1\.2\.3\.4.*9\.9\.9\.9.*Switch back.*run the command again/s,
    );
  });

  it('fails an SSH transport failure at once, without waiting out the retries', async () => {
    armOperatorIpGuard({ ip: '1.2.3.4' });
    detect.mockResolvedValue({ ip: '9.9.9.9' });
    run.mockRejectedValue(sshDown());
    const { sshRun } = await import('../../../src/lib/ssh.js');
    // Real timers: a retry would sleep 5 s, so a pass inside the test timeout
    // proves the first failure was final.
    await expect(sshRun('5.6.7.8', '/k', ['true'])).rejects.toMatchObject({
      code: 'OPERATOR_IP_CHANGED',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
