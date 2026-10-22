/**
 * FAMILY-SWEEP CENSUS: no e2e HTTP check passes on a hollow response.
 *
 * RCA 2026-10-19 (tests/results/e2e.db): grafana_health and
 * prometheus_targets passed on every k8s/k8s-ha run with
 * `{"statusCode":200,"note":"HTML response (auth page)"}`, the app's SPA
 * catch-all page at a path that never reached Grafana, and on every compose
 * run with the ForwardAuth 401. Neither ever read Grafana's own answer. When
 * the app started answering unknown paths with a real 404 the k8s-ha checks
 * went red, and only then did the hollowness show. api_health had the same
 * shape (a bare 200), and auth_signup (a bare 2xx).
 *
 * Two layers keep the class fixed:
 *
 * 1. BEHAVIOUR. Every HTTP check runs against a faked healthy deploy (it must
 *    pass), then against the same deploy with the one endpoint its verdict
 *    rests on replaced by each hollow shape: the app's SPA 404, the SPA's
 *    200 HTML at the wrong path, an unauthenticated 401, a Traefik
 *    no-router 404, a bare `{}` 200, and a network error. Each must FAIL.
 *
 * 2. CENSUS. Every top-level function in tests/e2e/checks/*.ts that calls an
 *    HTTP seam (dnsSafeFetch or an injected fetcher) must be covered by a
 *    behaviour entry or carry a documented exemption. A new check drafts
 *    itself into this audit: until it is classified here, this test fails.
 *
 * 3. HA INTEGRITY. The checks of tests/e2e/checks/ha-integrity.ts read over
 *    SSH or the DNS provider's API, not HTTP. Their hollow shape is a missing
 *    handle (no key, no node IP, no reader): HA scenarios always have one, so
 *    each must FAIL without it, never pass or skip, and must not even try the
 *    remote. Every exported `check*` there is drafted into this audit.
 *
 * 4. TLS REUSE. tests/e2e/checks/tls-reuse.ts compares what is served now
 *    with what an earlier step recorded. Its hollow shape is a missing
 *    baseline (no serial recorded, no CertificateRequest listing read): that
 *    must FAIL, never pass because there was nothing to compare.
 *
 * 5. DEPLOY BUDGET. tests/e2e/checks/deploy-budget.ts judges a cold deploy
 *    from its own [perf] and [state] lines. Its hollow shape is a log without
 *    them (VIBECARBON_PERF off, a truncated capture): that must FAIL, never
 *    pass because no marker was over budget.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  authSettingsShapeError,
  checkRoute,
  notificationsShapeError,
} from '../../e2e/checks/app-api.js';
import {
  CookieJar,
  checkAdminLogin,
  checkAppApiMeAuthenticated,
  checkAuthProtected,
  checkAuthSignin,
  checkAuthSignup,
} from '../../e2e/checks/app-functional.js';
import * as deployBudget from '../../e2e/checks/deploy-budget.js';
import {
  FORWARDAUTH_COOKIE,
  runObservabilityChecks,
} from '../../e2e/checks/feature-observability.js';
import * as haIntegrity from '../../e2e/checks/ha-integrity.js';
import {
  APP_SHELL_MARKER,
  checkApiHealth,
  checkAuthHealth,
  checkUnknownPathNotFound,
} from '../../e2e/checks/health.js';
import * as standbyAddons from '../../e2e/checks/standby-addons.js';
import * as tlsReuse from '../../e2e/checks/tls-reuse.js';
import type { VerificationResult } from '../../e2e/scenarios/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = join(__dirname, '..', '..', 'e2e', 'checks');

const D = 'app.example.com';
const EMAIL = 'e2e@test.local';
const PASSWORD = 'pw';
const noSleep = async () => {};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

const SPA = `<!doctype html><html><body>${APP_SHELL_MARKER}</div></body></html>`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function withCookie(res: Response, cookie: string): Response {
  const headers = new Headers(res.headers);
  headers.append('set-cookie', cookie);
  return new Response(res.body, { status: res.status, headers });
}

const HOLLOW = {
  'SPA 404 (the app answering an unknown path)': () =>
    new Response(SPA, { status: 404, headers: { 'content-type': 'text/html' } }),
  'SPA 200 HTML at the wrong path': () =>
    new Response(SPA, { status: 200, headers: { 'content-type': 'text/html' } }),
  'unauthenticated 401': () =>
    new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
  'Traefik no-router 404': () =>
    new Response('404 page not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    }),
  'bare {} 200': () => json({}),
  'network error': () => {
    throw new Error('ECONNRESET');
  },
} satisfies Record<string, () => Response>;

type HollowName = keyof typeof HOLLOW;

// ---------------------------------------------------------------------------
// The behaviour matrix
// ---------------------------------------------------------------------------

interface Entry {
  /** What is checked, e.g. `grafana_health`. */
  label: string;
  /** `file:function` names in tests/e2e/checks this entry exercises. */
  covers: string[];
  /** The endpoint whose content the verdict must rest on. */
  isTarget: (url: string, init?: RequestInit) => boolean;
  /** The faked healthy deploy. */
  real: Fetcher;
  run: (fetcher: Fetcher) => Promise<VerificationResult>;
  /** Hollow shapes that ARE this check's real content (with why). */
  hollowIsReal?: Partial<Record<HollowName, string>>;
}

