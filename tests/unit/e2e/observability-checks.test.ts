/**
 * The observability checks (grafana_route_protected, grafana_health,
 * prometheus_targets) driven by a faked fetch.
 *
 * RCA 2026-10-19 (tests/results/e2e.db): every historical pass was hollow. k8s
 * probed `/grafana/api/health` (the real route is `/admin/grafana`) and passed
 * on the app's SPA page, `{"statusCode":200,"note":"HTML response (auth
 * page)"}`; compose passed on the ForwardAuth 401. These tests pin the
 * rewrite: only Grafana's and Prometheus' own JSON, read as the super admin
 * through the minted vc-admin-token cookie, is a pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { CookieJar } from '../../e2e/checks/app-functional.js';
import {
  FORWARDAUTH_COOKIE,
  grafanaBaseUrl,
  runObservabilityChecks,
} from '../../e2e/checks/feature-observability.js';
import type { VerificationResult } from '../../e2e/scenarios/types.js';

const APP = 'app.example.com';
const K8S_BASE = `https://${APP}/admin/grafana`;
const COMPOSE_BASE = `https://grafana.${APP}`;
const TOKEN = 'minted-forwardauth-token';

const SPA_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const html = (status: number) =>
  new Response(SPA_HTML, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const unauthorized = () =>
  new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
const minted = () => {
  const headers = new Headers();
  headers.append(
    'set-cookie',
    `${FORWARDAUTH_COOKIE}=${TOKEN}; Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
  );
  return new Response(null, { status: 204, headers });
};

const GRAFANA_HEALTH = { commit: 'abc', database: 'ok', version: '13.2.4' };
const PROM_TARGETS = {
  status: 'success',
  data: {
    activeTargets: [
      { scrapePool: 'prometheus', labels: { job: 'prometheus' }, health: 'up' },
      { scrapePool: 'app', labels: { job: 'app' }, health: 'down' },
    ],
    droppedTargets: [],
  },
};

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function hasCookie(init?: RequestInit): boolean {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return Boolean(h.Cookie);
}

/**
 * A deployed environment. `grafana` answers Grafana's paths (authed or not),
 * `mint` the cookie route. Defaults are the real, healthy deploy.
 */
function environment(
  base: string,
  overrides: {
    unauthed?: Handler;
    health?: Handler;
    targets?: Handler;
    mint?: Handler;
  } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === `https://${APP}/api/v1/admin/forwardauth-cookie`) {
      return (overrides.mint ?? minted)(init);
    }
    if (!hasCookie(init)) return (overrides.unauthed ?? unauthorized)(init);
    const cookie = ((init?.headers ?? {}) as Record<string, string>).Cookie;
    if (cookie !== `${FORWARDAUTH_COOKIE}=${TOKEN}`) return unauthorized();
    if (url === `${base}/api/health`)
      return (overrides.health ?? (() => json(GRAFANA_HEALTH)))(init);
    if (url === `${base}/api/datasources/proxy/uid/prometheus/api/v1/targets`) {
      return (overrides.targets ?? (() => json(PROM_TARGETS)))(init);
    }
    return html(404);
  });
  return { fetcher, calls };
}

function adminJar(): CookieJar {
  const jar = new CookieJar();
  const headers = new Headers();
  headers.append('set-cookie', '__Secure-better-auth.session_token=sess; Path=/; HttpOnly');
  jar.absorb(new Response('{}', { headers }));
  return jar;
}

function byName(results: VerificationResult[]): Record<string, VerificationResult> {
  return Object.fromEntries(results.map((r) => [r.checkName, r]));
}

async function run(
  env: ReturnType<typeof environment>,
  opts: { isCompose?: boolean; jar?: CookieJar | null } = {},
) {
  const results = await runObservabilityChecks({
    appDomain: APP,
    isCompose: opts.isCompose ?? false,
    adminJar: opts.jar === null ? undefined : (opts.jar ?? adminJar()),
    fetcher: env.fetcher,
    sleep: async () => {},
    attempts: 3,
    retryDelayMs: 0,
  });
  return byName(results);
}

describe('grafanaBaseUrl', () => {
  it('is the /admin/grafana prefix on the apex for k8s (the IngressRoute PathPrefix)', () => {
    expect(grafanaBaseUrl(APP, false)).toBe(K8S_BASE);
  });

  it('is the grafana subdomain for compose (the Host router)', () => {
    expect(grafanaBaseUrl(APP, true)).toBe(COMPOSE_BASE);
  });
});

