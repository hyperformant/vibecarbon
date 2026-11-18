/**
 * down and reset run the template's dev:* scripts through one runner: the
 * project's package manager, the task log, the local compose env.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  run: vi.fn(),
  pm: 'npm',
  pkg: '{"scripts":{"dev:stop":"docker compose down"}}',
  error: vi.fn(),
}));

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readFileSync: () => m.pkg,
}));
vi.mock('@clack/prompts', () => ({ log: { error: m.error } }));
vi.mock('../../../src/lib/command.js', () => ({ runCommandThroughTaskLog: m.run }));
vi.mock('../../../src/lib/images.js', () => ({ localComposeEnv: () => ({ DB_IMAGE: 'x' }) }));
vi.mock('../../../src/lib/project.js', () => ({ detectPackageManager: () => m.pm }));

const { requireDevScript, runDevScript } = await import('../../../src/lib/cli/dev-script.js');

const labels = { title: (pm: string) => `Stopping with ${pm}`, successMessage: 'Stopped' };

beforeEach(() => {
  vi.clearAllMocks();
  m.pm = 'npm';
});

describe('runDevScript', () => {
  it('npm runs `npm run <script>`; the others run `<pm> <script>`', async () => {
    await runDevScript('/p', 'dev:stop', labels);
    m.pm = 'pnpm';
    await runDevScript('/p', 'dev:stop', labels);
    expect(m.run.mock.calls).toEqual([
      [
        ['npm', 'run', 'dev:stop'],
        {
          cwd: '/p',
          title: 'Stopping with npm',
          successMessage: 'Stopped',
          env: { DB_IMAGE: 'x' },
          cleanEnv: true,
        },
      ],
      [
        ['pnpm', 'dev:stop'],
        {
          cwd: '/p',
          title: 'Stopping with pnpm',
          successMessage: 'Stopped',
          env: { DB_IMAGE: 'x' },
          cleanEnv: true,
        },
      ],
    ]);
  });

  it("exits with the script's status when it fails", async () => {
    m.run.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 3 }));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runDevScript('/p', 'dev:stop', labels);
      expect(exit).toHaveBeenCalledWith(3);
    } finally {
      exit.mockRestore();
    }
  });
});

describe('requireDevScript', () => {
  it('exits 1 naming the script when package.json lacks it', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      requireDevScript('/p', 'dev:stop');
      expect(exit).not.toHaveBeenCalled();
      requireDevScript('/p', 'dev:reset');
      expect(m.error).toHaveBeenCalledWith('No "dev:reset" script found in package.json.');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});
