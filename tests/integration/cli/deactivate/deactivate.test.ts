/**
 * vibecarbon deactivate — asks vibecarbon.com to email the buyer a release
 * link, and leaves .vibecarbon.license alone. `-rm` is the local-only escape
 * hatch: it removes the file and sends nothing.
 *
 * The key is committed to the repository, so possession of it must never be
 * enough to move the subscription: nothing is released until the emailed link
 * is clicked. The stub stands in for that click by releasing immediately.
 *
 * Cases needing a genuinely signed key are `skipIf`'d — the stub verifies
 * every inbound key against the same public key the CLI trusts, so an
 * unsigned key would be refused by the stub rather than exercising the flow.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCliAsync,
  signingKeyOrNull,
  startLicenseStub,
} from '../../_harness/index.js';

/** A port nothing listens on: the CLI's "cannot reach vibecarbon.com" path. */
const UNREACHABLE_API = 'http://127.0.0.1:9';

const RELEASE_PATH = '/api/v1/license/release';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const PERIOD_END = '2099-01-01';

/** Parses cleanly, verifies against nothing. Enough for the paths that never
 *  reach the server, or that fail before it answers. */
const UNSIGNED_KEY = `vc-deadbeefdeadbeef-${'0'.repeat(128)}`;

const signingKey = signingKeyOrNull();
type LicenseStub = Awaited<ReturnType<typeof startLicenseStub>>;

/** A real `vibecarbon create` tree whose manifest carries a known project id. */
function projectWithId(id: string): string {
  const dir = realProject();
  const manifestPath = join(dir, '.vibecarbon.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  manifest.projectId = id;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

describe('vibecarbon deactivate', () => {
  let stub: LicenseStub | null = null;
  let project: string;
  let licenseFile: string;

  beforeAll(async () => {
    if (signingKey) stub = await startLicenseStub({ privateKeyPem: signingKey });
  });
  afterAll(async () => {
    await stub?.close();
  });

  beforeEach(() => {
    project = projectWithId(PROJECT_ID);
    licenseFile = join(project, '.vibecarbon.license');
    stub?.calls.splice(0, stub.calls.length);
    stub?.state.clear();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  /** The shape `activate` writes: the key, and nothing that could drift from it. */
  function storeLicense(key: string): void {
    writeFileSync(
      licenseFile,
      `${JSON.stringify(
        { key, activatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' },
        null,
        2,
      )}\n`,
    );
  }

  function releaseCalls() {
    return (stub?.calls ?? []).filter((call: { path: string }) => call.path === RELEASE_PATH);
  }

  it('prints help', async () => {
    const r = await runCliAsync('deactivate', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Release the license key from this project');
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain('-rm');
    // -all removed both a project file and a legacy HOME file. There is only
    // one storage slot now, so the flag has nothing left to mean.
    expect(out).not.toContain('-all');
  });

  it.skipIf(!signingKey)(
    '-y with a stored key requests a release and leaves the file',
    async () => {
      const s = stub as LicenseStub;
      const { key, licenseId } = s.mintKey();
      s.seed({
        licenseId,
        projectId: PROJECT_ID,
        tier: 'fullerene',
        status: 'active',
        periodEndYmd: PERIOD_END,
      });
      storeLicense(key);

      const r = await runCliAsync('deactivate', ['-y'], {
        cwd: project,
        apiBase: s.baseUrl,
        timeoutMs: 30_000,
      });

      assertExitWith(r, 0);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('Check your email');
      expect(releaseCalls()).toHaveLength(1);
      // The file stays: a released key is harmless on disk, and removing it
      // before the buyer clicks would strand a project whose link never is.
      expect(existsSync(licenseFile)).toBe(true);
      expect(JSON.parse(readFileSync(licenseFile, 'utf-8')).key).toBe(key);
    },
  );

  it.skipIf(!signingKey)('a positional key works with no .vibecarbon.license here', async () => {
    const s = stub as LicenseStub;
    const { key, licenseId } = s.mintKey();
    s.seed({
      licenseId,
      projectId: PROJECT_ID,
      tier: 'fullerene',
      status: 'active',
      periodEndYmd: PERIOD_END,
    });
    expect(existsSync(licenseFile)).toBe(false);

    const r = await runCliAsync('deactivate', [key, '-y'], {
      cwd: project,
      apiBase: s.baseUrl,
      timeoutMs: 30_000,
    });

    assertExitWith(r, 0);
    expect(`${r.stdout}\n${r.stderr}`).toContain('Check your email');
    expect(releaseCalls()).toHaveLength(1);
    // Nothing was here to remove, and nothing was written.
    expect(existsSync(licenseFile)).toBe(false);
  });

  it('-rm -y removes the file and makes no request', async () => {
    storeLicense(UNSIGNED_KEY);

    const r = await runCliAsync('deactivate', ['-rm', '-y'], {
      cwd: project,
      apiBase: stub?.baseUrl,
      timeoutMs: 30_000,
    });

    assertExitWith(r, 0);
    expect(`${r.stdout}\n${r.stderr}`).toContain('Removed .vibecarbon.license.');
    expect(existsSync(licenseFile)).toBe(false);
    // -rm is the local-only path: the key stays bound on vibecarbon.com.
    // Vacuous without a signing key; the real assertion with one.
    expect(stub?.calls ?? []).toHaveLength(0);
  });

  it('an unreachable vibecarbon.com exits 1 and leaves the file intact', async () => {
    storeLicense(UNSIGNED_KEY);
    const before = readFileSync(licenseFile, 'utf-8');

    const r = await runCliAsync('deactivate', ['-y'], {
      cwd: project,
      apiBase: UNREACHABLE_API,
      timeoutMs: 30_000,
    });

    expect(r.exitCode).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain('Could not reach vibecarbon.com');
    expect(existsSync(licenseFile)).toBe(true);
    expect(readFileSync(licenseFile, 'utf-8')).toBe(before);
  });

  it('-all is an unknown flag', async () => {
    storeLicense(UNSIGNED_KEY);

    const r = await runCliAsync('deactivate', ['-y', '-all'], { cwd: project, timeoutMs: 30_000 });

    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/unknown flag: -all/i);
    expect(existsSync(licenseFile)).toBe(true);
  });
});
