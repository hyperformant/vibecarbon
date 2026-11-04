/**
 * Single compose: write-node-roles puts `primary` in the server's wal-g role
 * file before start-compose-stack, so the db's first start reads it
 * (walg-role.js). The write goes through ssh.js's argv sshRun, which is
 * replaced here by a fake that keeps its argv contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeWalgRoleWriteShell } from '../../../src/lib/deploy/walg-role.js';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ ip: string; argv: string[] }>,
  answer: 'WALG_ROLE_FILE=primary',
}));

vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const { assertSshRunArgv } = await import('../../_shared/ssh-contract.js');
  return {
    ...actual,
    sshRun: async (ip: string, _k: string, argv: unknown) => {
      assertSshRunArgv(argv);
      h.calls.push({ ip, argv });
      return h.answer;
    },
  };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const writeNodeRoles = (EFFECTS as Record<string, (c: object) => Promise<void>>).writeNodeRoles;

const ctx = { serverIp: '203.0.113.7', sshKeyPath: '/k', projectConfig: { projectName: 'acme' } };

beforeEach(() => {
  h.calls = [];
  h.answer = 'WALG_ROLE_FILE=primary';
});

describe('single compose write-node-roles', () => {
  it('writes primary into the role file on the one server', async () => {
    await writeNodeRoles(ctx);
    expect(h.calls).toEqual([
      { ip: '203.0.113.7', argv: ['sh', '-c', composeWalgRoleWriteShell('acme', 'primary')] },
    ]);
  });

  it('fails the deploy step when the role does not read back', async () => {
    h.answer = '';
    await expect(writeNodeRoles(ctx)).rejects.toThrow(
      /wal-g role on 203\.0\.113\.7 read back as "" after writing primary/,
    );
  });
});
