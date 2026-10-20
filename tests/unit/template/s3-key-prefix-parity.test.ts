import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('template S3_KEY_PREFIX accepts exactly the CLI env names', () => {
  it('app regex is the CLI ENV_NAME_FORMAT body plus a trailing slash, optional', () => {
    const cli = /const ENV_NAME_FORMAT = \/\^(.+)\$\/;/.exec(read('src/lib/deploy/prompts.js'));
    const app = /S3_KEY_PREFIX: z\s*\.string\(\)\s*\.regex\(\/\^(.+)\$\/\)/.exec(
      read('carbon/src/server/lib/env.ts'),
    );
    expect(cli, 'ENV_NAME_FORMAT literal not found').not.toBeNull();
    expect(app, 'S3_KEY_PREFIX regex literal not found').not.toBeNull();
    expect(app?.[1]).toBe(`(${cli?.[1]}\\/)?`);
  });
});
