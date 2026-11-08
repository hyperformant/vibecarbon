/**
 * Census: workflows read src/lib/images.js by importing it (through
 * .github/scripts/image-const.mjs), never by grep, sed or awk. A grep dies
 * silently the day the formatter wraps a constant onto the next line, which
 * is how publish-node-runtime-image.yml went dead after the digest pin.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { readImageConst } from '../../../.github/scripts/image-const.mjs';
import * as images from '../../../src/lib/images.js';

const ROOT = process.cwd();
const WF_DIR = join(ROOT, '.github', 'workflows');

type Step = { run?: string };
type Workflow = {
  on?: { push?: { paths?: string[] } };
  jobs?: Record<string, { steps?: Step[] }>;
};

const load = (file: string) => loadYaml(readFileSync(join(WF_DIR, file), 'utf8')) as Workflow;
const runs = (file: string): string[] =>
  Object.values(load(file).jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ''));

const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

// A line that reads the source text of images.js with a text tool.
const textRead = /\b(grep|sed|awk)\b[^\n]*images\.js/;

const SITES = [
  'publish-node-runtime-image.yml',
  'publish-db-image.yml',
  'publish-db-image-dev.yml',
  'publish-images.yml',
  'test.yml',
];

const invocations = (file: string): string[] =>
  runs(file).flatMap((r) =>
    [...r.matchAll(/image-const\.mjs\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );

describe('workflows read images.js by import, not by text', () => {
  it('no run: step greps, seds or awks src/lib/images.js', () => {
    const offenders = files.flatMap((f) =>
      runs(f)
        .flatMap((r) => r.split('\n'))
        .filter((l) => textRead.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('every image-const.mjs NAME resolves to a non-empty export', () => {
    const all = files.flatMap((f) => invocations(f).map((n) => [f, n] as const));
    for (const [f, name] of all) {
      const got = readImageConst(images, name);
      expect(got, `${f}: ${name}`).not.toBe('');
      expect(got, `${f}: ${name}`).toBe(String((images as Record<string, unknown>)[name]));
    }
  });

  it('the five read sites exist, with at least 9 invocations between them', () => {
    let total = 0;
    for (const site of SITES) {
      const n = invocations(site).length;
      expect(n, `${site} has no image-const.mjs invocation`).toBeGreaterThan(0);
      total += n;
    }
    expect(total).toBeGreaterThanOrEqual(9);
  });

  it('each path-filtered site re-runs when the reader script changes', () => {
    for (const site of SITES) {
      const paths = load(site).on?.push?.paths;
      if (paths?.includes('src/lib/images.js')) {
        expect(paths, site).toContain('.github/scripts/image-const.mjs');
      }
    }
  });
});

describe('readImageConst', () => {
  it('returns a string export and a number export as strings', () => {
    expect(readImageConst({ A: 'x:1' }, 'A')).toBe('x:1');
    expect(readImageConst({ N: 12 }, 'N')).toBe('12');
  });

  it.each([
    ['missing', {}],
    ['empty string', { A: '' }],
    ['object', { A: { b: 1 } }],
  ])('throws naming the constant when it is %s', (_label, mod) => {
    expect(() => readImageConst(mod, 'A')).toThrow(/\bA\b/);
  });

  it('resolves the real NODE_RUNTIME_IMAGE even though the formatter wraps it', () => {
    expect(readImageConst(images, 'NODE_RUNTIME_IMAGE')).toMatch(/^ghcr\.io\/.+@sha256:/);
  });
});
