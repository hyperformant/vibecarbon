import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDbPort } from '@server/db/port';

/**
 * One port rule for the server (lib/env.ts) and drizzle-kit
 * (drizzle.config.ts). They used to carry two copies, and drizzle's shifted
 * the port for a remote host too.
 */
describe('resolveDbPort', () => {
  it.each([
    ['localhost, no offset', { DB_HOST: 'localhost', DB_PORT: '5432' }, '5432'],
    [
      'localhost + DEV_PORT_OFFSET',
      { DB_HOST: 'localhost', DB_PORT: '5432', DEV_PORT_OFFSET: '100' },
      '5532',
    ],
    ['127.0.0.1 + offset', { DB_HOST: '127.0.0.1', DEV_PORT_OFFSET: '10' }, '5442'],
    [
      'DEV_DB_PORT wins over the offset',
      { DB_HOST: 'localhost', DEV_DB_PORT: '6000', DEV_PORT_OFFSET: '100' },
      '6000',
    ],
    [
      'a remote host keeps DB_PORT',
      { DB_HOST: 'db', DB_PORT: '5432', DEV_PORT_OFFSET: '100', DEV_DB_PORT: '6000' },
      '5432',
    ],
    [
      'production never shifts',
      { NODE_ENV: 'production', DB_HOST: 'localhost', DB_PORT: '5432', DEV_PORT_OFFSET: '100' },
      '5432',
    ],
    ['a remote host without DB_PORT stays unset', { DB_HOST: 'db' }, undefined],
  ])('%s', (_name, env, expected) => {
    expect(resolveDbPort(env)).toBe(expected);
  });

  it('lib/env.ts and drizzle.config.ts both use it', () => {
    const root = join(__dirname, '../../..');
    for (const file of ['src/server/lib/env.ts', 'drizzle.config.ts']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).toMatch(/import \{ resolveDbPort \} from '[^']*db\/port'/);
      expect(text, file).toMatch(/resolveDbPort\(/);
      // No second copy of the rule.
      expect(text, file).not.toMatch(/DEV_DB_PORT \|\|/);
    }
  });
});
