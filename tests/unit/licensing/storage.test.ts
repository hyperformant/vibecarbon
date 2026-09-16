/**
 * License storage: ONE slot, `<projectDir>/.vibecarbon.license`, holding a
 * project-less key. Which project the key is bound to lives on
 * vibecarbon.com, so `activate` is an online operation (validate locally,
 * POST /bind, only then write) and `deactivate` only asks for a release
 * email — it never deletes the file.
 *
 * The valid cases sign a genuine key against an ephemeral Ed25519 pair,
 * injected via `publicKeyPem`. Only `key` is cryptographically checked; the
 * file's other fields are display data and are never trusted.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  hasStoredLicense,
  licensePath,
  removeLicenseFile,
} from '../../../src/lib/licensing/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const LICENSE_ID = '0123456789abcdef';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `vc-${LICENSE_ID}-${sign(null, Buffer.from(LICENSE_ID), privateKey).toString('hex')}`;
const env = { VIBECARBON_API_BASE: 'http://stub.test' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-license-'));
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({ version: '1', projectName: 'p', projectId: PROJECT_ID }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BIND_OK = {
  projectId: PROJECT_ID,
  tier: 'graphene',
  status: 'active',
  periodEnd: '2026-10-15T00:00:00.000Z',
};
// bind.js reads the body with res.text() and JSON.parses it, so the mock must return real JSON there.
const okBind = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => BIND_OK,
  text: async () => JSON.stringify(BIND_OK),
})) as unknown as typeof fetch;

const MODULE_URL = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/lib/licensing/index.js'),
).href;

/**
 * Load the licensing module in a CHILD node process under a fake HOME and
 * report what getLicense() makes of `projectDir`, plus the homedir() that
 * child actually saw.
 *
 * It has to be a child. Swapping `process.env.HOME` in-process does not
 * work here: tests/setup/global-setup.ts's afterEach does
 * `process.env = { ...originalEnv }`, which replaces Node's magic env object
 * with a plain one, after which assigning HOME no longer reaches the real
 * environment that os.homedir() reads. A HOME swap in this worker would
 * silently do nothing and the test would pass no matter what the code did —
 * which is exactly the hole this test exists to close.
 */
function probeUnderHome(home: string, projectDir: string, pubPath: string) {
  const script = `
    import { homedir } from 'node:os';
    import { readFileSync } from 'node:fs';
    import { getLicense } from ${JSON.stringify(MODULE_URL)};
    const [projectDir, pubPath] = process.argv.slice(1);
    const license = getLicense({ projectDir, publicKeyPem: readFileSync(pubPath, 'utf8') });
    console.log(JSON.stringify({ home: homedir(), active: license.active }));
  `;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, projectDir, pubPath],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
  return JSON.parse(out) as { home: string; active: boolean };
}

