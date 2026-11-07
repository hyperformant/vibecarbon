/**
 * The e2e harness must trust Let's Encrypt STAGING certificates WITHOUT
 * disabling TLS verification.
 *
 * History: `tests/e2e/runner.ts` used to set
 * `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`, which turned verification
 * off for the entire process. Staging chains validated — and so did a
 * self-signed cert, an expired cert, and a cert for the wrong host. The suite
 * whose job includes noticing "this rig is serving the wrong certificate"
 * could not have noticed.
 *
 * These tests pin the replacement: four vendored staging ROOTS added to the
 * trust store, verification left ON. The TLS-handshake block at the bottom is
 * the load-bearing part — it proves, against a real local TLS server, that
 * trust comes from the explicit root and that bad certificates still fail.
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ACME_STAGING_DIRECTORY,
  e2eCliEnv,
  REPO_ROOT,
  readStagingRootPems,
  resetStagingTrustCacheForTests,
  STAGING_CA_BUNDLE,
  setupE2EEnv,
  trustLetsEncryptStagingRoots,
} from '../../../tests/e2e/utils/e2e-env.js';

/**
 * The four roots letsencrypt.org/docs/staging-environment/ listed as current
 * on 2026-07-30, pinned by SHA-256 so a silent swap of the vendored file
 * fails here rather than in a 40-minute matrix run.
 *
 * Refreshing: re-download from the URLs in the bundle header, then update
 * both the bundle and this table.
 */
const EXPECTED_ROOTS = [
  {
    cn: '(STAGING) Pretend Pear X1',
    sha256: 'E70570A989F8565AABDF7CAE27ABD1621872D6A3F811E3FEF27E3DBA02912198',
  },
  {
    cn: '(STAGING) Bogus Broccoli X2',
    sha256: '9B2A339FE6A3E85585C4CD75536CB8C1CF7CD603B9A64BEC2521858AE48DA85D',
  },
  {
    cn: '(STAGING) Yearning Yucca Root YE',
    sha256: 'B59BFC0BA52DAF849853B7324A91E82F031DB3397F35644157352CDE6384B56C',
  },
  {
    cn: '(STAGING) Yonder Yam Root YR',
    sha256: 'EF115FB59E040FF39D15FD8F3EF54063C704321D83CB081213272F77D3091672',
  },
];

const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, '');

/**
 * `tls.setDefaultCACertificates()` / `tls.getCACertificates()` arrived in Node
 * 22.15; `engines.node` is `>=20`.
 *
 * That is deliberate, not an oversight. Layer 1 — `NODE_EXTRA_CA_CERTS`, which
 * the `pnpm test:e2e*` scripts set BEFORE node boots — works on every supported
 * version and covers CI plus every documented entry point (`scripts/iter-step.js`
 * only spawns CLI children, which inherit it). Layer 2, in-process trust, is an
 * enhancement for direct `tsx tests/e2e/runner.ts` invocation on newer Node;
 * `trustLetsEncryptStagingRoots()` warns and returns `appliedInProcess: false`
 * where the API is missing rather than throwing.
 *
 * The suites below drive layer 2 directly, so they gate on the SAME capability
 * check the production code uses — skipping on Node 20 instead of crashing in
 * `beforeAll` with `getCACertificates is not a function`. Everything above is
 * version-independent and always runs.
 */
// NOT dead code under the current `engines.node: ">=24.15.0"` floor: engines is
// advisory (no `engine-strict` in any .npmrc), so a contributor still on Node 22
// can run this suite. This gate is what keeps that working — don't "clean it up".
const inProcessTrustSupported = typeof tls.setDefaultCACertificates === 'function';
const NO_IN_PROCESS_TRUST = `Node ${process.version} has no tls.setDefaultCACertificates() (needs >=22.15)`;

/**
 * Skipped suites are invisible in the default reporter, and invisible coverage
 * rots. Fold the reason into the suite name so a skip announces itself.
 */
const suite = (name: string, reason: string | null) =>
  reason ? `${name} — SKIPPED: ${reason}` : name;