function sessionJar(): CookieJar {
  const jar = new CookieJar();
  jar.absorb(withCookie(new Response('{}'), '__Secure-better-auth.session_token=s; Path=/'));
  return jar;
}

const hasCookie = (init?: RequestInit) =>
  Boolean(((init?.headers ?? {}) as Record<string, string>).Cookie);

/** A sign-in that sets the session cookie, and a get-session that needs it. */
function authDeploy(user: Record<string, unknown>): Fetcher {
  return async (url, init) => {
    if (url.endsWith('/api/auth/sign-in/email')) {
      return withCookie(json({ user }), '__Secure-better-auth.session_token=s; Path=/; HttpOnly');
    }
    if (url.endsWith('/api/auth/get-session')) {
      return hasCookie(init) ? json({ user, session: { id: 'x' } }) : json(null);
    }
    return new Response(SPA, { status: 404, headers: { 'content-type': 'text/html' } });
  };
}

const GRAFANA = `https://${D}/admin/grafana`;
const TOKEN = 'fa-token';

function observabilityDeploy(): Fetcher {
  return async (url, init) => {
    if (url === `https://${D}/api/v1/admin/forwardauth-cookie`) {
      return withCookie(
        new Response(null, { status: 204 }),
        `${FORWARDAUTH_COOKIE}=${TOKEN}; Path=/`,
      );
    }
    if (!url.startsWith(GRAFANA)) return HOLLOW['SPA 404 (the app answering an unknown path)']();
    const cookie = ((init?.headers ?? {}) as Record<string, string>).Cookie;
    if (cookie !== `${FORWARDAUTH_COOKIE}=${TOKEN}`) return HOLLOW['unauthenticated 401']();
    if (url === `${GRAFANA}/api/health`) return json({ database: 'ok', version: '13.2.4' });
    if (url.endsWith('/api/datasources/proxy/uid/prometheus/api/v1/targets')) {
      return json({
        status: 'success',
        data: { activeTargets: [{ scrapePool: 'prometheus', health: 'up' }] },
      });
    }
    return HOLLOW['SPA 404 (the app answering an unknown path)']();
  };
}

async function observability(fetcher: Fetcher, checkName: string) {
  const results = await runObservabilityChecks({
    appDomain: D,
    isCompose: false,
    adminJar: sessionJar(),
    fetcher,
    sleep: noSleep,
    attempts: 2,
    retryDelayMs: 0,
  });
  const r = results.find((x) => x.checkName === checkName);
  if (!r) throw new Error(`${checkName} not in results`);
  return r;
}

