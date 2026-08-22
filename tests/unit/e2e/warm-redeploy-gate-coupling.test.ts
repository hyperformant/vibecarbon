import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import {
  APP_BUILD_CONTEXT_PATHS,
  buildK3sApplyInputs,
  buildK3sBuildInputs,
  // @ts-expect-error — JS module without types
} from '../../../src/lib/deploy/k8s/k3s.js';
import {
  mutateAppHealthRoute,
  mutateConfigMapManifest,
  WARM_REDEPLOY_APP_FILE,
  WARM_REDEPLOY_MANIFEST_FILE,
} from '../../e2e/utils/warm-redeploy-mutations.js';

/**
 * The `warm-redeploy-change` e2e step rests on a PREMISE: that the two files it
 * edits are inside the two step gates' digest inputs. If that premise ever
 * stops holding, the step fails 40 minutes into a real-infra run with a message
 * about stale images, and someone burns an afternoon before noticing the gate
 * simply stopped watching the path.
 *
 * So the premise is pinned here, in the unit tier, against the REAL gate
 * builders:
 *
 *   - the manifest edit must bust `buildK3sApplyInputs().manifestDigest` (#202)
 *   - the app edit must bust `buildK3sBuildInputs().sourceDigest` (#244)
 *
 * This is the static counterpart of the e2e assertion, and the two are
 * deliberately complementary: these tests prove the gate SEES the change, the
 * e2e step proves the change actually reaches a cluster. Neither implies the
 * other — #202 and #244 were both cases where a gate input existed on paper
 * (imageTag, restore, domain) while the thing a customer changed went unwatched.
 */

const REPO_ROOT = process.cwd();

/** Minimal project tree: only what the two gate builders read. */
function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-warm-coupling-'));
  // The manifest half — a real copy of the template the CLI lays down.
  const manifestDest = join(dir, WARM_REDEPLOY_MANIFEST_FILE);
  mkdirSync(dirname(manifestDest), { recursive: true });
  writeFileSync(
    manifestDest,
    readFileSync(join(REPO_ROOT, 'carbon', WARM_REDEPLOY_MANIFEST_FILE), 'utf-8'),
  );
  // The app half — plus the Dockerfile digestAppSource parses for COPY sources.
  const appDest = join(dir, WARM_REDEPLOY_APP_FILE);
  mkdirSync(dirname(appDest), { recursive: true });
  writeFileSync(appDest, readFileSync(join(REPO_ROOT, 'carbon', WARM_REDEPLOY_APP_FILE), 'utf-8'));
  writeFileSync(
    join(dir, 'Dockerfile'),
    readFileSync(join(REPO_ROOT, 'carbon/Dockerfile'), 'utf-8'),
  );
  writeFileSync(join(dir, '.env.local'), 'VITE_SUPABASE_URL=https://example.test\n');
  return dir;
}

describe('warm-redeploy-change premise: the mutated files are inside the gate digests', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = buildFixture();
    // StateTracker (reached through the gate builders) keys off process.cwd().
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const applyInputs = () =>
    buildK3sApplyInputs({
      imageTag: 'reg:5000/app:abc123',
      dbImageTag: 'ghcr.io/o/db:v1',
      restore: undefined,
      projectDir: dir,
    });

  const buildInputs = () =>
    buildK3sBuildInputs({
      projectName: 'proj',
      domain: 'example.test',
      masterPrivateIp: '10.0.1.1',
      projectDir: dir,
    });

  it('the manifest mutation busts k3s-apply manifestDigest (#202 coverage)', () => {
    const before = applyInputs().manifestDigest;
    const path = join(dir, WARM_REDEPLOY_MANIFEST_FILE);
    writeFileSync(path, mutateConfigMapManifest(readFileSync(path, 'utf-8'), 'e2e-warm-abc'));
    expect(applyInputs().manifestDigest).not.toBe(before);
  });

  it('the app mutation busts k3s-build sourceDigest (#244 coverage)', () => {
    const before = buildInputs().sourceDigest;
    const path = join(dir, WARM_REDEPLOY_APP_FILE);
    writeFileSync(path, mutateAppHealthRoute(readFileSync(path, 'utf-8'), 'e2e-warm-abc'));
    expect(buildInputs().sourceDigest).not.toBe(before);
  });

  it('the two mutations bust DIFFERENT gates — neither half is redundant', () => {
    // The step asserts both because either gate can regress alone. If a single
    // edit busted both, one of the two assertions would be dead weight.
    const applyBefore = applyInputs().manifestDigest;
    const buildBefore = buildInputs().sourceDigest;

    const manifestPath = join(dir, WARM_REDEPLOY_MANIFEST_FILE);
    writeFileSync(
      manifestPath,
      mutateConfigMapManifest(readFileSync(manifestPath, 'utf-8'), 'e2e-warm-abc'),
    );
    expect(applyInputs().manifestDigest).not.toBe(applyBefore);
    // `k8s/` is not part of the app build context, so the manifest edit alone
    // must NOT bust the build gate.
    expect(buildInputs().sourceDigest).toBe(buildBefore);

    const appPath = join(dir, WARM_REDEPLOY_APP_FILE);
    writeFileSync(appPath, mutateAppHealthRoute(readFileSync(appPath, 'utf-8'), 'e2e-warm-abc'));
    expect(buildInputs().sourceDigest).not.toBe(buildBefore);
  });

  it('`src` is still in the build context baseline the app assertion relies on', () => {
    // The e2e failure message tells the reader to check exactly this.
    expect([...APP_BUILD_CONTEXT_PATHS]).toContain('src');
    expect(WARM_REDEPLOY_APP_FILE.startsWith('src/')).toBe(true);
  });

  it('the project Dockerfile still COPYs the tree the app assertion edits', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'carbon/Dockerfile'), 'utf-8');
    expect(dockerfile).toMatch(/^COPY\s+src\/\s/m);
  });
});