describe('vendored Let’s Encrypt staging roots', () => {
  it('ships the bundle the harness points NODE_EXTRA_CA_CERTS at', () => {
    expect(existsSync(STAGING_CA_BUNDLE)).toBe(true);
  });

  it('contains exactly the four current staging roots, pinned by SHA-256', () => {
    const pems = readStagingRootPems();
    expect(pems).toHaveLength(EXPECTED_ROOTS.length);

    const actual = pems.map((pem) => {
      const cert = new X509Certificate(pem);
      return { subject: cert.subject, sha256: fingerprint(pem) };
    });

    for (const expected of EXPECTED_ROOTS) {
      const match = actual.find((a) => a.sha256 === expected.sha256);
      expect(
        match,
        `no vendored root with SHA-256 ${expected.sha256} (${expected.cn})`,
      ).toBeTruthy();
      expect(match?.subject).toContain(expected.cn);
    }
  });

  it('vendors ROOTS only — self-signed, unexpired, and no private key material', () => {
    const raw = readFileSync(STAGING_CA_BUNDLE, 'utf-8');
    expect(raw).not.toMatch(/PRIVATE KEY/);

    const now = Date.now();
    for (const pem of readStagingRootPems()) {
      const cert = new X509Certificate(pem);
      // Root = self-signed. Staging INTERMEDIATES are documented as
      // "subject to change at any time" and must never be pinned here.
      expect(cert.subject, `${cert.subject} is not self-signed`).toBe(cert.issuer);
      expect(cert.ca).toBe(true);
      expect(new Date(cert.validTo).getTime(), `${cert.subject} is expired`).toBeGreaterThan(now);
    }
  });
});

