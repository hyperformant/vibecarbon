/**
 * Cloud-init never pulls images (re-pins 7babb8e, cold-deploy-speed Task 4).
 *
 * A pre-pull in cloud-init was tried and reverted: unauthenticated pulls from
 * fresh datacenter IPs hit Docker Hub's per-IP limit and hold the cloud-init
 * marker, so a slow pull blocks the operator longer than paying the same cost
 * later. Stack pulls run from setup-server-files, after the registry logins.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('cloud-init never pre-pulls images (re-pins 7babb8e)', () => {
  const CLOUD_INIT = fileURLToPath(new URL('../../../carbon/cloud-init', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it('no file under carbon/cloud-init/ runs docker pull (shell or YAML-list form) outside a comment', () => {
    // Unauthenticated pulls from fresh datacenter IPs hit Docker Hub's per-IP
    // limit and hold the cloud-init marker; stack pulls run after the logins.
    const found = files(CLOUD_INIT).flatMap((f) =>
      readFileSync(f, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l) && /\bdocker\b[\s,'"]+pull\b/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(files(CLOUD_INIT).length, 'positive control: the walk read files').toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});
