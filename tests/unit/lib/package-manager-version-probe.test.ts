import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// Corepack's pnpm shim honours the `packageManager` pin of its cwd, so a probe
// run inside a project pinned to a pnpm that does not exist asked the registry
// for it (404) and fell back to a guessed default instead of the host's pnpm
// (seen as `upgrade` re-pinning a stale pin). The probe asks from outside any
// project, so the answer is always the host's.
const calls: Array<{ cmd: string[]; opts: Record<string, unknown> }> = [];
vi.mock('../../../src/lib/command.js', () => ({
  runCommand: (cmd: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, opts });
    return '42.1.3\n';
  },
}));

const { getPackageManagerVersion } = await import('../../../src/lib/package-manager.js');

describe('getPackageManagerVersion', () => {
  it('probes the host package manager from outside any project directory', () => {
    expect(getPackageManagerVersion('pnpm').split('@')).toEqual(['pnpm', '42.1.3']);
    const probe = calls.find((c) => c.cmd[0] === 'pnpm' && c.cmd[1] === '--version');
    expect(probe?.opts.cwd).toBe(homedir());
  });
});