describe('runObservabilityChecks against a healthy deploy', () => {
  it('passes all three checks on k8s', async () => {
    const r = await run(environment(K8S_BASE));
    expect(r.grafana_route_protected.status).toBe('pass');
    expect(r.grafana_health.status).toBe('pass');
    expect(r.prometheus_targets.status).toBe('pass');
    expect(r.prometheus_targets.details).toMatchObject({ activeTargets: 2, up: 1 });
  });

  it('passes all three checks on compose, at the grafana subdomain', async () => {
    const env = environment(COMPOSE_BASE);
    const r = await run(env, { isCompose: true });
    expect(Object.values(r).map((x) => x.status)).toEqual(['pass', 'pass', 'pass']);
    expect(env.calls.map((c) => c.url)).toEqual([
      `${COMPOSE_BASE}/api/health`,
      `https://${APP}/api/v1/admin/forwardauth-cookie`,
      `${COMPOSE_BASE}/api/health`,
      `${COMPOSE_BASE}/api/datasources/proxy/uid/prometheus/api/v1/targets`,
    ]);
  });

  it('mints the cookie with the admin session and a same-origin Origin', async () => {
    const env = environment(K8S_BASE);
    await run(env);
    const mint = env.calls.find((c) => c.url.endsWith('/api/v1/admin/forwardauth-cookie'));
    expect(mint?.init?.method).toBe('POST');
    const h = mint?.init?.headers as Record<string, string>;
    expect(h.Cookie).toBe('__Secure-better-auth.session_token=sess');
    expect(h.Origin).toBe(`https://${APP}`);
  });

  it('sends Grafana only the ForwardAuth cookie, never the app session cookie', async () => {
    const env = environment(K8S_BASE);
    await run(env);
    const grafanaAuthed = env.calls.filter((c) => c.url.startsWith(K8S_BASE) && hasCookie(c.init));
    expect(grafanaAuthed).toHaveLength(2);
    for (const c of grafanaAuthed) {
      expect(((c.init?.headers ?? {}) as Record<string, string>).Cookie).toBe(
        `${FORWARDAUTH_COOKIE}=${TOKEN}`,
      );
    }
  });

  it('probes the route without any cookie first', async () => {
    const env = environment(K8S_BASE);
    await run(env);
    expect(env.calls[0].url).toBe(`${K8S_BASE}/api/health`);
    expect(hasCookie(env.calls[0].init)).toBe(false);
  });
});

