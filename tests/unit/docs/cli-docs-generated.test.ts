import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../../src/lib/cli/command-registry.js';
import { DOC_TARGETS, generateAll } from '../../../src/lib/cli/docs-gen.js';

/**
 * Drift guard: command and flag docs are generated from each command's SPEC
 * (`pnpm docs:cli`). A stale generated region fails here.
 */
const ROOT = process.cwd();
const onDisk = new Map<string, string>(
  DOC_TARGETS.map((p: string) => [p, readFileSync(join(ROOT, p), 'utf-8')]),
);

describe('generated CLI docs', () => {
  it('every target file matches what the generator produces', async () => {
    const generated = await generateAll(onDisk);
    for (const [path, text] of onDisk) {
      expect(generated.get(path), `${path} is stale: run pnpm docs:cli`).toBe(text);
    }
  });

  it('cli.mdx has a flags region for every registry command', () => {
    const mdx = onDisk.get('carbon/content/docs/cli.mdx') as string;
    for (const { name } of COMMANDS) {
      expect(mdx, `missing "flags ${name}" region`).toContain(
        `{/* BEGIN GENERATED: flags ${name} */}`,
      );
    }
    expect(mdx).toContain('{/* BEGIN GENERATED: global-flags */}');
  });
});
