/**
 * The deploy gate end to end, with only the network stubbed.
 *
 * Real activateLicense, real getLicense, real checkLicense, real signed
 * verdict cache, real evaluateDeployEntitlement, real upsell and warning
 * copy. The keys and verdict tokens are minted against an ephemeral Ed25519
 * pair (scripts/generate-license.js), injected via `publicKeyPem`, so no
 * production secret is needed and no assertion depends on the wall clock:
 * `now` is passed explicitly wherever a date decides the outcome.
 *
 * This replaces the provision/refresh seam: the gate no longer asks for a
 * renewed key, it asks vibecarbon.com whether the subscription is current.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  derivePublicKeyPem,
  mintV1Key,
  mintV2Key,
  signVerdictToken,
} from '../../../scripts/generate-license.js';
import { activateLicense, requireDeployEntitlement } from '../../../src/lib/licensing/index.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_ID = 'a1b2c3d4';
const NOW = '2026-09-15';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  void publicKey;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKeyPem, publicKeyPem: derivePublicKeyPem(privateKeyPem) };
}

/** A fetch stub answering with one signed verdict token. */
function fetchReturning(token: string, cancelAtPeriodEnd = false) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token, cancelAtPeriodEnd }),
  }));
}

/** A fetch stub answering 404: the server knows the endpoint, not this key. */
function fetchRejecting() {
  return vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }));
}

function fetchThatThrows() {
  return vi.fn(async () => {
    const err = new Error('connect ECONNREFUSED');
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    throw err;
  });
}

