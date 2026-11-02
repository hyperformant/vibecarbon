/**
 * Writers into the project refuse a path with a symlinked component: the
 * write would land wherever the link points, possibly outside the project.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { symlinkedComponent, writeSidecar } from '../../../src/lib/project-write-guard.js';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'vc-write-guard-'));
  const outside = mkdtempSync(join(tmpdir(), 'vc-write-guard-out-'));
  mkdirSync(join(root, 'k8s', 'base'), { recursive: true });
  writeFileSync(join(outside, 'target.yaml'), 'x\n');
  return { root, outside };
}

describe('symlinkedComponent', () => {
  it('null for plain directories and files, existing or not', () => {
    const { root } = project();
    writeFileSync(join(root, 'k8s', 'base', 'a.yaml'), 'a\n');
    expect(symlinkedComponent(root, 'k8s/base/a.yaml')).toBeNull();
    expect(symlinkedComponent(root, 'k8s/base/new/b.yaml')).toBeNull();
    expect(symlinkedComponent(root, 'missing/dir/c.yaml')).toBeNull();
  });

  it('names a symlinked directory on the way', () => {
    const { root, outside } = project();
    symlinkSync(outside, join(root, 'k8s', 'base', 'observability'));
    expect(symlinkedComponent(root, 'k8s/base/observability/target.yaml')).toBe(
      'k8s/base/observability',
    );
  });

  it('names a symlinked file itself', () => {
    const { root, outside } = project();
    symlinkSync(join(outside, 'target.yaml'), join(root, 'k8s', 'base', 'a.yaml'));
    expect(symlinkedComponent(root, 'k8s/base/a.yaml')).toBe('k8s/base/a.yaml');
  });

  it('a dangling symlink counts too', () => {
    const { root } = project();
    symlinkSync(join(root, 'nowhere'), join(root, 'k8s', 'base', 'gone'));
    expect(symlinkedComponent(root, 'k8s/base/gone/x.yaml')).toBe('k8s/base/gone');
  });
});

describe('writeSidecar', () => {
  it('writes a new sidecar, and replaces a plain old one', () => {
    const { root } = project();
    const path = join(root, 'a.yaml.upgrade-backup');
    expect(writeSidecar(path, 'one\n')).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('one\n');
    expect(writeSidecar(path, 'two\n')).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('two\n');
  });

  it('refuses a sidecar path that is a symlink and leaves its target untouched', () => {
    const { root, outside } = project();
    const path = join(root, 'a.yaml.upgrade-new');
    symlinkSync(join(outside, 'target.yaml'), path);
    expect(writeSidecar(path, 'evil\n')).toBe(false);
    expect(readFileSync(join(outside, 'target.yaml'), 'utf-8')).toBe('x\n');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it('refuses a dangling symlink too, creating nothing where it points', () => {
    const { root, outside } = project();
    const path = join(root, 'a.yaml.upgrade-backup');
    symlinkSync(join(outside, 'created-by-the-link'), path);
    expect(writeSidecar(path, 'evil\n')).toBe(false);
    expect(existsSync(join(outside, 'created-by-the-link'))).toBe(false);
  });
});

describe('upgrade.js writes every sidecar through writeSidecar', () => {
  it('no .upgrade-backup or .upgrade-new is written any other way', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'upgrade.js'), 'utf8');
    const direct = src
      .split('\n')
      .filter((l) => /writeFileSync\([^)]*\.upgrade-(backup|new)/.test(l));
    expect(direct).toEqual([]);
    const via = src.match(/writeSidecar\(`\$\{projectFilePath\}\.upgrade-(backup|new)`/g) ?? [];
    expect(via.length).toBe(7);
  });
});
