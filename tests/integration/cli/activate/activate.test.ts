/**
 * vibecarbon activate — binds a project-less key to THIS project on
 * vibecarbon.com, and writes .vibecarbon.license only when that bind
 * succeeds. There is no offline activate: a refusal or an unreachable server
 * leaves the project exactly as it was.
 *
 * Cases that need a genuinely signed key are `skipIf`'d on the Ed25519
 * signing key, because the CLI verifies against the public key compiled into
 * src/lib/licensing/validator.js and no env var or option may override it
 * (tests/unit/licensing/no-dev-bypass.test.ts). The licence stub mints and
 * signs with the same private key, so where the key is present the CLI walks
 * its production path end to end.
 *
 * Note the ordering inside activateLicense(): the signature is verified
 * BEFORE the manifest is read and before any request is made. Every case that
 * asserts a post-verification outcome ("No project here", a 409, an
 * unreachable server) therefore needs a real signature to reach it at all,
 * and is skipped without one.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROJECT_ID = '99999999-8888-4777-8666-555555555555';
/** Far enough out that no grace-period arithmetic can colour these cases. */
const PERIOD_END = '2099-01-01';

/** A key that parses cleanly but carries a signature of 128 zeroes. */
const UNSIGNED_KEY = `vc-cafebabecafebabe-${'0'.repeat(128)}`;

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

describe('vibecarbon activate', () => {
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
    // One stub serves the whole file; each case gets a clean view of it.
    stub?.calls.splice(0, stub.calls.length);
    stub?.state.clear();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', async () => {
    const r = await runCliAsync('activate', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Bind a Vibecarbon license key');
    const out = `${r.stdout}\n${r.stderr}`;
    // The v2 key format and the refresh flag are both gone: a key names no
    // project and no plan, so there is nothing local left to refresh.
    expect(out).not.toContain('vc2');
    expect(out).not.toContain('-refresh');
  });

  it.skipIf(!signingKey)(
    'binds a genuinely signed key and writes .vibecarbon.license',
    async () => {
      const s = stub as LicenseStub;
      const { key, licenseId } = s.mintKey();
      s.seed({
        licenseId,
        projectId: null,
        tier: 'fullerene',
        status: 'active',
        periodEndYmd: PERIOD_END,
      });

      const r = await runCliAsync('activate', [key], {
        cwd: project,
        apiBase: s.baseUrl,
        timeoutMs: 30_000,
      });

      assertExitWith(r, 0);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('Welcome to Fullerene');
      expect(out).toContain(`Project: ${PROJECT_ID}`);

      const stored = JSON.parse(readFileSync(licenseFile, 'utf-8'));
      expect(stored.key).toBe(key);
      // The binding itself lives on the server, never in the file.
      expect(s.state.get(licenseId)?.projectId).toBe(PROJECT_ID);
    },
  );

  it('refuses a well-formed key with no valid signature before any request', async () => {
    // This is the case that used to SUCCEED: a well-formed key carrying a
    // made-up signature parsed cleanly and VIBECARBON_DEV_LICENSE=true waved
    // it through without verifying anything. Activation must demand a real
    // Ed25519 signature, and must decide that locally: a forged key never
    // reaches the network.
    const r = await runCliAsync('activate', [UNSIGNED_KEY], {
      cwd: project,
      apiBase: stub?.baseUrl,
      timeoutMs: 30_000,
    });

    expect(r.exitCode).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain('Error: Invalid license signature');
    // Vacuous without a signing key (there is no stub to record against);
    // the real assertion with one.
    expect(stub?.calls ?? []).toHaveLength(0);
    expect(existsSync(licenseFile)).toBe(false);
  });

  it.skipIf(!signingKey)('refuses outside a project', async () => {
    const s = stub as LicenseStub;
    // Signed, so the key itself can never be the reason for the refusal.
    const { key } = s.mintKey();
    const outside = mkdtempSync(join(tmpdir(), 'vc-activate-no-project-'));
    try {
      const r = await runCliAsync('activate', [key], {
        cwd: outside,
        apiBase: s.baseUrl,
        timeoutMs: 30_000,
      });

      expect(r.exitCode).toBe(1);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('No project here.');
      expect(out).toContain('vibecarbon create');
      // Nothing to bind to, so nothing was asked of vibecarbon.com.
      expect(s.calls).toHaveLength(0);
      expect(existsSync(join(outside, '.vibecarbon.license'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(!signingKey)(
    'a key bound to another project refuses with the deactivate hint and writes nothing',
    async () => {
      const s = stub as LicenseStub;
      const { key, licenseId } = s.mintKey();
      s.seed({
        licenseId,
        projectId: OTHER_PROJECT_ID,
        tier: 'fullerene',
        status: 'active',
        periodEndYmd: PERIOD_END,
      });

      const r = await runCliAsync('activate', [key], {
        cwd: project,
        apiBase: s.baseUrl,
        timeoutMs: 30_000,
      });

      expect(r.exitCode).toBe(1);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('Error: This key is already bound to another project.');
      expect(out).toContain('Run vibecarbon deactivate in that project');
      expect(existsSync(licenseFile)).toBe(false);
      // A refused bind must not have moved the binding.
      expect(s.state.get(licenseId)?.projectId).toBe(OTHER_PROJECT_ID);
    },
  );

  it.skipIf(!signingKey)('an unreachable vibecarbon.com exits 1 and writes nothing', async () => {
    const { key } = (stub as LicenseStub).mintKey();

    const r = await runCliAsync('activate', [key], {
      cwd: project,
      apiBase: UNREACHABLE_API,
      timeoutMs: 30_000,
    });

    expect(r.exitCode).toBe(1);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain('Activation needs a connection to vibecarbon.com');
    expect(out).toContain('Nothing was changed.');
    expect(existsSync(licenseFile)).toBe(false);
  });

  it('rejects a malformed key', async () => {
    const r = await runCliAsync('activate', ['totally-not-a-key'], {
      cwd: project,
      apiBase: stub?.baseUrl,
      timeoutMs: 30_000,
    });

    expect(r.exitCode).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain('Error: Invalid license key prefix');
    expect(stub?.calls ?? []).toHaveLength(0);
    expect(existsSync(licenseFile)).toBe(false);
  });
});
