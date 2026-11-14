/**
 * Census: every provider resource the CLI's Pulumi programs construct has a
 * probe in stack-probes.ts. A stack is deleted only when everything it
 * recorded reads 404, and a type with no probe reads unknown, so a new
 * resource type added to a program without a probe would keep every stack of
 * that provider forever (the stale-stack sweep would silently do nothing).
 * The walk reads the constructions in src/lib and resolves each class from
 * the installed SDK, so the check follows the code, not a list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vultr from '@ediri/vultr';
import * as digitalocean from '@pulumi/digitalocean';
import * as hcloud from '@pulumi/hcloud';
import * as linode from '@pulumi/linode';
import * as scaleway from '@pulumiverse/scaleway';
import { describe, expect, it } from 'vitest';
import { PROBED_TYPES } from '../../e2e/utils/stack-probes.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const SDKS: Record<string, { provider: string; mod: unknown }> = {
  '@pulumi/hcloud': { provider: 'hetzner', mod: hcloud },
  '@pulumi/digitalocean': { provider: 'digitalocean', mod: digitalocean },
  '@pulumi/linode': { provider: 'linode', mod: linode },
  '@ediri/vultr': { provider: 'vultr', mod: vultr },
  '@pulumiverse/scaleway': { provider: 'scaleway', mod: scaleway },
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

interface Construction {
  file: string;
  provider: string;
  path: string;
  type: string;
}

const badImports: string[] = [];

function constructions(): Construction[] {
  const out: Construction[] = [];
  for (const file of walk(join(ROOT, 'src', 'lib'))) {
    const src = readFileSync(file, 'utf8');
    // import * as <ns> from '<pkg>'
    const ns: Record<string, string> = {};
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (
        SDKS[m[1]] &&
        !new RegExp(`^\\s*import \\* as \\w+ from ['"]${m[1]}['"]`, 'm').test(m[0])
      ) {
        badImports.push(`${file}: ${m[0].trim()}`);
      }
    }
    for (const m of src.matchAll(/import \* as (\w+) from ['"]([^'"]+)['"]/g)) {
      if (SDKS[m[2]]) ns[m[1]] = m[2];
    }
    for (const m of src.matchAll(/new (\w+)\.([A-Za-z.]+)\(/g)) {
      const pkg = ns[m[1]];
      if (!pkg) continue;
      let cls: unknown = SDKS[pkg].mod;
      for (const part of m[2].split('.'))
        cls = (cls as Record<string, unknown> | undefined)?.[part];
      const type = (cls as { __pulumiType?: string } | undefined)?.__pulumiType;
      out.push({ file, provider: SDKS[pkg].provider, path: m[2], type: type ?? '' });
    }
  }
  return out;
}

const found = constructions();

describe('stack probe census', () => {
  it('every SDK import is `import * as X from <pkg>`, the one form the walk reads', () => {
    expect(
      badImports,
      `these files import a provider SDK in a form the census cannot follow (a named or default import hides its constructions); use import * as X: ${badImports.join('; ')}`,
    ).toEqual([]);
  });

  it('finds the constructions (guards against an empty walk)', () => {
    expect(found.map((c) => c.type)).toContain('hcloud:index/server:Server');
    expect(new Set(found.map((c) => c.provider)).size).toBe(5);
  });

  it.each(found.map((c) => [`${c.provider} ${c.path}`, c] as const))(
    '%s resolves to a class and has a probe',
    (_name, c) => {
      expect(c.type, `${c.path} did not resolve from the ${c.provider} SDK`).not.toBe('');
      expect(PROBED_TYPES[c.provider]).toContain(c.type);
    },
  );
});
