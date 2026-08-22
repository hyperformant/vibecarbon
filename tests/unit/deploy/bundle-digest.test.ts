import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { digestDir, digestPaths } from '../../../src/lib/deploy/digest.js';
// @ts-expect-error — JS module without types
import { StateTracker } from '../../../src/lib/deploy/state.js';

// Regression coverage for the content-blind deploy-gate bug (2026-07-11): a
// config-only change to the rendered bundle / applied manifests left the coarse
// step inputs (imageRef, domain, service toggles / image tags) unchanged, so the
// setup-files / k3s-apply gate wrongly skipped and the change never shipped.
// digestDir gives those gates a content signal.

describe('digestDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-digest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBundle(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  it('is deterministic for identical content', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeBundle(a, { 'docker-compose.yml': 'x', 'volumes/db/init.sh': 'y' });
    writeBundle(b, { 'docker-compose.yml': 'x', 'volumes/db/init.sh': 'y' });
    expect(digestDir(a)).toBe(digestDir(b));
  });

  it('changes when a file’s content changes', () => {
    const a = join(dir, 'a');
    writeBundle(a, { 'docker-compose.observability.yml': 'anon=true' });
    const before = digestDir(a);
    writeFileSync(join(a, 'docker-compose.observability.yml'), 'anon=false');
    expect(digestDir(a)).not.toBe(before);
  });

  it('changes when a file is added or removed', () => {
    const a = join(dir, 'a');
    writeBundle(a, { '.env': 'A=1' });
    const before = digestDir(a);
    writeFileSync(join(a, 'reconcile.sh'), '#!/bin/sh');
    expect(digestDir(a)).not.toBe(before);
  });

  it('is independent of file creation order', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeBundle(a, { 'z.yml': '1', 'a.yml': '2', 'nested/m.yml': '3' });
    writeBundle(b, { 'nested/m.yml': '3', 'a.yml': '2', 'z.yml': '1' });
    expect(digestDir(a)).toBe(digestDir(b));
  });

  it('distinguishes path layout from content (no NUL collisions)', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    // Same bytes, different path boundaries — must not collide.
    writeBundle(a, { ab: 'c' });
    writeBundle(b, { a: 'bc' });
    expect(digestDir(a)).not.toBe(digestDir(b));
  });

  // A dev clone can pick up OS/VCS junk that `npm pack` strips from the
  // published package, so the same manifests would digest differently on a
  // laptop and from an installed CLI — a one-time false bust of the gate.
  it('ignores OS/VCS junk that npm pack strips', () => {
    const a = join(dir, 'a');
    writeBundle(a, { 'base/deployment.yaml': 'spec: {}' });
    const before = digestDir(a);

    writeBundle(a, {
      '.DS_Store': 'finder-junk',
      'base/._deployment.yaml': 'appledouble',
      'base/deployment.yaml.swp': 'vim',
      '.git/HEAD': 'ref: refs/heads/main',
      'node_modules/pkg/index.js': 'module.exports = 1',
    });

    expect(digestDir(a)).toBe(before);
  });

  // Explicitly NOT "all dotfiles": the compose bundle digested by the
  // setup-files gate contains `.env`, and an env change is exactly what must
  // force a re-upload.
  it('still digests .env — a dotfile whose content MUST bust the gate', () => {
    const a = join(dir, 'a');
    writeBundle(a, { '.env': 'A=1', 'docker-compose.yml': 'x' });
    const before = digestDir(a);
    writeFileSync(join(a, '.env'), 'A=2');
    expect(digestDir(a)).not.toBe(before);
  });

  it('returns a stable digest for a missing directory without throwing', () => {
    const missing = join(dir, 'does-not-exist');
    expect(() => digestDir(missing)).not.toThrow();
    expect(digestDir(missing)).toBe(digestDir(join(dir, 'also-missing')));
  });
});

