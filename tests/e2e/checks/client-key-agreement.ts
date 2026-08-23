/**
 * Client/server key-agreement check — asserts the anon key BAKED INTO the
 * served JS bundle is the key the server actually honors.
 *
 * RCA vibecarbon.com 2026-08-22: an `.env.local` migrated from another
 * project made `collectComposeBuildArgs` bake that project's
 * VITE_SUPABASE_ANON_KEY into the image while the server ran this project's
 * JWT_SECRET from `.env`. Every browser auth call 401'd — yet the whole e2e
 * verify block stayed green, because every auth check passes the harness's
 * OWN anon key (read from the project's env files, i.e. the server-side
 * truth) and nothing ever asserted what the shipped bundle contains.
 *
 * This check closes that gap without a browser: fetch the SPA shell, sweep
 * its JS assets, extract every JWT-shaped string, and require that exactly
 * the expected anon key appears. Combined with the existing auth checks
 * (which prove `expectedAnonKey` works against GoTrue), a pass here proves
 * the browser path works end-to-end.
 */

import type { VerificationResult } from '../scenarios/types.js';
import { dnsSafeFetch } from './health.js';

const CHECK_NAME = 'client_key_agreement';

// Matches <script src="/assets/x.js"> and <link rel="modulepreload"
// href="/assets/x.js"> — the two ways the built index.html references chunks.
const ASSET_URL_RE = /(?:src|href)="(\/assets\/[A-Za-z0-9._-]+\.js)"/g;

// Three base64url segments, first starting with eyJ ("{" encoded) and long
// enough to be a real signed token — filters out incidental eyJ… fragments.
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** Unique /assets/*.js paths referenced by the SPA shell, in document order. */
export function extractAssetUrls(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(ASSET_URL_RE)) {
    seen.add(m[1]);
  }
  return [...seen];
}

/** Unique JWT-shaped strings inlined in a JS source, in order of appearance. */
export function extractSupabaseJwts(jsSource: string): string[] {
  const seen = new Set<string>();
  for (const m of jsSource.matchAll(JWT_RE)) {
    seen.add(m[0]);
  }
  return [...seen];
}

/**
 * Verdict matrix. Fails on ANY baked JWT that is not the expected key (a
 * stale key alongside the right one still breaks whichever chunk uses it),
 * and fails loudly when no JWT is baked at all — a bundle with no anon key
 * cannot initialize the Supabase client, so "found nothing" is never green.
 * Error messages carry 12-char prefixes only, never whole tokens.
 */
export function evaluateKeyAgreement(
  bakedJwts: string[],
  expectedAnonKey: string,
): Pick<VerificationResult, 'status' | 'errorMessage' | 'details'> {
  if (bakedJwts.length === 0) {
    return {
      status: 'fail',
      errorMessage:
        'No JWT-shaped token found in any served JS asset — the bundle has no baked anon key',
      details: { bakedJwtCount: 0 },
    };
  }
  const stale = bakedJwts.filter((jwt) => jwt !== expectedAnonKey);
  const hasExpected = bakedJwts.includes(expectedAnonKey);
  if (stale.length > 0 || !hasExpected) {
    return {
      status: 'fail',
      errorMessage:
        `Served bundle bakes ${stale.length} JWT(s) that are NOT the server's anon key ` +
        `(prefixes: ${stale.map((jwt) => jwt.slice(0, 12)).join(', ')}); ` +
        `expected key ${hasExpected ? 'also present' : 'ABSENT'} (${expectedAnonKey.slice(0, 12)}…). ` +
        'Client build args and the server .env disagree — browser auth will 401.',
      details: { bakedJwtCount: bakedJwts.length, staleCount: stale.length, hasExpected },
    };
  }
  return {
    status: 'pass',
    details: { bakedJwtCount: bakedJwts.length },
  };
}

/**
 * Run the check against a deployed domain.
 *
 * @param domain - apex domain serving the SPA
 * @param expectedAnonKey - the anon key the server runs (the same one the
 *   auth checks already proved GoTrue accepts)
 */
export async function runClientKeyAgreementCheck(
  domain: string,
  expectedAnonKey: string,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    const htmlRes = await dnsSafeFetch(`https://${domain}/`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!htmlRes.ok) {
      return {
        checkName: CHECK_NAME,
        status: 'fail',
        responseTimeMs: Date.now() - start,
        errorMessage: `SPA shell fetch returned HTTP ${htmlRes.status}`,
      };
    }
    const assetUrls = extractAssetUrls(await htmlRes.text());
    const baked = new Set<string>();
    for (const url of assetUrls) {
      const res = await dnsSafeFetch(`https://${domain}${url}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue; // a missing chunk is frontend-smoke's problem
      for (const jwt of extractSupabaseJwts(await res.text())) {
        baked.add(jwt);
      }
    }
    const verdict = evaluateKeyAgreement([...baked], expectedAnonKey);
    return {
      checkName: CHECK_NAME,
      responseTimeMs: Date.now() - start,
      ...verdict,
      details: { ...verdict.details, assetsScanned: assetUrls.length },
    };
  } catch (err) {
    return {
      checkName: CHECK_NAME,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `client-key-agreement sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