describe('requireDeployEntitlement seam', () => {
  let stateDir: string;
  let projectDir: string;
  let privateKeyPem: string;
  let publicKeyPem: string;
  let logged: string[];
  let written: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const projectConfig = () => ({ projectName: 'lictest', projectId: PROJECT_ID });

  function verdict({
    status = 'active',
    tier = 'graphene',
    periodEnd = '2026-09-30',
    issued = NOW,
    projectId = PROJECT_ID,
  } = {}) {
    return signVerdictToken(privateKeyPem, { projectId, status, tier, periodEnd, issued });
  }

  function gate(overrides: Record<string, unknown> = {}) {
    return requireDeployEntitlement({
      deployTier: 'k8s',
      projectConfig: projectConfig(),
      projectDir,
      stateDir,
      env: {},
      publicKeyPem,
      now: NOW,
      ...overrides,
    });
  }

  /** Only the gate's own copy: the spinner writes through clack, not console.log. */
  function output() {
    return logged.join('\n');
  }

  /** The spinner's own lines: clack writes them straight to stdout. */
  function spinnerOutput() {
    return written.join('');
  }

  function cachePath() {
    return join(stateDir, 'license-checks', `${PROJECT_ID}.json`);
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'vc-gate-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'vc-gate-project-'));
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ version: '1', projectId: PROJECT_ID, services: {} }, null, 2)}\n`,
    );
    ({ privateKeyPem, publicKeyPem } = makeKeypair());
    logged = [];
    written = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function activateV2() {
    const key = mintV2Key(privateKeyPem, { customerId: CUSTOMER_ID, projectId: PROJECT_ID });
    const result = activateLicense(key, { projectDir, stateDir, publicKeyPem });
    expect(result.success).toBe(true);
    return key;
  }

  it('1: an active graphene subscription clears a k8s deploy and caches the verdict', async () => {
    activateV2();
    const fetchImpl = fetchReturning(verdict());

    await expect(gate({ fetchImpl })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).not.toContain('License required');
    expect(output()).not.toContain('Deploys keep working');
    expect(output()).not.toContain('Could not reach vibecarbon.com');
    expect(existsSync(cachePath())).toBe(true);
    expect(JSON.parse(readFileSync(cachePath(), 'utf-8')).token).toBe(verdict());
    expect(spinnerOutput()).toContain('Subscription checked');
  });

  it('2: past_due inside the grace window warns and proceeds', async () => {
    activateV2();
    // periodEnd + 30 days = 2026-10-01, so 2026-09-15 leaves 16 days.
    const fetchImpl = fetchReturning(verdict({ status: 'past_due', periodEnd: '2026-09-01' }));

    await expect(gate({ fetchImpl })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).toContain('Deploys keep working for 16 more days.');
  });

  it('3: canceled past the grace window blocks with Subscription ended', async () => {
    activateV2();
    const fetchImpl = fetchReturning(verdict({ status: 'canceled', periodEnd: '2026-01-01' }));

    await expect(gate({ fetchImpl })).rejects.toThrow('process.exit(1)');

    expect(output()).toContain('Subscription ended');
  });

  it('4: a graphene verdict cannot deploy k8s-ha', async () => {
    activateV2();
    const fetchImpl = fetchReturning(verdict({ tier: 'graphene' }));

    await expect(gate({ fetchImpl, deployTier: 'k8s-ha' })).rejects.toThrow('process.exit(1)');

    expect(output()).toContain('Plan switch required');
  });

  it('5: an unreachable server with no cache warns and proceeds', async () => {
    activateV2();
    const fetchImpl = fetchThatThrows();

    await expect(gate({ fetchImpl })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).toContain('Could not reach vibecarbon.com to verify');
  });

  it('6: an unreachable server falls back to the cached verdict silently', async () => {
    activateV2();
    await gate({ fetchImpl: fetchReturning(verdict()) });
    logged = [];

    await expect(gate({ fetchImpl: fetchThatThrows() })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).not.toContain('Could not reach vibecarbon.com to verify');
    expect(output()).not.toContain('License required');
    // A cached verdict is a real answer, so the spinner must not report the
    // check as skipped.
    expect(spinnerOutput()).toContain('Subscription check used the cached verdict');
    expect(spinnerOutput()).not.toContain('Subscription check skipped');
  });

  it('7: an edited cache file is ignored, so the run falls back to the warning', async () => {
    activateV2();
    await gate({ fetchImpl: fetchReturning(verdict()) });
    const stored = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    stored.token = stored.token.replace('-active-', '-canceled-');
    writeFileSync(cachePath(), JSON.stringify(stored, null, 2));
    logged = [];

    await expect(gate({ fetchImpl: fetchThatThrows() })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).toContain('Could not reach vibecarbon.com to verify');
    expect(spinnerOutput()).toContain('Subscription check skipped');
  });

  it('8: a compose deploy with no key never reaches the network', async () => {
    const fetchImpl = fetchReturning(verdict());

    await expect(gate({ fetchImpl, deployTier: 'compose' })).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).toBe('');
  });

  it('9: a legacy lifetime key clears k8s-ha without any check', async () => {
    const v1 = mintV1Key(privateKeyPem, { customerId: CUSTOMER_ID });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'license'),
      JSON.stringify({ key: v1, tier: 'fullerene', customerId: CUSTOMER_ID }),
    );
    const fetchImpl = fetchReturning(verdict());

    await expect(gate({ fetchImpl, deployTier: 'k8s-ha' })).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).toBe('');
  });

  it('10: no key at all blocks a k8s deploy without asking the server', async () => {
    const fetchImpl = fetchReturning(verdict());

    await expect(gate({ fetchImpl })).rejects.toThrow('process.exit(1)');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output()).toContain('License required');
  });

  it('11: a server that does not recognize the key blocks and says so', async () => {
    activateV2();
    const fetchImpl = fetchRejecting();

    await expect(gate({ fetchImpl })).rejects.toThrow('process.exit(1)');

    expect(output()).toContain('License required');
    // A refusal is not an outage: the spinner must not call it skipped, and
    // nothing may be cached from it.
    expect(spinnerOutput()).toContain('Subscription check refused this key');
    expect(spinnerOutput()).not.toContain('Subscription check skipped');
    expect(existsSync(cachePath())).toBe(false);
  });
});
