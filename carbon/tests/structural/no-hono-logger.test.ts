import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * hono/logger records the full request URL, query string included, so
 * password-reset, magic-link and OAuth tokens would land in logs. The
 * server logs requests through middleware/access-log.ts instead.
 */
const SERVER = join(__dirname, '..', '..', 'src', 'server');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.[cm]?[jt]sx?$/.test(name) ? [p] : [];
  });
}

describe('no hono/logger', () => {
  it('no server file imports hono/logger', () => {
    const offenders = files(SERVER).filter((f) => /from\s+['"]hono\/logger['"]/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
