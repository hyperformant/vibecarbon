import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { setPortOffset } from '../../../src/up.js';

/**
 * DEV_PORT_OFFSET and its client-visible twin VITE_DEV_PORT_OFFSET must be
 * written in lockstep: vite only exposes VITE_-prefixed vars, and the admin
 * panel's service links need the offset to build `studio.localhost:<80+n>`
 * (RCA 2026-07-17: port-less links sent swim2's admin panel into the OTHER
 * project's traefik on :80).
 *
 * Both lines are written with formatDotenvLine: an offset is bare-alphabet, so
 * the on-disk form is `DEV_PORT_OFFSET=100`, and the match is the WHOLE
 * existing line whatever its quoting (`create` writes `=0`, pre-2026-09-20
 * files hold `="0"`) — never a second copy of the key.
 */
describe('setPortOffset', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-portoffset-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envLocal = () => readFileSync(join(dir, '.env.local'), 'utf-8');

  it('writes BOTH offset keys into a fresh .env.local', () => {
    setPortOffset(100, dir);
    expect(envLocal()).toMatch(/^DEV_PORT_OFFSET=100$/m);
    expect(envLocal()).toMatch(/^VITE_DEV_PORT_OFFSET=100$/m);
  });

  it('updates both keys in lockstep on subsequent calls', () => {
    setPortOffset(100, dir);
    setPortOffset(200, dir);
    const content = envLocal();
    expect(content).toMatch(/^DEV_PORT_OFFSET=200$/m);
    expect(content).toMatch(/^VITE_DEV_PORT_OFFSET=200$/m);
    expect(content).not.toContain('100');
  });

  it('adds the missing VITE twin to a pre-twin .env.local (upgrade path)', () => {
    writeFileSync(
      join(dir, '.env.local'),
      'SOME_KEY="x"\n\n# Port offset (set by vibecarbon up to avoid conflicts)\nDEV_PORT_OFFSET="100"\n',
    );
    setPortOffset(100, dir);
    const content = envLocal();
    expect(content).toMatch(/^DEV_PORT_OFFSET=100$/m);
    expect(content).toMatch(/^VITE_DEV_PORT_OFFSET=100$/m);
    expect(content).toMatch(/^SOME_KEY="x"$/m);
    expect(content.match(/DEV_PORT_OFFSET/g)).toHaveLength(2); // the key + its VITE twin (substring)
  });

  /** Every line holding either key, in file order. */
  const offsetLines = (content: string) =>
    content.split('\n').filter((l) => /^(VITE_)?DEV_PORT_OFFSET=/.test(l));

  it('replaces the bare lines create writes (no duplicate key, no reader disagreement)', () => {
    writeFileSync(
      join(dir, '.env.local'),
      '# from create\nPROJECT_NAME=my-app\nDEV_PORT_OFFSET=0\nVITE_DEV_PORT_OFFSET=0\nNODE_ENV=development\n',
    );
    setPortOffset(100, dir);
    const content = envLocal();
    expect(offsetLines(content)).toEqual(['DEV_PORT_OFFSET=100', 'VITE_DEV_PORT_OFFSET=100']);
    expect(parseDotenv(content)).toEqual({
      PROJECT_NAME: 'my-app',
      DEV_PORT_OFFSET: '100',
      VITE_DEV_PORT_OFFSET: '100',
      NODE_ENV: 'development',
    });
  });

  it('replaces the double-quoted lines older files hold', () => {
    writeFileSync(
      join(dir, '.env.local'),
      'DEV_PORT_OFFSET="0"\nVITE_DEV_PORT_OFFSET="0"\nKEEP="me"\n',
    );
    setPortOffset(100, dir);
    const content = envLocal();
    expect(offsetLines(content)).toEqual(['DEV_PORT_OFFSET=100', 'VITE_DEV_PORT_OFFSET=100']);
    expect(parseDotenv(content)).toEqual({
      DEV_PORT_OFFSET: '100',
      VITE_DEV_PORT_OFFSET: '100',
      KEEP: 'me',
    });
  });

  it('creates .env.local with the comment line and both keys when the file is missing', () => {
    expect(existsSync(join(dir, '.env.local'))).toBe(false);
    setPortOffset(100, dir);
    const content = envLocal();
    expect(content).toBe(
      '# Port offset (set by vibecarbon up to avoid conflicts)\nDEV_PORT_OFFSET=100\nVITE_DEV_PORT_OFFSET=100\n',
    );
    expect(parseDotenv(content)).toEqual({ DEV_PORT_OFFSET: '100', VITE_DEV_PORT_OFFSET: '100' });
  });
});
