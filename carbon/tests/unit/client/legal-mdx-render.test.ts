import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, run } from '@mdx-js/mdx';
import { renderToString } from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { describe, expect, it } from 'vitest';

const LEGAL_DIR = join(__dirname, '../../../content/docs/legal');

// Raw {{PLACEHOLDER}} tokens are live JSX expressions in MDX ({{X}} parses as
// an object-shorthand expression referencing an undefined variable), so they
// compile fine and then throw ReferenceError at render — the Legal route shows
// the ErrorBoundary until `vibecarbon create` substitutes them. Template
// values must instead flow in as props from Legal.tsx ({props.projectName}).
describe('legal MDX pages', () => {
  const files = readdirSync(LEGAL_DIR).filter((f) => f.endsWith('.mdx'));

  it('has legal pages to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} renders without unsubstituted placeholders`, async () => {
      const source = readFileSync(join(LEGAL_DIR, file), 'utf-8');

      const code = await compile(source, {
        outputFormat: 'function-body',
        remarkPlugins: [remarkFrontmatter, remarkGfm, remarkMdxFrontmatter],
      });
      const mod = await run(String(code), { ...runtime, baseUrl: import.meta.url });

      const html = renderToString(
        mod.default({ projectName: 'test-app', adminEmail: 'admin@example.com' })
      );

      expect(html).not.toContain('{{');
      expect(html).toContain('test-app');
      expect(html).toContain('admin@example.com');
    });
  }
});