const MATRIX: Entry[] = [
  {
    label: 'api_health',
    covers: ['health.ts:checkApiHealth'],
    isTarget: (u) => u.endsWith('/api/health'),
    real: async () => json({ status: 'ok', adminReady: true, migrationStatus: 'applied' }),
    run: (f) => checkApiHealth(D, { fetcher: f, sleep: noSleep }),
  },
  {
    label: 'auth_health',
    covers: ['health.ts:checkAuthHealth'],
    isTarget: (u) => u.endsWith('/api/auth/ok'),
    real: async () => json({ ok: true }),
    run: (f) => checkAuthHealth(D, { fetcher: f, sleep: noSleep }),
  },
  {
    label: 'unknown_path_not_found',
    covers: ['health.ts:checkUnknownPathNotFound'],
    isTarget: (u) => u.endsWith('/rest/v1/'),
    real: async () => HOLLOW['SPA 404 (the app answering an unknown path)'](),
    run: (f) => checkUnknownPathNotFound(D, f),
    hollowIsReal: {
      'SPA 404 (the app answering an unknown path)':
        "the check asserts exactly the app's own HTML 404 for an unknown path",
    },
  },
  {
    label: 'app_api_notifications',
    covers: ['app-api.ts:checkRoute'],
    isTarget: (u) => u.endsWith('/api/v1/notifications'),
    real: async () => json({ notifications: [] }),
    run: (f) =>
      checkRoute(
        'app_api_notifications',
        `https://${D}/api/v1/notifications`,
        notificationsShapeError,
        {
          fetcher: f,
          sleep: noSleep,
        },
      ),
  },
  {
    label: 'app_api_auth_settings',
    covers: ['app-api.ts:checkRoute'],
    isTarget: (u) => u.endsWith('/api/v1/auth/settings'),
    real: async () => json({ settings: { signupEnabled: true } }),
    run: (f) =>
      checkRoute(
        'app_api_auth_settings',
        `https://${D}/api/v1/auth/settings`,
        authSettingsShapeError,
        {
          fetcher: f,
          sleep: noSleep,
        },
      ),
  },
  {
    label: 'auth_signup',
    covers: ['app-functional.ts:checkAuthSignup'],
    isTarget: (u) => u.endsWith('/api/auth/sign-up/email'),
    real: async () => json({ user: { id: 'u1', email: EMAIL } }),
    run: (f) => checkAuthSignup(D, EMAIL, PASSWORD, { fetcher: f, sleep: noSleep }),
  },
  {
    label: 'auth_signin',
    covers: ['app-functional.ts:checkAuthSignin', 'app-functional.ts:signInWithPassword'],
    isTarget: (u) => u.endsWith('/api/auth/sign-in/email'),
    real: authDeploy({ email: EMAIL }),
    run: async (f) => (await checkAuthSignin(D, EMAIL, PASSWORD, false, f)).result,
  },
  {
    label: 'auth_protected',
    covers: ['app-functional.ts:checkAuthProtected', 'app-functional.ts:fetchSessionUser'],
    isTarget: (u) => u.endsWith('/api/auth/get-session'),
    real: authDeploy({ email: EMAIL }),
    run: (f) => checkAuthProtected(D, sessionJar(), EMAIL, f),
  },
  {
    label: 'auth_admin_login (get-session)',
    covers: ['app-functional.ts:checkAdminLogin', 'app-functional.ts:adminSignIn'],
    isTarget: (u) => u.endsWith('/api/auth/get-session'),
    real: authDeploy({ email: EMAIL, role: 'super_admin' }),
    run: (f) => checkAdminLogin(D, EMAIL, PASSWORD, f),
  },
  {
    label: 'auth_admin_login (sign-in)',
    covers: ['app-functional.ts:checkAdminLogin'],
    isTarget: (u) => u.endsWith('/api/auth/sign-in/email'),
    real: authDeploy({ email: EMAIL, role: 'super_admin' }),
    run: (f) => checkAdminLogin(D, EMAIL, PASSWORD, f),
  },
  {
    label: 'app_api_me_authenticated',
    covers: ['app-functional.ts:checkAppApiMeAuthenticated'],
    isTarget: (u) => u.endsWith('/api/v1/me'),
    real: async () => json({ user: { id: 'u1' }, memberships: [] }),
    run: (f) => checkAppApiMeAuthenticated(D, sessionJar(), f),
  },
  {
    label: 'grafana_route_protected',
    covers: ['feature-observability.ts:checkGrafanaRouteProtected'],
    isTarget: (u, init) => u === `${GRAFANA}/api/health` && !hasCookie(init),
    real: observabilityDeploy(),
    run: (f) => observability(f, 'grafana_route_protected'),
    hollowIsReal: {
      'unauthenticated 401': 'the check asserts ForwardAuth refuses a request with no cookie',
    },
  },
  {
    label: 'grafana_health',
    covers: [
      'feature-observability.ts:checkGrafanaHealth',
      'feature-observability.ts:authedRead',
      'feature-observability.ts:runObservabilityChecks',
    ],
    isTarget: (u, init) => u === `${GRAFANA}/api/health` && hasCookie(init),
    real: observabilityDeploy(),
    run: (f) => observability(f, 'grafana_health'),
  },
  {
    label: 'grafana_health (ForwardAuth cookie mint)',
    covers: ['feature-observability.ts:mintForwardAuthCookie'],
    isTarget: (u) => u.endsWith('/api/v1/admin/forwardauth-cookie'),
    real: observabilityDeploy(),
    run: (f) => observability(f, 'grafana_health'),
  },
  {
    label: 'prometheus_targets',
    covers: ['feature-observability.ts:checkPrometheusTargets'],
    isTarget: (u) => u.includes('/api/datasources/proxy/uid/prometheus/'),
    real: observabilityDeploy(),
    run: (f) => observability(f, 'prometheus_targets'),
  },
];

