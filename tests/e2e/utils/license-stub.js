/**
 * In-process stand-in for vibecarbon.com's licence API, for integration and
 * e2e runs. Signs REAL verdict tokens with the signing private key (the
 * CLI's embedded public key is the only one it trusts, and a test-only
 * override would be a production bypass), so the CLI under test walks its
 * production code path against this stub with VIBECARBON_API_BASE set.
 *
 * `/release` releases immediately: the stub stands in for "the buyer
 * clicked the emailed link". Every request is recorded in `calls`.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  derivePublicKeyPem,
  mintKey as mintSignedKey,
  normalizePem,
  randomLicenseId,
  signVerdictToken,
} from '../../../scripts/generate-license.js';
import { validateLicenseKey } from '../../../src/lib/licensing/validator.js';
import { loadE2EEnvFile } from './e2e-env-file.js';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const DEFAULT_ENV_FILE = join(REPO_ROOT, 'tests', '.env.e2e');
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
// What a subscription ROW may hold. Narrower than the verdict vocabulary:
// 'unbound' / 'wrong_project' / 'none' are derived per-request by /check.
const SEEDABLE_STATUSES = new Set(['active', 'trialing', 'past_due', 'canceled']);
const SEEDABLE_TIERS = new Set(['graphene', 'fullerene']);

/**
 * The Ed25519 signing key the stub mints keys and verdicts with: env first,
 * then the operator's gitignored `tests/.env.e2e`.
 *
 * A present-but-EMPTY value counts as absent, so a CI job that sets
 * `VIBECARBON_LICENSE_PRIVATE_KEY: ''` (an unset GitHub secret renders exactly
 * that) falls through to the file rather than pinning the empty string.
 *
 * The file is read into a SCRATCH object, never into `env`. `tests/.env.e2e`
 * is the operator's credential file — it also carries `HETZNER_API_TOKEN` and
 * friends — and loading it into the caller's environment would side-load every
 * one of those into whatever this process later spawns. One key is asked for;
 * one key is returned.
 *
 * Normalised on the way out via `normalizePem`: vibecarbon-web stores its
 * copy of this key as base64-of-PEM, so an operator pasting "the same value"
 * from there gets a usable key regardless of which form they pasted.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envFilePath] - overridable so tests never read the real file.
 * @returns {string | null} PEM, or null if neither source has a value.
 */
