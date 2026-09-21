/**
 * Final review L4 (2026-09-21): `scale` replays the OLD server's whole
 * `/opt/<project>/.env` onto the new one through `renderBundle`, which
 * re-encodes every override and throws `DotenvValueError` on a value the
 * portable grammar refuses — a hand-edited server value with a tab, or `'`
 * next to `"`, aborted scale AFTER the new server existed. The old env is now
 * filtered first: each unportable key is dropped with one warning naming the
 * key and the reason (never the value) and the operator is told to set it
 * again with `vibecarbon configure`. Fixture values only.
 */
import { describe, expect, it, vi } from 'vitest';

// Same safety-mock recipe as apply-ca-bounds-to-config.test.ts: scale.js's
// module graph must resolve at import time, none of it is exercised here.
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn() {}, error() {}, step() {}, success() {} },
    note() {},
    outro() {},
  };
});
vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));
vi.mock('../../../src/lib/command.js', () => ({ runCommand: vi.fn(() => '') }));
vi.mock('../../../src/lib/config.js', () => ({ saveProjectConfig: vi.fn() }));

const { dropUnportableEnv } = await import('../../../src/scale.js');
const { encodeDotenvValue } = await import('../../../src/lib/dotenv.js');

describe('dropUnportableEnv', () => {
  it('drops the one bad value, warns by key and reason only, and keeps every other key', () => {
    const oldEnv = {
      APP_IMAGE: 'ghcr.io/o/r:abc',
      SMTP_PASS: "it's fine",
      BROKEN: `mix ' and "`,
      DOMAIN: 'example.com',
    };
    const log = { warn: vi.fn() };
    const kept = dropUnportableEnv(oldEnv, { log });
    expect(kept).toEqual({
      APP_IMAGE: 'ghcr.io/o/r:abc',
      SMTP_PASS: "it's fine",
      DOMAIN: 'example.com',
    });
    expect(oldEnv.BROKEN).toBeDefined(); // input untouched
    expect(log.warn).toHaveBeenCalledTimes(1);
    const line = log.warn.mock.calls[0][0] as string;
    expect(line).toMatch(
      /^BROKEN on the old server cannot be carried over: it mixes a single quote with .*; set it again with `vibecarbon configure`$/,
    );
    expect(line).not.toContain('mix ');
    // Everything kept is something renderBundle can encode.
    for (const [key, value] of Object.entries(kept)) {
      expect(() => encodeDotenvValue(key, value)).not.toThrow();
    }
  });

  it('a tab or CR in a hand-edited server value is dropped the same way', () => {
    const log = { warn: vi.fn() };
    expect(dropUnportableEnv({ A: 'tab\there', B: 'ok' }, { log })).toEqual({ B: 'ok' });
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^A on the old server cannot be carried over: it contains a control character/,
    );
  });

  it('is silent and identity on a clean env', () => {
    const log = { warn: vi.fn() };
    const env = { A: '1', B: 'x y', C: 'say "hi"', D: '$literal' };
    expect(dropUnportableEnv(env, { log })).toEqual(env);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