describe('getLicense', () => {
  it('is inactive with no file', () => {
    expect(getLicense({ projectDir: dir, publicKeyPem: PUB })).toMatchObject({
      active: false,
      tier: 'graphite',
      licenseId: null,
    });
  });
  it('is active for a verifying key and exposes key + licenseId, never a tier', () => {
    writeFileSync(
      licensePath(dir),
      JSON.stringify({ key: KEY, activatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' }),
    );
    const l = getLicense({ projectDir: dir, publicKeyPem: PUB });
    expect(l).toMatchObject({
      active: true,
      tier: null,
      key: KEY,
      licenseId: LICENSE_ID,
      storedAt: licensePath(dir),
    });
  });
  it('ignores a file whose key does not verify, and a corrupt file', () => {
    writeFileSync(
      licensePath(dir),
      JSON.stringify({ key: KEY.replace(LICENSE_ID, 'fedcba9876543210') }),
    );
    expect(getLicense({ projectDir: dir, publicKeyPem: PUB }).active).toBe(false);
    writeFileSync(licensePath(dir), '{not json');
    expect(getLicense({ projectDir: dir, publicKeyPem: PUB }).active).toBe(false);
  });
  it('never reads ~/.vibecarbon/license, and does read the project file', () => {
    // The legacy slot was `~/.vibecarbon/license`, and its path was a
    // MODULE-LEVEL constant computed from homedir() at import time. So the
    // decoy has to sit at that exact path, and the module has to be loaded
    // fresh with HOME already pointing at this fake home.
    const home = mkdtempSync(join(tmpdir(), 'vc-home-'));
    mkdirSync(join(home, '.vibecarbon'), { recursive: true });
    writeFileSync(join(home, '.vibecarbon', 'license'), JSON.stringify({ key: KEY }));
    const pubPath = join(home, 'public.pem');
    writeFileSync(pubPath, PUB);
    try {
      const decoyOnly = probeUnderHome(home, dir, pubPath);
      // The swap took: without this the two assertions below would be
      // measuring the real home directory and could never fail.
      expect(decoyOnly.home).toBe(home);
      expect(decoyOnly.active).toBe(false);

      // Positive control under the SAME fake home: the identical key in the
      // project file IS honoured, so the refusal above is isolation from the
      // legacy slot, not a fixture key that stopped verifying.
      writeFileSync(licensePath(dir), JSON.stringify({ key: KEY }));
      expect(probeUnderHome(home, dir, pubPath).active).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('activateLicense', () => {
  it('validates locally, binds remotely, then writes the file', async () => {
    const r = await activateLicense(KEY, {
      projectDir: dir,
      publicKeyPem: PUB,
      env,
      fetchImpl: okBind,
    });
    expect(r).toMatchObject({
      success: true,
      projectId: PROJECT_ID,
      tier: 'graphene',
      status: 'active',
      path: licensePath(dir),
    });
    const stored = JSON.parse(readFileSync(licensePath(dir), 'utf8'));
    expect(stored.key).toBe(KEY);
    expect(stored.source).toBe('manual');
    const sent = JSON.parse(
      String((okBind as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]?.body),
    );
    expect(sent.projectId).toBe(PROJECT_ID);
  });
  it('refuses a malformed or unverifiable key before any network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      (await activateLicense('vc-nope', { projectDir: dir, publicKeyPem: PUB, env, fetchImpl }))
        .success,
    ).toBe(false);
    expect(
      (
        await activateLicense(`vc-deadbeefdeadbeef-${'a'.repeat(128)}`, {
          projectDir: dir,
          publicKeyPem: PUB,
          env,
          fetchImpl,
        })
      ).success,
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses outside a project', async () => {
    rmSync(join(dir, '.vibecarbon.json'));
    const r = await activateLicense(KEY, {
      projectDir: dir,
      publicKeyPem: PUB,
      env,
      fetchImpl: okBind,
    });
    expect(r).toMatchObject({ success: false, reason: 'no-project' });
    expect(r.error).toMatch(/vibecarbon create/);
  });
  it('refuses on a corrupt manifest, before any network call', async () => {
    // loadManifest() JSON.parses unguarded, so this is the throw
    // currentManifestProjectId()'s try/catch has to swallow: a broken
    // .vibecarbon.json must read as "no project here", never crash activate.
    writeFileSync(join(dir, '.vibecarbon.json'), '{not json');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await activateLicense(KEY, { projectDir: dir, publicKeyPem: PUB, env, fetchImpl });
    expect(r).toMatchObject({ success: false, reason: 'no-project' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('writes nothing when the server refuses or is unreachable', async () => {
    const refuse = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: 'bound_to_other_project' }),
    })) as unknown as typeof fetch;
    const r = await activateLicense(KEY, {
      projectDir: dir,
      publicKeyPem: PUB,
      env,
      fetchImpl: refuse,
    });
    expect(r).toMatchObject({ success: false, reason: 'bound_to_other_project' });
    expect(existsSync(licensePath(dir))).toBe(false);
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r2 = await activateLicense(KEY, {
      projectDir: dir,
      publicKeyPem: PUB,
      env,
      fetchImpl: down,
    });
    expect(r2).toMatchObject({ success: false, reason: 'unreachable' });
    expect(existsSync(licensePath(dir))).toBe(false);
  });
});

describe('deactivateLicense', () => {
  it('posts the stored key to /release and leaves the file in place', async () => {
    writeFileSync(licensePath(dir), JSON.stringify({ key: KEY }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sent: true }),
      text: async () => '{"sent":true}',
    })) as unknown as typeof fetch;
    const r = await deactivateLicense({ projectDir: dir, env, fetchImpl });
    expect(r).toEqual({ success: true, sent: true });
    expect(existsSync(licensePath(dir))).toBe(true);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'http://stub.test/api/v1/license/release',
    );
  });
  it('accepts an explicit key with no file (deleted-repo case)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sent: true }),
      text: async () => '{"sent":true}',
    })) as unknown as typeof fetch;
    expect((await deactivateLicense({ projectDir: dir, key: KEY, env, fetchImpl })).success).toBe(
      true,
    );
  });
  it('fails with no key anywhere', async () => {
    expect(
      await deactivateLicense({
        projectDir: dir,
        env,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).toMatchObject({ success: false, reason: 'no-key' });
  });
  it('reports unreachable without touching the file', async () => {
    writeFileSync(licensePath(dir), JSON.stringify({ key: KEY }));
    const down = vi.fn(async () => {
      throw new Error('x');
    }) as unknown as typeof fetch;
    expect(await deactivateLicense({ projectDir: dir, env, fetchImpl: down })).toMatchObject({
      success: false,
      reason: 'unreachable',
    });
    expect(existsSync(licensePath(dir))).toBe(true);
  });
});

describe('removeLicenseFile / hasStoredLicense', () => {
  it('removes the one file, idempotently', () => {
    writeFileSync(licensePath(dir), '{}');
    expect(hasStoredLicense({ projectDir: dir })).toBe(true);
    expect(removeLicenseFile({ projectDir: dir })).toEqual({
      success: true,
      removed: [licensePath(dir)],
    });
    expect(hasStoredLicense({ projectDir: dir })).toBe(false);
    expect(removeLicenseFile({ projectDir: dir })).toEqual({ success: true, removed: [] });
  });
});