// digestPaths is digestDir's counterpart for gates whose step consumes a
// hand-picked SUBSET of a tree — the k3s-build gate watches the app image's
// build context (Dockerfile COPY sources), never the whole project dir, which
// would fold in the deploy's own `.vibecarbon/` state file.
describe('digestPaths', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-digest-paths-'));
    mkdirSync(join(dir, 'src', 'server'), { recursive: true });
    writeFileSync(join(dir, 'src', 'server', 'index.ts'), 'v1');
    writeFileSync(join(dir, 'package.json'), '{}');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('covers both files and directories', () => {
    const before = digestPaths(dir, ['package.json', 'src']);
    writeFileSync(join(dir, 'src', 'server', 'index.ts'), 'v2');
    expect(digestPaths(dir, ['package.json', 'src'])).not.toBe(before);

    const afterDirEdit = digestPaths(dir, ['package.json', 'src']);
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    expect(digestPaths(dir, ['package.json', 'src'])).not.toBe(afterDirEdit);
  });

  it('ignores anything not in the list', () => {
    const before = digestPaths(dir, ['package.json', 'src']);
    mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
    writeFileSync(join(dir, '.vibecarbon', 'deploy-state-prod.json'), '{"steps":{}}');
    expect(digestPaths(dir, ['package.json', 'src'])).toBe(before);
  });

  it('is independent of list order and duplicates', () => {
    expect(digestPaths(dir, ['src', 'package.json'])).toBe(
      digestPaths(dir, ['package.json', 'src', 'package.json']),
    );
  });

  it('treats a missing path as a stable absence, and notices it appearing', () => {
    const before = digestPaths(dir, ['package.json', 'Dockerfile']);
    expect(digestPaths(dir, ['package.json', 'Dockerfile'])).toBe(before);
    writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n');
    expect(digestPaths(dir, ['package.json', 'Dockerfile'])).not.toBe(before);
  });

  it('does not collide an empty directory with an empty file', () => {
    mkdirSync(join(dir, 'as-dir'), { recursive: true });
    writeFileSync(join(dir, 'as-file'), '');
    expect(digestPaths(dir, ['as-dir'])).not.toBe(digestPaths(dir, ['as-file']));
  });
});

describe('setup-files gate is content-aware via bundleDigest', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-gate-'));
    // StateTracker keys its state file off process.cwd()/.vibecarbon.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-runs when only the bundle content (digest) changed', () => {
    const bundle = join(dir, 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'docker-compose.observability.yml'), 'v1');

    const coarse = {
      serverIp: '1.2.3.4',
      projectName: 'proj',
      imageRef: 'ghcr.io/o/r:main',
      domain: 'app.example.com',
      services: { observability: true },
    };

    const t1 = new StateTracker('proj', 'prod');
    const inputs1 = { ...coarse, bundleDigest: digestDir(bundle) };
    t1.startStep('compose-setup-files', inputs1);
    t1.completeStep('compose-setup-files', { serverIp: coarse.serverIp });

    // Same coarse inputs, but the bundle file changed (imageRef/domain/services
    // all identical) — the gate must NOT skip.
    writeFileSync(join(bundle, 'docker-compose.observability.yml'), 'v2');
    const t2 = new StateTracker('proj', 'prod');
    const inputs2 = { ...coarse, bundleDigest: digestDir(bundle) };
    expect(t2.shouldSkip('compose-setup-files', inputs2)).toBe(false);

    // Unchanged bundle + unchanged coarse inputs still skips (no needless re-upload).
    const t3 = new StateTracker('proj', 'prod');
    t3.startStep('compose-setup-files', inputs2);
    t3.completeStep('compose-setup-files', { serverIp: coarse.serverIp });
    const t4 = new StateTracker('proj', 'prod');
    expect(
      t4.shouldSkip('compose-setup-files', { ...coarse, bundleDigest: digestDir(bundle) }),
    ).toBe(true);
  });
});