describe('runObservabilityChecks never passes on hollow responses', () => {
  it('fails every check when the app SPA answers 200 HTML at the Grafana path (the historical k8s pass)', async () => {
    const spa200 = () => html(200);
    const r = await run(
      environment(K8S_BASE, { unauthed: spa200, health: spa200, targets: spa200 }),
    );
    expect(r.grafana_route_protected.status).toBe('fail');
    expect(r.grafana_health.status).toBe('fail');
    expect(r.grafana_health.errorMessage).toMatch(/not JSON/);
    expect(r.prometheus_targets.status).toBe('fail');
  });

  it("fails every check when the path is the app's 404 (tonight's k8s-ha shape)", async () => {
    const spa404 = () => html(404);
    const r = await run(
      environment(K8S_BASE, { unauthed: spa404, health: spa404, targets: spa404 }),
    );
    expect(r.grafana_route_protected.status).toBe('fail');
    expect(r.grafana_route_protected.errorMessage).toMatch(/nothing routes it to Grafana/);
    expect(r.grafana_health.status).toBe('fail');
    expect(r.prometheus_targets.status).toBe('fail');
  });

  it('fails grafana_health and prometheus_targets when ForwardAuth refuses the cookie (the historical compose pass)', async () => {
    const r = await run(
      environment(COMPOSE_BASE, { health: unauthorized, targets: unauthorized }),
      { isCompose: true },
    );
    expect(r.grafana_route_protected.status).toBe('pass');
    expect(r.grafana_health.status).toBe('fail');
    expect(r.prometheus_targets.status).toBe('fail');
  });

  it('does not retry an auth refusal', async () => {
    const health = vi.fn(unauthorized);
    await run(environment(K8S_BASE, { health }));
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('fails grafana_health when Grafana reports its database is not ok', async () => {
    const r = await run(environment(K8S_BASE, { health: () => json({ database: 'failing' }) }));
    expect(r.grafana_health.status).toBe('fail');
    expect(r.grafana_health.errorMessage).toMatch(/database=failing/);
  });

  it('fails prometheus_targets when no active target is up', async () => {
    const down = {
      status: 'success',
      data: { activeTargets: [{ scrapePool: 'app', health: 'down' }] },
    };
    const r = await run(environment(K8S_BASE, { targets: () => json(down) }));
    expect(r.prometheus_targets.status).toBe('fail');
    expect(r.prometheus_targets.errorMessage).toMatch(/no active target is up \(app=down\)/);
  });

  it('fails prometheus_targets when Prometheus has no active targets', async () => {
    const empty = { status: 'success', data: { activeTargets: [] } };
    const r = await run(environment(K8S_BASE, { targets: () => json(empty) }));
    expect(r.prometheus_targets.status).toBe('fail');
  });

  it('fails prometheus_targets on JSON that is not a Prometheus targets response', async () => {
    const r = await run(environment(K8S_BASE, { targets: () => json({ message: 'ok' }) }));
    expect(r.prometheus_targets.status).toBe('fail');
  });

  it('fails grafana_health when the fetch throws on every attempt', async () => {
    const r = await run(
      environment(K8S_BASE, {
        health: () => {
          throw new Error('ECONNRESET');
        },
      }),
    );
    expect(r.grafana_health.status).toBe('fail');
    expect(r.grafana_health.errorMessage).toMatch(/ECONNRESET/);
  });
});

describe('grafana_route_protected', () => {
  it("passes on verify-role's redirect to the app's /login", async () => {
    const redirect = () =>
      new Response(null, {
        status: 302,
        headers: {
          location: `https://${APP}/login?redirect=https%3A%2F%2F${APP}%2Fadmin%2Fgrafana`,
        },
      });
    const r = await run(environment(K8S_BASE, { unauthed: redirect }));
    expect(r.grafana_route_protected.status).toBe('pass');
  });

  it('fails on a redirect anywhere but the app login', async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: `${K8S_BASE}/login` } });
    const r = await run(environment(K8S_BASE, { unauthed: redirect }));
    expect(r.grafana_route_protected.status).toBe('fail');
  });

  it('fails when Grafana serves its health without a cookie', async () => {
    const r = await run(environment(K8S_BASE, { unauthed: () => json(GRAFANA_HEALTH) }));
    expect(r.grafana_route_protected.status).toBe('fail');
    expect(r.grafana_route_protected.errorMessage).toMatch(/not behind ForwardAuth/);
  });
});

describe('the ForwardAuth cookie', () => {
  it('fails both authed checks (not skip) when the mint is refused, naming the aal2 case', async () => {
    const env = environment(K8S_BASE, {
      mint: () => json({ error: 'Two-factor authentication required' }, 403),
    });
    const r = await run(env);
    expect(r.grafana_health.status).toBe('fail');
    expect(r.prometheus_targets.status).toBe('fail');
    expect(r.grafana_health.errorMessage).toMatch(/MFA is globally on/);
    expect(env.calls.filter((c) => hasCookie(c.init) && c.url.startsWith(K8S_BASE))).toEqual([]);
  });

  it('fails when the mint answers 204 without setting the cookie', async () => {
    const r = await run(environment(K8S_BASE, { mint: () => new Response(null, { status: 204 }) }));
    expect(r.grafana_health.status).toBe('fail');
    expect(r.grafana_health.errorMessage).toMatch(/without a vc-admin-token cookie/);
  });

  it('skips the authed checks (never passes) without an admin session, but still probes the route', async () => {
    const env = environment(K8S_BASE);
    const r = await run(env, { jar: null });
    expect(r.grafana_route_protected.status).toBe('pass');
    expect(r.grafana_health.status).toBe('skip');
    expect(r.prometheus_targets.status).toBe('skip');
    expect(env.calls).toHaveLength(1);
  });
});

describe('retries', () => {
  it('passes once Grafana stops answering 502 while it warms up', async () => {
    let n = 0;
    const r = await run(
      environment(K8S_BASE, {
        health: () =>
          ++n === 1 ? new Response('Bad Gateway', { status: 502 }) : json(GRAFANA_HEALTH),
      }),
    );
    expect(r.grafana_health.status).toBe('pass');
    expect(r.grafana_health.details).toMatchObject({ attempts: 2 });
  });
});
