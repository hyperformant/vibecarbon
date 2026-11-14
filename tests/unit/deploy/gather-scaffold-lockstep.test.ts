/**
 * deploy's template lockstep runs inside gatherDeploymentConfig, on the tier
 * resolveDeployMode just returned, before the region, DNS, server-type and
 * S3 prompts, the live credential checks and the `.env.local` save (B9).
 *
 * Drives the real gather with the real preflight check, in a copy of the
 * shipped scaffold (current) and one whose walg-env.sh predates the role file.
 * Harness as in compose-default-size.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';
import { copyTemplate } from '../helpers/copy-template.js';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  password: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => ({
    projectName: 'lockapp',
    bucketSalt: 'abc123',
    environments: { prod: {} },
  }),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', () => ({
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
// The real assertScaffoldSupportsRoleFile, wrapped in a spy so the test can
// read the tier it was called with; only the operator-credential gate (its
// own tests) is inert.
const roleFile = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => {
  const real = (await orig()) as Record<string, (...a: unknown[]) => unknown>;
  roleFile.mockImplementation(real.assertScaffoldSupportsRoleFile);
  return { ...real, assertOperatorConfig: vi.fn(), assertScaffoldSupportsRoleFile: roleFile };
});
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));

import { gatherDeploymentConfig } from '../../../src/lib/deploy/prompts.js';
import { WALG_ROLE_PARSE_SH } from '../../../src/lib/deploy/walg-role.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

const REFUSAL =
  "This project's scaffold predates the wal-g role file. Run `vibecarbon upgrade`, then deploy again.";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function project(stale: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-gather-scaffold-'));
  dirs.push(dir);
  copyTemplate(dir);
  if (stale) {
    const env = join(dir, 'volumes/db/walg-env.sh');
    writeFileSync(env, readFileSync(env, 'utf-8').replace(WALG_ROLE_PARSE_SH, ''));
  }
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

let restoreCatalog: () => void;
const later = {
  apiToken: vi.fn(),
  fetchTypes: vi.fn(),
  s3Keys: vi.fn(),
};
beforeEach(() => {
  vi.spyOn(console, 'clear').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(HetznerProvider, 'promptApiToken').mockImplementation(async () => {
    later.apiToken();
    return 'a'.repeat(64);
  });
  vi.spyOn(HetznerProvider, 'fetchServerTypes').mockImplementation(async () => {
    later.fetchTypes();
    return undefined as never;
  });
  vi.spyOn(HetznerProvider, 'promptObjectStorageCredentials').mockImplementation(async () => {
    later.s3Keys();
    return { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40), source: 'prompt' };
  });
  // The keys check right after the S3 prompt would ask the real bucket host.
  vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
    valid: true,
  });
  restoreCatalog = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
});
afterEach(() => {
  restoreCatalog();
  vi.restoreAllMocks();
  for (const fn of Object.values(later)) fn.mockClear();
  for (const fn of [clackMock.select, clackMock.text, clackMock.password, roleFile]) fn.mockClear();
  clackMock.log.error.mockClear();
});

const errorLines = () => clackMock.log.error.mock.calls.map(([m]) => String(m));

describe('deploy: gatherDeploymentConfig refuses a scaffold that predates the wal-g role file', () => {
  it.each([
    ['compose', { compose: true }],
    ['k8s-ha', { k8s: true, ha: true }],
  ])('%s: refuses right after the tier is known, before any later prompt', async (tier, mode) => {
    project(true);
    const err = await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      yes: true,
      region: 'nbg1',
      ...mode,
    }).catch((e) => e);
    expect(String(err)).toMatch(/exit 1/);
    expect(errorLines()).toEqual([REFUSAL]);
    // The tier was resolved and the check ran on it ...
    expect(roleFile).toHaveBeenCalledTimes(1);
    expect(roleFile.mock.calls[0][1]).toBe(tier);
    // ... and nothing after it: no token, catalog, S3 key, select or text prompt.
    for (const [name, fn] of Object.entries(later)) {
      expect(fn, `${name} ran before the refusal`).not.toHaveBeenCalled();
    }
    expect(clackMock.select).not.toHaveBeenCalled();
    expect(clackMock.text).not.toHaveBeenCalled();
    expect(clackMock.password).not.toHaveBeenCalled();
  });

  it('a current scaffold passes and the wizard goes on to the provider prompts', async () => {
    project(false);
    await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      yes: true,
      region: 'nbg1',
      compose: true,
    }).catch(() => {});
    expect(errorLines()).not.toContain(REFUSAL);
    expect(later.apiToken.mock.calls.length + later.fetchTypes.mock.calls.length).toBeGreaterThan(
      0,
    );
  });
});
