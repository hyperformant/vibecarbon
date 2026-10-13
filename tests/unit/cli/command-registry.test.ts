import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../../../src/add.js';
import { COMMANDS, loadAllSpecs } from '../../../src/lib/cli/command-registry.js';

const dispatched = [
  ...readFileSync(join(process.cwd(), 'src', 'cli.js'), 'utf-8').matchAll(
    /^\s+case '([a-z-]+)':/gm,
  ),
]
  .map((m) => m[1])
  .sort();

const specs = await loadAllSpecs();

describe('command registry', () => {
  it('covers exactly the commands cli.js dispatches (aliases aside)', () => {
    expect(dispatched.length).toBeGreaterThan(15);
    expect(COMMANDS.map((e) => e.name).sort()).toEqual(dispatched);
  });

  it('gives `next` the ? alias and no other command an alias', () => {
    expect(COMMANDS.find((e) => e.name === 'next')?.aliases).toEqual(['?']);
    expect(COMMANDS.filter((e) => e.aliases).map((e) => e.name)).toEqual(['next']);
  });

  it('groups commands into the four help categories', () => {
    const by = (cat: string) => COMMANDS.filter((e) => e.category === cat).map((e) => e.name);
    expect(by('dev')).toEqual([
      'next',
      'create',
      'up',
      'down',
      'status',
      'reset',
      'add',
      'remove',
      'configure',
      'upgrade',
      'telemetry',
    ]);
    expect(by('deploy')).toEqual(['deploy', 'destroy', 'backup', 'restore', 'failover', 'scale']);
    expect(by('debug')).toEqual(['shell', 'diagnose', 'console', 'access']);
    expect(by('license')).toEqual(['activate', 'deactivate']);
  });

  describe.each(specs.map(({ entry, spec }) => [entry.name, entry, spec] as const))(
    '%s',
    (_n, entry, spec) => {
      it('loads a spec with the same name', () => {
        expect(spec.name).toBe(entry.name);
      });
      it('has a non-empty summary', () => {
        expect(typeof spec.summary).toBe('string');
        expect(spec.summary.trim()).not.toBe('');
        expect(spec.summary).not.toContain('\n');
        expect(spec.summary).not.toContain('—');
      });
      it('describes every flag', () => {
        for (const f of spec.flags ?? []) {
          expect(f.description?.trim(), `-${f.name}`).toBeTruthy();
        }
      });
      it('includes the universal -h and -v flags', () => {
        const names = (spec.flags ?? []).map((f: { name: string }) => f.name);
        expect(names).toContain('h');
        expect(names).toContain('v');
      });
    },
  );

  it('add loads the same spec buildSpec() produces', () => {
    const add = specs.find((s) => s.entry.name === 'add')?.spec;
    expect(add).toEqual(buildSpec());
  });
});
