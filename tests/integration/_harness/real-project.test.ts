import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyRealProject, realProject } from './real-project.js';

describe('realProject', () => {
  let projects: string[] = [];
  afterEach(() => {
    for (const p of projects) destroyRealProject(p);
    projects = [];
  });

  it('produces a real vibecarbon project (has .vibecarbon.json + package.json)', () => {
    const p = realProject();
    projects.push(p);
    expect(existsSync(join(p, '.vibecarbon.json'))).toBe(true);
    expect(existsSync(join(p, 'package.json'))).toBe(true);
  }, 120_000);

  it('package.json has expected dev:start / dev:stop scripts', () => {
    const p = realProject();
    projects.push(p);
    const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf-8'));
    expect(pkg.scripts['dev:start']).toBeDefined();
    expect(pkg.scripts['dev:stop']).toBeDefined();
  }, 120_000);

  it('deployMode option overrides .vibecarbon.json', () => {
    const p = realProject({ deployMode: 'k8s-ha' });
    projects.push(p);
    const cfg = JSON.parse(readFileSync(join(p, '.vibecarbon.json'), 'utf-8'));
    expect(cfg.deployMode).toBe('k8s-ha');
  }, 120_000);

  it('envs option populates multi-env config', () => {
    const p = realProject({ envs: ['prod', 'staging'] });
    projects.push(p);
    const cfg = JSON.parse(readFileSync(join(p, '.vibecarbon.json'), 'utf-8'));
    expect(Object.keys(cfg.envs)).toEqual(expect.arrayContaining(['prod', 'staging']));
  }, 120_000);

  it('withDeployedState writes .vibecarbon/<env>.json', () => {
    const p = realProject({ envs: ['prod'], withDeployedState: true });
    projects.push(p);
    expect(existsSync(join(p, '.vibecarbon', 'prod.json'))).toBe(true);
  }, 120_000);

  it('two clones are independent — mutating one does not affect other', () => {
    const a = realProject();
    const b = realProject();
    projects.push(a, b);
    // mutate a's package.json
    const pkgA = JSON.parse(readFileSync(join(a, 'package.json'), 'utf-8'));
    pkgA.name = 'mutated';
    require('node:fs').writeFileSync(join(a, 'package.json'), JSON.stringify(pkgA, null, 2));
    // b should be unaffected
    const pkgB = JSON.parse(readFileSync(join(b, 'package.json'), 'utf-8'));
    expect(pkgB.name).not.toBe('mutated');
  }, 120_000);

  it('cached: second realProject() call is fast (clone, not create)', () => {
    realProject(); // ensure cache is populated
    const t0 = Date.now();
    const p = realProject();
    projects.push(p);
    const elapsed = Date.now() - t0;
    // cp -a of ~200 files should be well under 2s.
    expect(elapsed).toBeLessThan(2000);
  }, 120_000);
});