describe('trustLetsEncryptStagingRoots', () => {
  it('points NODE_EXTRA_CA_CERTS at an existing file containing the roots', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = trustLetsEncryptStagingRoots({ env, applyInProcess: false });

    expect(env.NODE_EXTRA_CA_CERTS).toBe(STAGING_CA_BUNDLE);
    expect(existsSync(String(env.NODE_EXTRA_CA_CERTS))).toBe(true);
    expect(result.rootCount).toBe(EXPECTED_ROOTS.length);
    expect(result.merged).toBe(false);

    const shipped = readStagingRootPems(String(env.NODE_EXTRA_CA_CERTS)).map(fingerprint);
    for (const expected of EXPECTED_ROOTS) expect(shipped).toContain(expected.sha256);
  });

  it('never disables verification', () => {
    const env: NodeJS.ProcessEnv = {};
    trustLetsEncryptStagingRoots({ env, applyInProcess: false });
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('merges rather than clobbers an operator-supplied NODE_EXTRA_CA_CERTS', () => {
    // Node honours exactly one path in that variable, so a naive assignment
    // would silently drop a corporate/proxy CA the operator needs.
    const dir = mkdtempSync(join(tmpdir(), 'e2e-ca-merge-'));
    const operatorBundle = join(dir, 'corp-root.pem');
    const someRoot = readStagingRootPems()[0];
    writeFileSync(operatorBundle, someRoot);

    const env: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: operatorBundle };
    const result = trustLetsEncryptStagingRoots({ env, applyInProcess: false });

    expect(result.merged).toBe(true);
    expect(env.NODE_EXTRA_CA_CERTS).not.toBe(operatorBundle);
    const combined = readStagingRootPems(String(env.NODE_EXTRA_CA_CERTS));
    // Operator bundle first, then all four staging roots.
    expect(combined.length).toBe(EXPECTED_ROOTS.length + 1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('normalises the path so children spawned with a different cwd still find it', () => {
    // Every CLI child runs with cwd = the scaffolded project dir, not the
    // repo root; a relative NODE_EXTRA_CA_CERTS (as the package.json script
    // spells it) would not resolve there.
    const env: NodeJS.ProcessEnv = {
      NODE_EXTRA_CA_CERTS: 'tests/e2e/certs/letsencrypt-staging-roots.pem',
    };
    trustLetsEncryptStagingRoots({ env, applyInProcess: false });
    expect(env.NODE_EXTRA_CA_CERTS).toBe(STAGING_CA_BUNDLE);
    expect(env.NODE_EXTRA_CA_CERTS?.startsWith('/')).toBe(true);
  });
});

describe('setupE2EEnv', () => {
  it('establishes staging ACME + ssh-askpass guards without touching verification', () => {
    const env: NodeJS.ProcessEnv = { DISPLAY: ':0' };
    setupE2EEnv({ env, applyInProcess: false, warn: () => {} });

    expect(env.ACME_CA_SERVER).toBe(ACME_STAGING_DIRECTORY);
    expect(env.ACME_CA_SERVER).toContain('acme-staging-v02');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(env.SSH_ASKPASS).toBe('/bin/false');
    expect(env.DISPLAY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBe(STAGING_CA_BUNDLE);
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('warns loudly when the operator has verification switched off', () => {
    const warnings: string[] = [];
    setupE2EEnv({
      env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      applyInProcess: false,
      warn: (m) => warnings.push(m),
    });
    expect(warnings.join('\n')).toMatch(/TLS verification is DISABLED/);
  });
});

// Layer 1 itself works on every supported Node; only the child's *assertion*
// mechanism (`tls.getCACertificates('extra')`) needs 22.15+. The env plumbing
// is covered version-independently by the `normalises the path…` case above.
const childSkipReason = inProcessTrustSupported ? null : NO_IN_PROCESS_TRUST;

describe.skipIf(childSkipReason)(suite('child processes', childSkipReason), () => {
  it('a CLI child spawned by the harness starts with the staging roots trusted', () => {
    // Layer 1 of trustLetsEncryptStagingRoots(): every `vibecarbon` child the
    // harness spawns inherits NODE_EXTRA_CA_CERTS and therefore boots with the
    // staging roots already in its store. Node reads that variable once at
    // startup, so this can only be verified from a real child.
    const env = e2eCliEnv({}, setupChildEnv());
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "const tls=require('node:tls');const {X509Certificate}=require('node:crypto');" +
          "console.log(tls.getCACertificates('extra')" +
          ".map((p)=>new X509Certificate(p).fingerprint256.replace(/:/g,'')).join(','))",
      ],
      // cwd deliberately NOT the repo root — proves the inherited path is
      // absolute (the npm script spells it relatively).
      { cwd: tmpdir(), env, encoding: 'utf-8' },
    ).trim();

    for (const expected of EXPECTED_ROOTS) expect(out).toContain(expected.sha256);
  }, 20_000);
});

/** A fresh env with only the harness setup applied — never `process.env`. */
function setupChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  setupE2EEnv({ env, applyInProcess: false, warn: () => {} });
  return env;
}

/**
 * Lines under `paths` that ASSIGN NODE_TLS_REJECT_UNAUTHORIZED.
 *
 * `=[^=]` excludes the `=== '0'` comparison e2e-env.js uses to detect an
 * operator-supplied one, and comment lines are dropped so the prose
 * explaining why we no longer do this doesn't trip its own guard.
 */
function tlsOffAssignments(paths: string[]): string[] {
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['grep', '-nE', '--', 'NODE_TLS_REJECT_UNAUTHORIZED\\s*=[^=]', ...paths],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    // git grep exits 1 when there are no matches — that is the pass case.
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((line) => !/^\s*(\/\/|\/\*|\*|#)/.test(line.replace(/^[^:]+:\d+:/, '')));
}

describe('drift guards', () => {
  it('runner.ts no longer disables TLS verification', () => {
    expect(tlsOffAssignments(['tests/e2e/runner.ts'])).toEqual([]);
  });

  it('nothing under tests/ or scripts/ assigns NODE_TLS_REJECT_UNAUTHORIZED', () => {
    // Repo-wide guard: a re-introduction anywhere in the harness re-opens the
    // same hole.
    expect(tlsOffAssignments(['tests/', 'scripts/'])).toEqual([]);
  });

  it('the e2e npm scripts set NODE_EXTRA_CA_CERTS at Node startup', () => {
    // Node reads NODE_EXTRA_CA_CERTS exactly once, during process init —
    // setting it from inside runner.ts is too late for the runner's own
    // sockets. The scripts are the startup-time layer.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    for (const name of ['test:e2e', 'test:e2e:batch', 'test:e2e:expanded']) {
      expect(pkg.scripts[name], name).toContain(
        'NODE_EXTRA_CA_CERTS=tests/e2e/certs/letsencrypt-staging-roots.pem',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The actual proof: a real TLS handshake against a real local server.
//
// Everything above checks plumbing. This block checks the property we care
// about — that verification stays ON and only the explicitly-trusted root
// changes the outcome. Certificates are minted at test time (throwaway EC
// keys in a temp dir) so no key material is ever committed.
// ---------------------------------------------------------------------------

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const handshakeSkipReason = !opensslAvailable
  ? 'openssl is not on PATH'
  : !inProcessTrustSupported
    ? NO_IN_PROCESS_TRUST
    : null;

const handshakeSuite = suite('TLS verification behaviour (real handshake)', handshakeSkipReason);

describe.skipIf(handshakeSkipReason)(handshakeSuite, () => {
  let dir: string;
  let caPem: string;
  let originalDefaults: string[] | undefined;

  const openssl = (args: string[]) =>
    execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

  const mintLeaf = (name: string, san: string) => {
    openssl([
      'req',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${name}`,
    ]);
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
    openssl([
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '1',
      '-extfile',
      `${name}.ext`,
    ]);
    return {
      key: readFileSync(join(dir, `${name}.key`)),
      cert: readFileSync(join(dir, `${name}.pem`)),
    };
  };

  /** Serve `creds` on loopback, run `fn` against it, always close. */
  const withServer = async (
    creds: { key: Buffer; cert: Buffer },
    fn: (origin: string) => Promise<void>,
  ) => {
    const server = https.createServer(creds, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fn(`https://localhost:${port}/`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  const fetchResult = async (origin: string): Promise<{ ok: boolean; code?: string }> => {
    try {
      const res = await fetch(origin);
      return { ok: res.ok };
    } catch (err) {
      const cause = (err as Error & { cause?: { code?: string } }).cause;
      return { ok: false, code: cause?.code ?? (err as NodeJS.ErrnoException).code };
    }
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-tls-proof-'));
    openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=Vibecarbon E2E Throwaway Root',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    caPem = readFileSync(join(dir, 'ca.pem'), 'utf-8');
    originalDefaults = tls.getCACertificates('default');
  });

  afterEach(() => {
    // Each case starts from the stock trust store.
    if (originalDefaults) tls.setDefaultCACertificates(originalDefaults);
    resetStagingTrustCacheForTests();
  });

  afterAll(() => {
    if (originalDefaults) tls.setDefaultCACertificates(originalDefaults);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a certificate from an untrusted CA (verification is ON)', async () => {
    const leaf = mintLeaf('localhost', 'DNS:localhost,IP:127.0.0.1');
    await withServer(leaf, async (origin) => {
      const result = await fetchResult(origin);
      expect(result.ok).toBe(false);
      expect(result.code).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|UNTRUSTED/i);
    });
  }, 20_000);

  it('accepts it once — and only once — its root is explicitly trusted', async () => {
    const leaf = mintLeaf('localhost', 'DNS:localhost,IP:127.0.0.1');
    await withServer(leaf, async (origin) => {
      expect((await fetchResult(origin)).ok).toBe(false);

      // Same mechanism trustLetsEncryptStagingRoots() uses for layer 2.
      tls.setDefaultCACertificates([...tls.getCACertificates('default'), caPem]);

      expect((await fetchResult(origin)).ok).toBe(true);
    });
  }, 20_000);

  it('still rejects a wrong-host certificate signed by the trusted root', async () => {
    // The failure mode the old blanket TLS-off could never catch: a valid
    // chain for the wrong name.
    const wrong = mintLeaf('wrong', 'DNS:wrong.example.invalid');
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), caPem]);
    await withServer(wrong, async (origin) => {
      const result = await fetchResult(origin);
      expect(result.ok).toBe(false);
      expect(result.code).toMatch(/ALTNAME/i);
    });
  }, 20_000);

  it('trustLetsEncryptStagingRoots() puts the staging roots in this process’s trust store', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = trustLetsEncryptStagingRoots({ env });
    expect(result.trustedAtStartup || result.appliedInProcess).toBe(true);

    const trusted = new Set(tls.getCACertificates('default').map(fingerprint));
    for (const expected of EXPECTED_ROOTS) expect(trusted).toContain(expected.sha256);
  });
});
