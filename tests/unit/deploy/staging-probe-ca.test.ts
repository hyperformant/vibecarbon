import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { stagingProbeCa, stagingRootsPem } from '../../../src/lib/deploy/staging-ca.js';

/**
 * The deploy CLI's public health probe used to disable TLS verification
 * outright for Let's Encrypt STAGING runs (`rejectUnauthorized: false`) —
 * the exact pattern a566006 eliminated on the e2e-harness side. The probe
 * now pins the four vendored staging roots ON TOP of the system store, so
 * staging chains validate and genuinely bad certificates still fail.
 */

describe('stagingProbeCa', () => {
  it('returns the system roots plus the vendored staging bundle', () => {
    const ca = stagingProbeCa();
    expect(ca.length).toBe(tls.rootCertificates.length + 1);
    const bundle = ca[ca.length - 1];
    const blocks = bundle.match(/BEGIN CERTIFICATE/g) ?? [];
    expect(blocks.length).toBe(4);
  });

  it('ships a bundle byte-identical to the e2e-vendored one (lockstep guard)', () => {
    // Two copies exist on purpose: tests/e2e/certs/ feeds the harness's
    // NODE_EXTRA_CA_CERTS, src/lib/deploy/certs/ ships in the npm package
    // for the CLI probe. Refresh both together (see the PEM header for the
    // procedure) — this test fails if they ever drift.
    const e2eCopy = readFileSync(
      join(__dirname, '..', '..', 'e2e', 'certs', 'letsencrypt-staging-roots.pem'),
      'utf8',
    );
    expect(stagingRootsPem()).toBe(e2eCopy);
  });

  it('orchestrator no longer contains any TLS-verification opt-out', () => {
    // Extends the e2e-side drift guard (staging-ca-trust.test.ts) to src/:
    // the probe must never regress to rejectUnauthorized: false.
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'lib', 'deploy', 'orchestrator.js'),
      'utf8',
    );
    expect(src).not.toMatch(/rejectUnauthorized/);
  });
});

// ---------------------------------------------------------------------------
// Live handshake: prove the pinned-CA agent VERIFIES (rejects a chain signed
// by an unknown CA) instead of blanket-trusting. Mirrors the openssl-minting
// approach of tests/unit/e2e/staging-ca-trust.test.ts; skipped when openssl
// is not on PATH.
// ---------------------------------------------------------------------------

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function mintSelfSignedLocalhost() {
  const dir = mkdtempSync(join(tmpdir(), 'vibecarbon-staging-probe-ca-'));
  tempDirs.push(dir);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-keyout',
      'key.pem',
      '-out',
      'cert.pem',
      '-days',
      '2',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return {
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
  };
}

describe.skipIf(!opensslAvailable)('pinned-CA agent still verifies', () => {
  it('rejects a chain the pinned store does not trust, accepts once trusted', async () => {
    const { key, cert } = mintSelfSignedLocalhost();
    const server = https.createServer({ key, cert }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const undici = await import('undici');

    const pinned = new undici.Agent({ connect: { ca: stagingProbeCa() } });
    await expect(
      undici.fetch(`https://localhost:${port}/`, { dispatcher: pinned }),
    ).rejects.toThrow();

    const augmented = new undici.Agent({ connect: { ca: [...stagingProbeCa(), cert] } });
    const res = await undici.fetch(`https://localhost:${port}/`, { dispatcher: augmented });
    expect(res.status).toBe(200);

    await pinned.close();
    await augmented.close();
    server.close();
  });
});