/** The same deploy, with the target endpoint replaced by `hollow`. */
function hollowAt(entry: Entry, hollow: () => Response): Fetcher {
  return async (url, init) => (entry.isTarget(url, init) ? hollow() : entry.real(url, init));
}

describe('BEHAVIOUR: every HTTP check passes on real content and fails on hollow responses', () => {
  describe.each(MATRIX)('$label', (entry) => {
    it('passes against the healthy deploy (the fakes are real enough to pass)', async () => {
      const r = await entry.run(entry.real);
      expect(r.status, r.errorMessage).toBe('pass');
    });

    const hollows = (Object.keys(HOLLOW) as HollowName[]).filter((h) => !entry.hollowIsReal?.[h]);
    it.each(hollows)('fails when the target answers: %s', async (hollow) => {
      const r = await entry.run(hollowAt(entry, HOLLOW[hollow]));
      expect(r.status, `${entry.label} returned ${r.status} on ${hollow}`).toBe('fail');
    });
  });
});

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/**
 * Functions that call an HTTP seam but produce no verdict of their own, or
 * whose verdict is pinned elsewhere. Each says why.
 */
const EXEMPT: Record<string, string> = {
  'health.ts:dnsSafeFetch': 'the pinned transport itself; every entry above runs through its seam',
  'health.ts:waitForAppServing':
    'readiness gate (returns ok/attempts, never a VerificationResult); the frontend render check after it is the verdict',
  'health.ts:measureHealthLatencies': 'latency percentiles only, no verdict',
  'app-functional.ts:safeFetch': 'transport wrapper around dnsSafeFetch',
  'app-functional.ts:checkFileUploadRoundtrip':
    'asserts the uploaded bytes come back byte-for-byte; every leg (presign JSON shape, CSP, CORS, 302, bytes) is pinned in file-upload-roundtrip.test.ts',
  'feature-observability.ts:defaultFetcher': 'transport wrapper around dnsSafeFetch',
};

/** A call through the pinned transport or an injected fetcher. */
const HTTP_SEAM = /\b(?:dnsSafeFetch|fetcher|fetchFn|fetchImpl|appFetch|safeFetch)\s*\(/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Top-level functions of a formatted module: from `function name(` to the
 * first column-0 `}` line (biome indents every body).
 */
function topLevelFunctions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/.exec(lines[i]);
    if (!m) continue;
    let end = i;
    while (end < lines.length && lines[end] !== '}') end++;
    out.push({ name: m[1], body: lines.slice(i, end + 1).join('\n') });
    i = end;
  }
  return out;
}

