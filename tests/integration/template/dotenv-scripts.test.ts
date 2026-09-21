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
  // Shell over file with `||`, not `??`: an exported-but-EMPTY variable
  // (`VITE_PUBLIC_URL=` in a shell, a compose `ARG` defaulting to "") falls
  // through to the file, as the `if (process.env.X)` these replaced did and as
  // the e2e harness (tests/e2e/sweep-project.ts) was ruled to. vite.config.ts
  // spreads process.env over the file read and is judged elsewhere.
  for (const file of readers.filter((f) => f.startsWith('scripts/'))) {
    it(`${file} lets a blank shell export fall through to the file`, () => {
      const src = readFileSync(join(carbon, file), 'utf-8');
      expect(src).toMatch(/process\.env\[key\] \|\| fileEnv\[key\]/);
      expect(src).not.toMatch(/process\.env\[key\] \?\?/);
    });
  }
  it('dev-init.js writes env lines with formatDotenvLine', () => {
    const src = readFileSync(join(carbon, 'scripts/dev-init.js'), 'utf-8');
    expect(src).toContain('formatDotenvLine');
    expect(src).not.toMatch(/^[A-Z_]+="\$\{/m);
  });
});
