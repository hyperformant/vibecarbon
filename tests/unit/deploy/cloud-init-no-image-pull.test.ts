/**
 * Cloud-init pulls images in one place only: the compose boot pull.
 *
 * A pre-pull in cloud-init was tried and reverted in 7babb8e: unauthenticated
 * pulls from fresh datacenter IPs hit Docker Hub's per-IP limit and held the
 * cloud-init marker. The boot pull that replaced it (approved 2026-11-01)
 * avoids both causes, and this census pins that it keeps avoiding them:
 *   - it lives only in boot-pull.sh in docker-ce-setup.yaml, never in a k3s
 *     script or a runcmd line;
 *   - runcmd starts it detached (setsid nohup ... &), so it never holds the
 *     ready marker;
 *   - its refs are filled from bootPullImages() (src/lib/iac/compose-cloud-init.js):
 *     the ghcr mirror and the repo's own db image, never Docker Hub.
 * Order against the Docker restart: tests/unit/iac/compose-boot-pull.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bootPullImages } from '../../../src/lib/iac/compose-cloud-init.js';

describe('cloud-init pulls images only through the detached compose boot pull', () => {
  const CLOUD_INIT = fileURLToPath(new URL('../../../carbon/cloud-init', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const pullLines = () =>
    files(CLOUD_INIT).flatMap((f) =>
      readFileSync(f, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l) && /\bdocker\b[\s,'"]+pull\b/.test(l))
        .map((l) => ({ file: f, line: l.trim() })),
    );

  it('the only docker pull is boot-pull.sh’s loop, in docker-ce-setup.yaml', () => {
    expect(files(CLOUD_INIT).length, 'positive control: the walk read files').toBeGreaterThan(0);
    expect(pullLines().map((p) => `${p.file.split('/').pop()}: ${p.line}`)).toEqual([
      'docker-ce-setup.yaml: docker pull -q "$ref" >> "$out/log" 2>&1 &',
    ]);
  });

  it('runcmd starts it detached, so it never holds the ready marker', () => {
    const yaml = readFileSync(join(CLOUD_INIT, 'docker-ce-setup.yaml'), 'utf-8');
    const runcmd = yaml.slice(yaml.indexOf('\nruncmd:\n'));
    const starts = runcmd.split('\n').filter((l) => l.includes('boot-pull.sh'));
    expect(starts).toEqual([
      "  - [sh, -c, 'setsid nohup /usr/local/lib/vibecarbon/boot-pull.sh > /dev/null 2>&1 < /dev/null &']",
    ]);
  });

  it('pulls only from the ghcr mirror and the repo’s own images, never Docker Hub', () => {
    for (const ref of bootPullImages()) expect(ref).toMatch(/^ghcr\.io\/hyperformant\//);
  });
});
