import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPortOffset } from '../../../src/up.js';

/**
 * DEV_PORT_OFFSET and its client-visible twin VITE_DEV_PORT_OFFSET must be
 * written in lockstep: vite only exposes VITE_-prefixed vars, and the admin
 * panel's service links need the offset to build `studio.localhost:<80+n>`
 * (RCA 2026-07-17: port-less links sent swim2's admin panel into the OTHER
 * project's traefik on :80).
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
    expect(envLocal()).toMatch(/^DEV_PORT_OFFSET="100"$/m);
    expect(envLocal()).toMatch(/^VITE_DEV_PORT_OFFSET="100"$/m);
  });

  it('updates both keys in lockstep on subsequent calls', () => {
    setPortOffset(100, dir);
    setPortOffset(200, dir);
    const content = envLocal();
    expect(content).toMatch(/^DEV_PORT_OFFSET="200"$/m);
    expect(content).toMatch(/^VITE_DEV_PORT_OFFSET="200"$/m);
    expect(content).not.toContain('"100"');
  });

  it('adds the missing VITE twin to a pre-twin .env.local (upgrade path)', () => {
    writeFileSync(
      join(dir, '.env.local'),
      'SOME_KEY="x"\n\n# Port offset (set by vibecarbon up to avoid conflicts)\nDEV_PORT_OFFSET="100"\n',
    );
    setPortOffset(100, dir);
    const content = envLocal();
    expect(content).toMatch(/^VITE_DEV_PORT_OFFSET="100"$/m);
    expect(content).toMatch(/^SOME_KEY="x"$/m);
    expect(content.match(/DEV_PORT_OFFSET/g)).toHaveLength(2); // the key + its VITE twin (substring)
  });
});