function checkModules(): { file: string; src: string }[] {
  return readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, src: readFileSync(join(CHECKS_DIR, f), 'utf-8') }));
}

describe('CENSUS: every HTTP-calling check function is classified', () => {
  const modules = checkModules();
  const functionsByKey = new Map<string, string>();
  for (const { file, src } of modules) {
    for (const fn of topLevelFunctions(stripComments(src))) {
      functionsByKey.set(`${file}:${fn.name}`, fn.body);
    }
  }
  const httpCallers = [...functionsByKey]
    .filter(([, body]) => HTTP_SEAM.test(body))
    .map(([key]) => key);
  const covered = new Set(MATRIX.flatMap((e) => e.covers));

  it('the census actually found the HTTP checks', () => {
    // Guards the walker: a parsing change that finds nothing must fail here
    // rather than make every assertion below vacuous.
    expect(httpCallers).toEqual(
      expect.arrayContaining([
        'health.ts:checkApiHealth',
        'app-api.ts:checkRoute',
        'feature-observability.ts:checkGrafanaRouteProtected',
      ]),
    );
  });

  it.each(httpCallers)('%s is in the behaviour matrix or exempt with a reason', (key) => {
    expect(
      covered.has(key) || key in EXEMPT,
      `${key} calls an HTTP seam but is not classified. Add it to MATRIX (real content passes, ` +
        'every hollow shape fails) or to EXEMPT with the reason it produces no verdict.',
    ).toBe(true);
  });

  it('every classified name still exists (no stale entries)', () => {
    for (const key of [...covered, ...Object.keys(EXEMPT)]) {
      expect(functionsByKey.has(key), `${key} no longer exists in tests/e2e/checks`).toBe(true);
    }
  });

  it('no check keeps a hollow-pass note', () => {
    // The verbatim notes of the old hollow branches. A pass must cite the
    // content it read, never the absence of it.
    const HOLLOW_NOTES =
      /HTML response \(auth page\)|behind auth middleware \(expected\)|any response proves/i;
    for (const { file, src } of modules) {
      expect(HOLLOW_NOTES.test(stripComments(src)), `${file} carries a hollow-pass note`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// HA integrity: a missing SSH handle (or DNS reader) fails, never passes
// ---------------------------------------------------------------------------

/** A runner that must never be reached: a check with no handle has no way in. */
const unreachable: haIntegrity.RemoteRun = async () => {
  throw new Error('the check reached the remote without a handle');
};
const sshless = { mode: 'compose-ha' as const, projectName: 'demo', run: unreachable };
const KEY = '/tmp/key';
const NODE = '203.0.113.10';

/** Each HA integrity check, run with each half of its handle missing. */
const HA_HANDLELESS: Record<
  string,
  Array<() => Promise<VerificationResult> | VerificationResult>
> = {
  checkOldPrimaryDisarmed: [
    () => haIntegrity.checkOldPrimaryDisarmed({ ...sshless, retiredIp: NODE, sshKeyPath: null }),
    () => haIntegrity.checkOldPrimaryDisarmed({ ...sshless, retiredIp: null, sshKeyPath: KEY }),
  ],
  checkPrimaryNotRestarted: [
    async () =>
      haIntegrity.checkPrimaryNotRestarted({
        ip: NODE,
        before: await haIntegrity.readDbIncarnation({ ...sshless, ip: NODE, sshKeyPath: null }),
        after: await haIntegrity.readDbIncarnation({ ...sshless, ip: NODE, sshKeyPath: null }),
      }),
    async () =>
      haIntegrity.checkPrimaryNotRestarted({
        ip: null,
        before: await haIntegrity.readDbIncarnation({ ...sshless, ip: null, sshKeyPath: KEY }),
        after: await haIntegrity.readDbIncarnation({ ...sshless, ip: null, sshKeyPath: KEY }),
      }),
  ],
  checkSlotCapped: [
    () => haIntegrity.checkSlotCapped({ ...sshless, primaryIp: NODE, sshKeyPath: null }),
    () => haIntegrity.checkSlotCapped({ ...sshless, primaryIp: null, sshKeyPath: KEY }),
  ],
  checkAppEndpointsReady: [
    () =>
      haIntegrity.checkAppEndpointsReady({ primaryIp: NODE, sshKeyPath: null, run: unreachable }),
    () =>
      haIntegrity.checkAppEndpointsReady({ primaryIp: null, sshKeyPath: KEY, run: unreachable }),
  ],
  checkDnsFlipVerified: [
    () =>
      haIntegrity.checkDnsFlipVerified({
        domain: D,
        expectedIp: NODE,
        readA: null,
        readerError: 'HCLOUD_TOKEN is not set',
      }),
    () =>
      haIntegrity.checkDnsFlipVerified({
        domain: D,
        expectedIp: null,
        readA: async () => [NODE],
      }),
  ],
  checkSecondFailoverRefused: [
    // No handle to lose: its hollow shape is a non-zero exit for another reason.
    () =>
      haIntegrity.checkSecondFailoverRefused({
        exitCode: 255,
        output: 'ssh: connect to host port 22: Connection timed out',
        rolesBefore: { primaryIp: NODE, standbyIp: null },
        rolesAfter: { primaryIp: NODE, standbyIp: null },
      }),
  ],
};

describe('HA INTEGRITY: every check fails without its handle', () => {
  const cases = Object.entries(HA_HANDLELESS).flatMap(([name, runs]) =>
    runs.map((run, i) => [`${name} #${i + 1}`, run] as const),
  );

  it.each(cases)('%s fails', async (_label, run) => {
    const r = await run();
    expect(r.status, r.errorMessage).toBe('fail');
  });

  it('every exported check in ha-integrity.ts is registered', () => {
    const exported = Object.keys(haIntegrity).filter((k) => /^check[A-Z]/.test(k));
    expect(exported.length).toBeGreaterThanOrEqual(6);
    expect(exported.sort()).toEqual(Object.keys(HA_HANDLELESS).sort());
  });
});

// ---------------------------------------------------------------------------
// Standby add-ons: a missing handle fails, only "no add-on enabled" skips
// ---------------------------------------------------------------------------

const ADDON_FEATURES = ['n8n', 'metabase'];
const addonBase = { ...sshless, features: ADDON_FEATURES };
const unread = { ok: false as const, error: 'unread' };

const ADDON_HANDLELESS: Record<
  string,
  Array<() => Promise<VerificationResult> | VerificationResult>
> = {
  checkStandbyPrimaryOnlyAbsent: [
    () =>
      standbyAddons.checkStandbyPrimaryOnlyAbsent({
        ...addonBase,
        standbyIp: NODE,
        sshKeyPath: null,
      }),
    () =>
      standbyAddons.checkStandbyPrimaryOnlyAbsent({
        ...addonBase,
        standbyIp: null,
        sshKeyPath: KEY,
      }),
  ],
  checkPromotedPrimaryOnlyRunning: [
    () =>
      standbyAddons.checkPromotedPrimaryOnlyRunning({
        ...addonBase,
        primaryIp: NODE,
        sshKeyPath: null,
      }),
    () =>
      standbyAddons.checkPromotedPrimaryOnlyRunning({
        ...addonBase,
        primaryIp: null,
        sshKeyPath: KEY,
      }),
  ],
  checkPromotedDbNotRecreated: [
    () =>
      standbyAddons.checkPromotedDbNotRecreated({
        features: ADDON_FEATURES,
        ip: NODE,
        before: unread,
        after: unread,
      }),
  ],
  checkN8nKeyShared: [
    () =>
      standbyAddons.checkN8nKeyShared({
        ...addonBase,
        primaryIp: NODE,
        standbyIp: NODE,
        sshKeyPath: null,
      }),
    () =>
      standbyAddons.checkN8nKeyShared({
        ...addonBase,
        primaryIp: NODE,
        standbyIp: null,
        sshKeyPath: KEY,
      }),
  ],
  checkPromotedAddonsReady: [
    () =>
      standbyAddons.checkPromotedAddonsReady({
        ...addonBase,
        mode: 'k8s-ha',
        primaryIp: NODE,
        sshKeyPath: null,
      }),
    () =>
      standbyAddons.checkPromotedAddonsReady({
        ...addonBase,
        mode: 'k8s-ha',
        primaryIp: null,
        sshKeyPath: KEY,
      }),
  ],
};

describe('STANDBY ADD-ONS: every check fails without its handle', () => {
  const cases = Object.entries(ADDON_HANDLELESS).flatMap(([name, runs]) =>
    runs.map((run, i) => [`${name} #${i + 1}`, run] as const),
  );

  it.each(cases)('%s fails', async (_label, run) => {
    const r = await run();
    expect(r.status, r.errorMessage).toBe('fail');
  });

  it('every exported check in standby-addons.ts is registered', () => {
    const exported = Object.keys(standbyAddons).filter((k) => /^check[A-Z]/.test(k));
    expect(exported.sort()).toEqual(Object.keys(ADDON_HANDLELESS).sort());
  });
});

// ---------------------------------------------------------------------------
// TLS reuse: a missing baseline or an unread certificate fails, never passes
// ---------------------------------------------------------------------------

const TLS_REUSE_HANDLELESS: Record<
  string,
  Array<() => Promise<VerificationResult> | VerificationResult>
> = {
  checkTlsReused: [
    () =>
      tlsReuse.checkTlsReused('', D, {
        readServed: async () => {
          throw new Error('the check read the served certificate without a baseline');
        },
      }),
    () =>
      tlsReuse.checkTlsReused('04A1B2', D, {
        readServed: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
  ],
  checkNoNewCertificateRequest: [
    () => tlsReuse.checkNoNewCertificateRequest({ before: null, after: [], where: 'e3' }),
    () => tlsReuse.checkNoNewCertificateRequest({ before: [], after: null, where: 'e3' }),
  ],
};

describe('TLS REUSE: every check fails without its baseline', () => {
  const cases = Object.entries(TLS_REUSE_HANDLELESS).flatMap(([name, runs]) =>
    runs.map((run, i) => [`${name} #${i + 1}`, run] as const),
  );

  it.each(cases)('%s fails', async (_label, run) => {
    const r = await run();
    expect(r.status, r.errorMessage).toBe('fail');
  });

  it('every exported check in tls-reuse.ts is registered', () => {
    const exported = Object.keys(tlsReuse).filter((k) => /^check[A-Z]/.test(k));
    expect(exported.sort()).toEqual(Object.keys(TLS_REUSE_HANDLELESS).sort());
  });
});

// ---------------------------------------------------------------------------
// Deploy budget: a log without the markers fails, never passes
// ---------------------------------------------------------------------------

const DEPLOY_BUDGET_MARKERLESS: Record<string, Array<() => VerificationResult>> = {
  checkDeployBudget: (['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const).flatMap((mode) => [
    () => deployBudget.checkDeployBudget('', mode),
    () =>
      deployBudget.checkDeployBudget(
        '◆  Deployment to e1 complete! (1m 2s)\n[perf] deploy.iac.upStack 1000ms',
        mode,
      ),
  ]),
};

describe('DEPLOY BUDGET: every check fails on a log without its markers', () => {
  const cases = Object.entries(DEPLOY_BUDGET_MARKERLESS).flatMap(([name, runs]) =>
    runs.map((run, i) => [`${name} #${i + 1}`, run] as const),
  );

  it.each(cases)('%s fails', (_label, run) => {
    const r = run();
    expect(r.status, r.errorMessage).toBe('fail');
  });

  it('every exported check in deploy-budget.ts is registered', () => {
    const exported = Object.keys(deployBudget).filter((k) => /^check[A-Z]/.test(k));
    expect(exported.sort()).toEqual(Object.keys(DEPLOY_BUDGET_MARKERLESS).sort());
  });
});