export function signingKeyOrNull(env = process.env, envFilePath = DEFAULT_ENV_FILE) {
  const fromEnv = env.VIBECARBON_LICENSE_PRIVATE_KEY?.trim();
  if (fromEnv) return normalizePem(fromEnv);
  const scratch = {};
  loadE2EEnvFile(envFilePath, scratch);
  const fromFile = scratch.VIBECARBON_LICENSE_PRIVATE_KEY?.trim();
  return fromFile ? normalizePem(fromFile) : null;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function startLicenseStub({ privateKeyPem }) {
  if (!privateKeyPem) throw new Error('startLicenseStub: privateKeyPem is required');
  const publicKeyPem = derivePublicKeyPem(privateKeyPem);
  /** @type {Map<string, { projectId: string|null, tier: string, status: string, periodEndYmd: string, cancelAtPeriodEnd: boolean }>} */
  const state = new Map();
  const calls = [];

  function resolve(body) {
    if (!body || typeof body.key !== 'string') {
      return { error: { status: 400, body: { error: 'invalid_request' } } };
    }
    const v = validateLicenseKey(body.key, { publicKeyPem });
    if (!v.valid) {
      const badSignature = v.error === 'Invalid license signature';
      return {
        error: {
          status: badSignature ? 401 : 400,
          body: { error: badSignature ? 'bad_signature' : 'invalid_key' },
        },
      };
    }
    const row = state.get(v.licenseId);
    if (!row) return { error: { status: 401, body: { error: 'unknown_key' } } };
    return { row, licenseId: v.licenseId };
  }

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ path: req.url, body });
    const r = resolve(body);
    if (r.error) return json(res, r.error.status, r.error.body);
    const { row, licenseId } = r;
    const pid = typeof body.projectId === 'string' ? body.projectId.toLowerCase() : null;

    switch (req.url) {
      case '/api/v1/license/check': {
        if (!pid) return json(res, 400, { error: 'invalid_request' });
        let status;
        let tier;
        let periodEnd;
        if (row.projectId === null) [status, tier, periodEnd] = ['unbound', 'none', todayYmd()];
        else if (row.projectId !== pid)
          [status, tier, periodEnd] = ['wrong_project', 'none', todayYmd()];
        else
          [status, tier, periodEnd] = [
            row.status === 'trialing' ? 'active' : row.status,
            row.tier,
            row.periodEndYmd,
          ];
        const token = signVerdictToken(privateKeyPem, {
          projectId: pid,
          status,
          tier,
          periodEnd,
          issued: todayYmd(),
        });
        return json(res, 200, {
          token,
          status,
          tier,
          projectId: pid,
          periodEnd: `${periodEnd}T00:00:00.000Z`,
          cancelAtPeriodEnd: tier === 'none' ? false : row.cancelAtPeriodEnd,
        });
      }
      case '/api/v1/license/bind': {
        if (!pid) return json(res, 400, { error: 'invalid_request' });
        if (!ACTIVE.has(row.status)) return json(res, 403, { error: 'subscription_inactive' });
        if (row.projectId !== null && row.projectId !== pid)
          return json(res, 409, { error: 'bound_to_other_project' });
        for (const [otherId, other] of state) {
          if (otherId !== licenseId && other.projectId === pid && ACTIVE.has(other.status)) {
            return json(res, 409, {
              error: 'project_already_licensed',
              switchPlan: false,
              message: 'This project already has a subscription.',
            });
          }
        }
        row.projectId = pid;
        return json(res, 200, {
          projectId: pid,
          tier: row.tier,
          status: row.status,
          periodEnd: `${row.periodEndYmd}T00:00:00.000Z`,
        });
      }
      case '/api/v1/license/release': {
        row.projectId = null;
        return json(res, 200, { sent: true });
      }
      case '/api/v1/license/status':
        return json(res, 200, {
          tier: row.tier,
          status: row.status,
          periodEnd: `${row.periodEndYmd}T00:00:00.000Z`,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          projectId: row.projectId,
        });
      default:
        return json(res, 404, { error: 'not_found' });
    }
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    calls,
    /**
     * Plant a subscription row. Typed so `state.get(id)` infers `projectId`
     * as `string | null` rather than `null` — the checked-JS inference from
     * the destructured default alone would narrow it to the default.
     *
     * @param {{ licenseId: string, projectId?: string|null, tier?: string,
     *   status?: string, periodEndYmd: string, cancelAtPeriodEnd?: boolean }} row
     */
    seed({
      licenseId,
      projectId = null,
      tier = 'fullerene',
      status = 'active',
      periodEndYmd,
      cancelAtPeriodEnd = false,
    }) {
      if (!periodEndYmd) throw new Error('seed: periodEndYmd (YYYY-MM-DD) is required');
      // A typo'd status would otherwise surface as a signVerdictToken throw
      // from inside the request handler, i.e. a hung fetch, not a failed
      // seed. Only the subscription states a ROW can hold are seedable:
      // 'unbound'/'wrong_project'/'none' are verdicts the routes DERIVE, and
      // tier 'none' likewise, so none of them are valid seed inputs.
      if (!SEEDABLE_STATUSES.has(status)) throw new Error(`seed: unknown status '${status}'`);
      if (!SEEDABLE_TIERS.has(tier)) throw new Error(`seed: unknown tier '${tier}'`);
      state.set(licenseId, {
        projectId: projectId ? projectId.toLowerCase() : null,
        tier,
        status,
        periodEndYmd,
        cancelAtPeriodEnd,
      });
    },
    mintKey(licenseId = randomLicenseId()) {
      return { key: mintSignedKey(privateKeyPem, { licenseId }), licenseId };
    },
    close() {
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
