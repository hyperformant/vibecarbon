/**
 * The n8n SSO hook installs itself whatever layout n8n's dependencies have.
 *
 * Why. The hook has to splice a real Express router Layer after cookie-parser.
 * It used to get that class with `require('router/lib/layer')`, which only
 * resolves while `router` is hoisted into n8n's node_modules. n8n ships a pnpm
 * layout where it is not, so the require threw, the hook logged one warning,
 * and every super admin landed on n8n's login page.
 *
 * How. The real hook file runs against a fake Express app whose Layer class is
 * only reachable through the router stack, the way it is inside the image.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileFunction } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const REPO = join(__dirname, '../../..');
const HOOK_FILES = ['services/n8n/hooks/hooks.js', 'carbon/volumes/n8n/hooks.js'];

type Handler = (req: unknown, res: unknown, next: () => void) => Promise<void>;

/**
 * The hook file, loaded as n8n loads it: CommonJS. The template's package.json
 * says ESM, and n8n's internals are not installed here, so `require` knows only
 * what the hook takes from n8n's own tree. `router` is deliberately absent.
 */
function loadHook(hookFile: string) {
  const module = { exports: {} as Record<string, unknown> };
  const require = (id: string) => {
    if (id === 'node:crypto') return { randomBytes };
    if (id === 'bcryptjs') return { hashSync: () => 'hashed' };
    throw new Error(`Cannot find module '${id}'`);
  };
  compileFunction(readFileSync(join(REPO, hookFile), 'utf-8'), ['module', 'require'])(
    module,
    require,
  );
  return module.exports as {
    n8n: { ready: Array<(this: unknown, server: unknown) => Promise<void>> };
  };
}

class FakeLayer {
  name: string;
  constructor(
    public path: string,
    public options: { end: boolean },
    public handle: (...args: unknown[]) => unknown,
  ) {
    this.name = handle.name || '<anonymous>';
  }
  match() {
    return true;
  }
}

async function runReady(hookFile: string, User: unknown = {}) {
  const stack = [
    new FakeLayer('/', { end: false }, function query() {}),
    new FakeLayer('/', { end: false }, function cookieParser() {}),
    new FakeLayer('/', { end: false }, function bodyParser() {}),
  ];
  const context = { dbCollections: { User } };
  await loadHook(hookFile).n8n.ready[0].call(context, { app: { router: { stack } } });
  return stack;
}

describe.each(HOOK_FILES)('%s', (hookFile) => {
  it('splices a real Layer right after cookie-parser, with no router package to resolve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stack = await runReady(hookFile);

    expect(stack.map((l) => l.name)).toEqual(['query', 'cookieParser', 'middleware', 'bodyParser']);
    expect(stack[2]).toBeInstanceOf(FakeLayer);
    expect(stack[2].options).toEqual({ end: false });
    expect(log).toHaveBeenCalledWith('[hooks.js] ForwardAuth SSO middleware installed');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('router Layer');

    warn.mockRestore();
    log.mockRestore();
  });

  it('a first SSO visit creates the user as owner, through the role relation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const created: Array<Record<string, unknown>> = [];
    const User = {
      findOne: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'u1' }),
      create: (row: Record<string, unknown>) => {
        created.push(row);
        return row;
      },
      save: async (row: unknown) => row,
    };
    const stack = await runReady(hookFile, User);
    const next = vi.fn();
    const req = { url: '/', cookies: {}, headers: { 'x-user-email': 'owner@test.local' } };

    await (stack[2].handle as Handler)(req, {}, next);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      email: 'owner@test.local',
      role: { slug: 'global:owner' },
    });
    expect(created[0]).not.toHaveProperty('roleSlug');
    expect(next).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
