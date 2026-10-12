import { describe, expect, it, vi } from 'vitest';
import { removeOrphanStacks } from '../../../src/down.js';

const yippy = {
  project: 'yippy',
  workingDir: '/home/u/repos/yippy',
  configFiles: ['/home/u/repos/yippy/docker-compose.yml'],
  containers: [{ name: 'yippy-db', state: 'exited' }],
};
const carbon = { ...yippy, project: 'carbon', workingDir: '/home/u/repos/vibecarbon/carbon' };
const live = { ...yippy, project: 'live', workingDir: '/home/u/repos/live' };

function setup(
  opts: {
    stacks?: unknown[];
    volumes?: string;
    confirms?: unknown[];
    isTTY?: boolean;
    yes?: boolean;
    exists?: (p: string) => boolean;
  } = {},
) {
  const calls: string[][] = [];
  const run = vi.fn((_bin: string, argv: string[]) => {
    calls.push(argv);
    return argv[0] === 'volume' && argv[1] === 'ls' ? (opts.volumes ?? '') : '';
  });
  const answers = [...(opts.confirms ?? [])];
  const confirm = vi.fn(async () => answers.shift());
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m) };
  const promise = removeOrphanStacks({
    list: () => (opts.stacks ?? [yippy]) as never,
    find: (stacks: never[]) =>
      (stacks as { project: string; workingDir: string }[])
        .map((s) => ({
          ...s,
          reason: s.project === 'carbon' ? 'files-missing' : 'folder-missing',
        }))
        .filter((s) => s.project !== 'live') as never,
    run: run as never,
    confirm: confirm as never,
    isTTY: opts.isTTY ?? true,
    yes: opts.yes ?? false,
    log,
    home: '/home/u',
  });
  return { promise, calls, run, confirm, logs };
}

describe('removeOrphanStacks', () => {
  it('reports when there are no orphans and runs nothing', async () => {
    const t = setup({ stacks: [] });
    expect(await t.promise).toEqual({ removed: [], keptVolumes: [] });
    expect(t.logs).toEqual(['no orphaned local stacks found']);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('removes containers with the exact compose argv, never -v', async () => {
    const t = setup({ confirms: [true] });
    const res = await t.promise;
    expect(res.removed).toEqual(['yippy']);
    expect(t.calls[0]).toEqual(['compose', '-p', 'yippy', 'down', '--remove-orphans']);
    for (const argv of t.calls) expect(argv).not.toContain('-v');
  });

  it('keeps volumes when confirm returns false', async () => {
    const t = setup({ volumes: 'yippy_db\nyippy_storage\n', confirms: [true, false] });
    const res = await t.promise;
    expect(res.keptVolumes).toEqual(['yippy_db', 'yippy_storage']);
    expect(t.calls.some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
    expect(t.logs).toContain(
      'kept yippy_db, yippy_storage; remove later with docker volume rm yippy_db yippy_storage',
    );
  });

  it('asks about volumes with default no and the moved-project hint', async () => {
    const t = setup({ volumes: 'yippy_db\n', confirms: [true, false] });
    await t.promise;
    expect(t.confirm).toHaveBeenLastCalledWith({
      message: "delete yippy's data volumes too? this can't be undone",
      initialValue: false,
    });
    expect(t.logs).toContain(
      'if you moved this project, keep them: `vibecarbon up` in its new folder reuses them',
    );
  });

  it('keeps volumes with -y and never prompts', async () => {
    const t = setup({ volumes: 'yippy_db\n', yes: true });
    const res = await t.promise;
    expect(t.confirm).not.toHaveBeenCalled();
    expect(res.removed).toEqual(['yippy']);
    expect(res.keptVolumes).toEqual(['yippy_db']);
    expect(t.calls.some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
  });

  it('keeps volumes off-TTY', async () => {
    const t = setup({ volumes: 'yippy_db\n', yes: true, isTTY: false });
    const res = await t.promise;
    expect(t.confirm).not.toHaveBeenCalled();
    expect(res.keptVolumes).toEqual(['yippy_db']);
    expect(t.calls.some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
  });

  it('removes volumes when confirm returns true', async () => {
    const t = setup({ volumes: 'yippy_db\nyippy_storage\n', confirms: [true, true] });
    const res = await t.promise;
    expect(t.calls).toContainEqual(['volume', 'rm', 'yippy_db', 'yippy_storage']);
    expect(res.keptVolumes).toEqual([]);
  });

  it('removes nothing when the first confirm is declined', async () => {
    const t = setup({ confirms: [false] });
    expect(await t.promise).toEqual({ removed: [], keptVolumes: [] });
    expect(t.run).not.toHaveBeenCalled();
  });

  it('lists the right reason text per stack', async () => {
    const t = setup({ stacks: [yippy, carbon], confirms: [false] });
    await t.promise;
    expect(t.logs.join('\n')).toContain('yippy (~/repos/yippy), folder is gone');
    expect(t.logs.join('\n')).toContain(
      'carbon (~/repos/vibecarbon/carbon), started from files that are no longer there',
    );
  });

  it('never passes a non-orphan stack to run', async () => {
    const t = setup({ stacks: [yippy, live], yes: true });
    await t.promise;
    expect(t.calls.flat()).not.toContain('live');
  });
});
