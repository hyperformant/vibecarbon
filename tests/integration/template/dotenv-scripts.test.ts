import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const carbon = join(import.meta.dirname, '..', '..', '..', 'carbon');
const readers = [
  'scripts/dev.js',
  'scripts/docker-up.js',
  'scripts/generate-rss.ts',
  'scripts/generate-seo.ts',
  'scripts/generate-sitemap.ts',
  'vite.config.ts',
];

describe('template scripts read .env through scripts/lib/dotenv.js', () => {
  for (const file of readers) {
    it(`${file} imports the shared reader and owns no regex over .env text`, () => {
      const src = readFileSync(join(carbon, file), 'utf-8');
      expect(src).toMatch(/from '\.\.?\/(scripts\/)?lib\/dotenv\.js'/);
      expect(src).not.toMatch(/\[\^"'\\n\]|\["'\]\?\(|loadEnv\(/);
    });
  }
  it('dev-init.js writes env lines with formatDotenvLine', () => {
    const src = readFileSync(join(carbon, 'scripts/dev-init.js'), 'utf-8');
    expect(src).toContain('formatDotenvLine');
    expect(src).not.toMatch(/^[A-Z_]+="\$\{/m);
  });
});
