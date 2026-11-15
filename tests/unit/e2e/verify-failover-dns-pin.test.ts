/**
 * verify-failover DNS resolution pin + `dns_failover_flip`.
 *
 * LIVE RCA (hetzner/compose-ha, 2026-08-11, evidence-verified on the kept rig).
 * compose-ha failover repoints the environment by rewriting the apex + wildcard
 * A records. DNS-based failover inherently leaves clients on the OLD address
 * until their cached record expires — docs/rto-rpo.md bounds that tail by "the
 * 60s record TTL the failover flip writes" and counts it as part of the
 * published RTO, not as a deployment fault.
 *
 * The verifier was grading the deployment on that tail. Its checks resolved
 * through the operator's resolver chain, which was caught MID-TTL: the battery
 * SPLIT. auth_health / auth_signup / rest_api got a fresh answer, reached the
 * promoted node and passed; spa_auth_callback (404 "swallowed by the gateway"),
 * auth_signin + auth_admin_login (10s timeouts), db_schema (unqueryable) and
 * storage_upload (503 `{"message":"name resolution failed"}` — the retired
 * node's gateway failing to resolve its own stopped upstreams) got the stale
 * answer and hit the DEMOTED node. None of the failing request ids appeared in
 * the promoted node's gateway access log; everything healed at TTL expiry.
 *
 * The fix splits the verifier's job in two, and this file guards both halves:
 *   1. SERVING — pinned checks dial the promoted node directly while keeping
 *      the domain as Host + TLS SNI, so name-based routing and certificate
 *      validity are still fully exercised.
 *   2. PUBLISHING — `dns_failover_flip` queries the zone's AUTHORITATIVE
 *      nameservers (never the OS resolver, never a cache) and asserts the
 *      record actually moved.
 *
 * Neither half measures how long the operator's ISP cache holds a record.
 *
 * The last describe block is the FAMILY guard: a census that walks the check
 * registration for the failover step and fails if any HTTP check there can
 * reach the environment by a path the pin does not cover.
 */

import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../config.js';
import {
  type AuthoritativeDeps,
  DNS_FLIP_CHECK_NAME,
  resolveAuthoritativeA,
  runDnsFailoverFlipCheck,
  zoneCandidates,
} from '../../e2e/checks/dns-flip.js';
import { dnsSafeFetch, resolveCheckIp, waitForDnsToPoint } from '../../e2e/checks/health.js';
import {
  chromeHostResolverRules,
  currentResolutionPin,
  failoverFlipsRecord,
  pinMatchesHost,
  pinnedIpFor,
  postFailoverResolutionPin,
  type ResolutionPin,
  withResolutionPin,
} from '../../e2e/utils/dns-pin.js';

const DOMAIN = 'e2-h1-abc.appcarbon.dev';
const PROMOTED_IP = '5.75.213.9';
const RETIRED_IP = '128.140.7.4';
const PIN: ResolutionPin = {
  domain: DOMAIN,
  ip: PROMOTED_IP,
  reason: 'verify-failover: promoted primary for e2',
};

const noSleep = () => Promise.resolve();

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

/** Drop line and block comments so source censuses match CODE, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// 1. The pin primitive
// ---------------------------------------------------------------------------

describe('resolution pin scoping', () => {
  it('is inactive outside any pinned scope', () => {
    expect(currentResolutionPin()).toBeNull();
    expect(pinnedIpFor(DOMAIN)).toBeNull();
    expect(chromeHostResolverRules(DOMAIN)).toBeNull();
  });

  it('pins the apex and every subdomain (the flip writes apex + wildcard)', async () => {
    await withResolutionPin(PIN, async () => {
      expect(pinnedIpFor(DOMAIN)).toBe(PROMOTED_IP);
      expect(pinnedIpFor(`grafana.${DOMAIN}`)).toBe(PROMOTED_IP);
      expect(pinnedIpFor(DOMAIN.toUpperCase())).toBe(PROMOTED_IP);
      expect(pinnedIpFor(`${DOMAIN}.`)).toBe(PROMOTED_IP);
    });
  });

  it('never broadens: an unrelated host still resolves normally', async () => {
    await withResolutionPin(PIN, async () => {
      expect(pinnedIpFor('registry-1.docker.io')).toBeNull();
      // Suffix collision must not count as a subdomain.
      expect(pinnedIpFor(`evil-${DOMAIN}`)).toBeNull();
      expect(pinMatchesHost(PIN, 'appcarbon.dev')).toBe(false);
    });
  });

  it('does not leak past the scope that entered it', async () => {
    await withResolutionPin(PIN, async () => {
      expect(currentResolutionPin()).not.toBeNull();
    });
    expect(currentResolutionPin()).toBeNull();
  });

  it('a null pin runs the body unchanged (callers branch-free)', async () => {
    const seen = await withResolutionPin(null, async () => currentResolutionPin());
    expect(seen).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The resolution seam
// ---------------------------------------------------------------------------

describe('resolveCheckIp', () => {
  it('returns the pinned IP without consulting any resolver', async () => {
    const fallback = vi.fn(async () => RETIRED_IP);
    const ip = await withResolutionPin(PIN, () => resolveCheckIp(DOMAIN, fallback));
    expect(ip).toBe(PROMOTED_IP);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls through to the public resolver when unpinned', async () => {
    const fallback = vi.fn(async () => RETIRED_IP);
    expect(await resolveCheckIp(DOMAIN, fallback)).toBe(RETIRED_IP);
    expect(fallback).toHaveBeenCalledWith(DOMAIN);
  });

  it('falls through for hosts the pin does not cover', async () => {
    const fallback = vi.fn(async () => '1.2.3.4');
    const ip = await withResolutionPin(PIN, () => resolveCheckIp('other.dev', fallback));
    expect(ip).toBe('1.2.3.4');
  });
});

// ---------------------------------------------------------------------------
// 3. The transport: pinned address, domain SNI
// ---------------------------------------------------------------------------

interface CapturedRequest {
  hostname?: string;
  servername?: string;
  path?: string;
  headers?: Record<string, string>;
  rejectUnauthorized?: boolean;
}

/** Stub for `https.request` — captures the options and replies 200 "ok". */
function stubHttps(captured: CapturedRequest[]) {
  return ((options: CapturedRequest, cb: (res: unknown) => void) => {
    captured.push(options);
    const res = new PassThrough() as PassThrough & {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string>;
    };
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headers = {};
    setImmediate(() => {
      cb(res);
      res.end('ok');
    });
    const req = {
      on: () => req,
      write: () => {},
      end: () => {},
      destroy: () => {},
    };
    return req;
    // biome-ignore lint/suspicious/noExplicitAny: narrow stub for an injected seam
  }) as any;
}

describe('dnsSafeFetch under a pin', () => {
  it('dials the pinned IP but keeps the domain as Host and TLS SNI', async () => {
    const captured: CapturedRequest[] = [];
    const res = await withResolutionPin(PIN, () =>
      dnsSafeFetch(
        `https://${DOMAIN}/api/auth/ok`,
        { headers: { Cookie: 'session=abc' } },
        { httpsRequest: stubHttps(captured) },
      ),
    );

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const opts = captured[0];
    // The address is the promoted node...
    expect(opts.hostname).toBe(PROMOTED_IP);
    // ...but the request still identifies itself as the DOMAIN, so the node
    // must route by name and present a certificate valid for the domain.
    expect(opts.servername).toBe(DOMAIN);
    expect(opts.headers?.Host).toBe(DOMAIN);
    expect(opts.headers?.Cookie).toBe('session=abc');
    expect(opts.path).toBe('/api/auth/ok');
  });

  it('pins subdomain checks too (grafana./add-on hosts follow the wildcard)', async () => {
    const captured: CapturedRequest[] = [];
    await withResolutionPin(PIN, () =>
      dnsSafeFetch(`https://grafana.${DOMAIN}/api/health`, undefined, {
        httpsRequest: stubHttps(captured),
      }),
    );
    expect(captured[0].hostname).toBe(PROMOTED_IP);
    expect(captured[0].servername).toBe(`grafana.${DOMAIN}`);
    expect(captured[0].headers?.Host).toBe(`grafana.${DOMAIN}`);
  });

  it('unpinned, it dials whatever the public resolver returned', async () => {
    const captured: CapturedRequest[] = [];
    await dnsSafeFetch(`https://${DOMAIN}/api/health`, undefined, {
      resolveIp: async () => RETIRED_IP,
      httpsRequest: stubHttps(captured),
    });
    expect(captured[0].hostname).toBe(RETIRED_IP);
    expect(captured[0].servername).toBe(DOMAIN);
  });
});

describe('chromeHostResolverRules', () => {
  it('maps the apex and the wildcard for the browser check', async () => {
    const rules = await withResolutionPin(PIN, async () => chromeHostResolverRules(DOMAIN));
    expect(rules).toBe(`MAP ${DOMAIN} ${PROMOTED_IP},MAP *.${DOMAIN} ${PROMOTED_IP}`);
  });

  it('is null when unpinned, leaving the browser on the OS resolver', () => {
    expect(chromeHostResolverRules(DOMAIN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The propagation gate must stay UNPINNED
// ---------------------------------------------------------------------------

describe('waitForDnsToPoint is deliberately not pin-aware', () => {
  it('still observes real answers inside a pinned scope', async () => {
    // If its default resolver were pin-aware this would return true on the
    // first tick without a single real DNS answer — a false green that would
    // also silently delete the propagation-tail evidence docs/rto-rpo.md cites.
    const answers = [RETIRED_IP, RETIRED_IP, PROMOTED_IP];
    const resolve = vi.fn(async () => answers.shift() ?? PROMOTED_IP);
    const ok = await withResolutionPin(PIN, () =>
      waitForDnsToPoint(DOMAIN, PROMOTED_IP, {
        budgetMs: 10_000,
        intervalMs: 1,
        resolve,
        sleep: noSleep,
      }),
    );
    expect(ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('defaults to resolvePublicIp, never resolveCheckIp', () => {
    const src = read('tests/e2e/checks/health.ts');
    expect(src).toContain('resolve = resolvePublicIp,');
    expect(src).not.toContain('resolve = resolveCheckIp,');
  });
});

// ---------------------------------------------------------------------------
// 5. dns_failover_flip
// ---------------------------------------------------------------------------

describe('zoneCandidates', () => {
  it('walks most-specific-first down to the registrable name', () => {
    expect(zoneCandidates('e2-h1-abc.appcarbon.dev')).toEqual([
      'e2-h1-abc.appcarbon.dev',
      'appcarbon.dev',
    ]);
    expect(zoneCandidates('a.b.c.example.dev')).toEqual([
      'a.b.c.example.dev',
      'b.c.example.dev',
      'c.example.dev',
      'example.dev',
    ]);
  });
});

function authDeps(over: Partial<AuthoritativeDeps>): Partial<AuthoritativeDeps> {
  return over;
}

describe('resolveAuthoritativeA', () => {
  const NS_HOSTS = ['ns1.first-ns.de', 'ns2.second-ns.io'];

  it('walks up to the real zone cut and queries its nameservers directly', async () => {
    const nsQueried: string[] = [];
    const answer = await resolveAuthoritativeA(
      DOMAIN,
      authDeps({
        ns: async (zone) => {
          nsQueried.push(zone);
          if (zone === 'appcarbon.dev') return NS_HOSTS;
          throw new Error('NXDOMAIN');
        },
        nsAddrs: async (host) => (host === NS_HOSTS[0] ? ['193.47.99.3'] : ['213.239.242.238']),
        a: async (_d, servers) => (servers.includes('193.47.99.3') ? [PROMOTED_IP] : []),
      }),
    );
    // The environment domain is a RECORD inside a wider zone, so the walk must
    // start at the full name and step up — not assume a registrable-name zone.
    expect(nsQueried).toEqual([DOMAIN, 'appcarbon.dev']);
    expect(answer).toMatchObject({
      ips: [PROMOTED_IP],
      zone: 'appcarbon.dev',
      nameservers: NS_HOSTS,
      source: 'authoritative',
    });
  });

  it('tolerates one unreachable nameserver', async () => {
    const answer = await resolveAuthoritativeA(
      DOMAIN,
      authDeps({
        ns: async (zone) => (zone === 'appcarbon.dev' ? NS_HOSTS : Promise.reject(new Error('nx'))),
        nsAddrs: async (host) => {
          if (host === NS_HOSTS[0]) throw new Error('SERVFAIL');
          return ['213.239.242.238'];
        },
        a: async () => [PROMOTED_IP],
      }),
    );
    expect(answer.ips).toEqual([PROMOTED_IP]);
    expect(answer.source).toBe('authoritative');
  });

  it('labels a public-resolver fallback rather than passing it off as authoritative', async () => {
    const answer = await resolveAuthoritativeA(
      DOMAIN,
      authDeps({
        ns: async () => {
          throw new Error('no zone');
        },
        a: async () => [PROMOTED_IP],
      }),
    );
    expect(answer.source).toBe('public-resolver');
    expect(answer.zone).toBeNull();
    expect(answer.ips).toEqual([PROMOTED_IP]);
  });
});

describe('runDnsFailoverFlipCheck', () => {
  const authoritative = (ips: string[]) =>
    authDeps({
      ns: async (zone) => (zone === 'appcarbon.dev' ? ['ns1.first-ns.de'] : Promise.reject()),
      nsAddrs: async () => ['193.47.99.3'],
      a: async () => ips,
    });

  it('passes once the authoritative answer carries the promoted IP', async () => {
    const res = await runDnsFailoverFlipCheck({
      domain: DOMAIN,
      expectedIp: PROMOTED_IP,
      deps: authoritative([PROMOTED_IP]),
      sleep: noSleep,
    });
    expect(res.status).toBe('pass');
    expect(res.checkName).toBe(DNS_FLIP_CHECK_NAME);
    expect(res.details).toMatchObject({ source: 'authoritative', observed: [PROMOTED_IP] });
  });

  it('FAILS while the authoritative answer still carries the retired IP', async () => {
    // The mid-TTL split of 2026-08-11 must now be attributable: the serving
    // checks pass (pinned) while THIS one goes red, naming the unpublished flip.
    const res = await runDnsFailoverFlipCheck({
      domain: DOMAIN,
      expectedIp: PROMOTED_IP,
      budgetMs: 5,
      intervalMs: 1,
      deps: authoritative([RETIRED_IP]),
      sleep: noSleep,
    });
    expect(res.status).toBe('fail');
    expect(res.errorMessage).toContain(PROMOTED_IP);
    expect(res.errorMessage).toContain(RETIRED_IP);
    expect(res.errorMessage).toMatch(/authoritative/i);
  });

  it('keeps polling and passes on a flip that lands a beat late', async () => {
    const sequence = [[RETIRED_IP], [RETIRED_IP], [PROMOTED_IP]];
    const res = await runDnsFailoverFlipCheck({
      domain: DOMAIN,
      expectedIp: PROMOTED_IP,
      budgetMs: 10_000,
      intervalMs: 1,
      deps: authDeps({
        ns: async (zone) =>
          zone === 'appcarbon.dev' ? ['ns1.first-ns.de'] : Promise.reject(new Error('nx')),
        nsAddrs: async () => ['193.47.99.3'],
        a: async () => sequence.shift() ?? [PROMOTED_IP],
      }),
      sleep: noSleep,
    });
    expect(res.status).toBe('pass');
    expect(res.details).toMatchObject({ attempts: 3 });
  });

  it('reports an empty record as a failure, not a pass', async () => {
    const res = await runDnsFailoverFlipCheck({
      domain: DOMAIN,
      expectedIp: PROMOTED_IP,
      budgetMs: 5,
      intervalMs: 1,
      deps: authoritative([]),
      sleep: noSleep,
    });
    expect(res.status).toBe('fail');
    expect(res.errorMessage).toContain('(no A record)');
  });

  it('skips (never passes) when the failover flips no record (manual DNS)', async () => {
    const res = await runDnsFailoverFlipCheck({
      domain: DOMAIN,
      expectedIp: null,
      skipReason: 'manual DNS: failover flips no record',
      deps: authoritative([RETIRED_IP]),
      sleep: noSleep,
    });
    expect(res.status).toBe('skip');
    expect(res.details).toMatchObject({ skipped: true });
  });

  it('skips when the promoted IP is unknown — a missing precondition is not green', async () => {
    const res = await runDnsFailoverFlipCheck({
      domain: DOMAIN,
      expectedIp: null,
      deps: authoritative([PROMOTED_IP]),
      sleep: noSleep,
    });
    expect(res.status).toBe('skip');
  });

  it('never consults the OS resolver', () => {
    const src = stripComments(read('tests/e2e/checks/dns-flip.ts'));
    // dns.lookup / dns.promises.lookup ARE the OS resolver; resolveNs/resolve4
    // on an explicitly-servered Resolver are directed queries.
    expect(src).not.toMatch(/\blookup\s*\(/);
    expect(src).toContain('setServers');
  });
});

// ---------------------------------------------------------------------------
// 6. FAMILY CENSUS — every HTTP check at verify-failover goes through the pin
// ---------------------------------------------------------------------------

const LIFECYCLE_SRC = read('tests/e2e/scenarios/_run-lifecycle.ts');

/** Body of `runVerificationChecks`, brace-balanced from its opening `{`. */
function verificationBody(src: string): string {
  const start = src.indexOf('async function runVerificationChecks(');
  if (start === -1) throw new Error('runVerificationChecks not found in _run-lifecycle.ts');
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced runVerificationChecks body');
}

/** `{ runHealthChecks: 'health.ts', ... }` from _run-lifecycle's check imports. */
function checkImportMap(src: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of src.matchAll(
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'\.\.\/checks\/([\w-]+)\.js'/g,
  )) {
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) map[name] = `${m[2]}.ts`;
    }
  }
  return map;
}

/**
 * Modules exempt from the "must go through dnsSafeFetch" rule, each with the
 * reason it cannot. An exemption is a claim that the module reaches the
 * environment by ANOTHER pinned path — asserted individually below, never
 * granted on trust.
 */
const HTTP_SEAM_EXEMPT: Record<string, string> = {
  'health.ts':
    'owns the pinned transport itself — dnsSafeFetch/waitForHealthy/checkSslValid all dial resolveCheckIp',
  'frontend-smoke.ts':
    'drives a real browser, which owns its own resolver — pinned via --host-resolver-rules instead',
};

const RAW_HTTP = /(?<![\w])fetch\(|https?\.request\(|https?\.get\(/;

describe('CENSUS: verify-failover HTTP checks cannot bypass the resolution pin', () => {
  const body = verificationBody(LIFECYCLE_SRC);
  const imports = checkImportMap(LIFECYCLE_SRC);
  const invoked = [...new Set([...body.matchAll(/\b(run[A-Z]\w*)\(/g)].map((m) => m[1]))];
  const checkModules = [...new Set(invoked.map((n) => imports[n]).filter(Boolean))];

  it('the census actually found the failover check battery', () => {
    // Guards the census itself: a rename that empties `invoked` must fail here
    // rather than vacuously pass every assertion below.
    expect(invoked).toEqual(expect.arrayContaining(['runHealthChecks', 'runAppFunctionalChecks']));
    expect(checkModules.length).toBeGreaterThanOrEqual(8);
  });

  it.each(checkModules)(
    '%s reaches the environment only through the pinned seam',
    (moduleName: string) => {
      const src = stripComments(read(`tests/e2e/checks/${moduleName}`));
      const exempt = HTTP_SEAM_EXEMPT[moduleName];

      if (!exempt) {
        // A raw fetch()/https.request() would resolve through undici's own
        // lookup — the OS resolver — and could land on the retired node.
        expect(
          RAW_HTTP.test(src),
          `${moduleName} makes a raw HTTP call. Route it through dnsSafeFetch (tests/e2e/checks/health.ts) ` +
            'so verify-failover can pin it, or add a documented HTTP_SEAM_EXEMPT entry.',
        ).toBe(false);

        // Any module that builds an environment URL must import the seam.
        if (/https:\/\/\$\{/.test(src)) {
          expect(
            src,
            `${moduleName} builds an https://\${...} URL but does not import dnsSafeFetch.`,
          ).toMatch(/import\s*\{[^}]*dnsSafeFetch[^}]*\}\s*from\s*'\.\/health\.js'/);
        }
      }
    },
  );

  it('health.ts resolves every check request through resolveCheckIp', () => {
    const src = stripComments(read('tests/e2e/checks/health.ts'));
    // resolvePublicIp is the UNPINNED answer. It may only be referenced by the
    // seam itself and by waitForDnsToPoint's default (which must stay unpinned);
    // anything else calling it would be a check silently reverting to the
    // public-resolver path.
    const allowedEnclosers = new Set(['resolvePublicIp', 'resolveCheckIp', 'waitForDnsToPoint']);
    for (const m of src.matchAll(/resolvePublicIp/g)) {
      // Include the match itself so the declaration line resolves to its OWN
      // name rather than to whatever function precedes it.
      const before = src.slice(0, (m.index ?? 0) + m[0].length);
      const fn = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].pop();
      expect(
        allowedEnclosers.has(fn?.[1] ?? ''),
        `resolvePublicIp is referenced inside ${fn?.[1] ?? '(top level)'} — check code must use resolveCheckIp.`,
      ).toBe(true);
    }
    // All three direct https call sites in health.ts dial an address that came
    // out of the seam, with the domain still in SNI (+ Host).
    //   dnsSafeFetch  — via its injectable default
    //   checkSslValid / waitForHealthy — direct calls
    expect(src).toContain('deps.resolveIp ?? resolveCheckIp');
    expect((src.match(/await resolveCheckIp\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/servername: domain/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('frontend-smoke.ts earns its exemption by wiring the browser-side pin', () => {
    const src = read('tests/e2e/checks/frontend-smoke.ts');
    expect(src).toContain("import { chromeHostResolverRules } from '../utils/dns-pin.js'");
    expect(src).toContain('chromeHostResolverRules(domain)');
    expect(stripComments(src)).toContain('--host-resolver-rules=');
  });

  it('the verify-failover step body itself makes no unpinned HTTP call', () => {
    expect(RAW_HTTP.test(stripComments(body))).toBe(false);
  });
});

describe('_run-lifecycle.ts: verify-failover pin wiring', () => {
  const body = verificationBody(LIFECYCLE_SRC);

  it('wraps the whole verification step in the pin scope', () => {
    // Structural pin: the pin must enclose executeStep, not sit beside it —
    // otherwise the AsyncLocalStorage scope does not cover the checks.
    expect(body).toMatch(/withResolutionPin\(verifyPin,\s*\(\)\s*=>\s*executeStep\(/);
  });

  it('pins only the steps that moved the record: failover and failback on both HA modes, restore', () => {
    // verify-deploy stays on the public resolver deliberately: that is the
    // customer cold path, and pinning it would hide an unpublished record.
    // verify-scale is its own step with its own pin, for the same reason: see
    // verify-scale-dns-pin.test.ts.
    const code = stripComments(body);
    // Both HA modes flip the record (k8s-ha to the promoted cluster's ingress
    // IP), so the post-failover pin carries no mode gate: l4 on 2026-11-15
    // failed verify-failover because k8s-ha was left out of it.
    expect(code).toMatch(
      /if \(isPostFailoverVerify\(stepName\)\) \{\s*verifyPin = postFailoverResolutionPin\(\{/,
    );
    const pinBlock = code.slice(
      code.indexOf('const promotedIp = isPostFailoverVerify(stepName)'),
      code.indexOf('withResolutionPin(verifyPin'),
    );
    expect(pinBlock).toContain('postFailoverResolutionPin(');
    expect(pinBlock).not.toMatch(/config\.mode/);
    expect(LIFECYCLE_SRC).toMatch(
      /function isPostFailoverVerify\(step: StepName\): boolean \{\s*return step === 'verify-failover' \|\| step === 'verify-failback';/,
    );
    // A restore pins to the published record whatever the mode, because a
    // record that never moved must still fail by dialing the destroyed server.
    expect(body).toMatch(
      /stepName === 'verify-restore'\) \{\s+const \{ ips, source \} = await resolveAuthoritativeA\(config\.domain\);[\s\S]{0,300}source === 'authoritative'[\s\S]{0,300}verifyPin = \{/,
    );
    // And nothing else computes a pin here.
    expect(code.match(/verifyPin = \{/g)).toHaveLength(1);
    expect(code.match(/verifyPin = postFailoverResolutionPin\(/g)).toHaveLength(1);
  });

  it('pins, waits for and asserts the flip against ONE promoted address', () => {
    // The pin, the propagation gate and dns_failover_flip must agree on what
    // the record now carries: readServingIp, the promoted node on compose-ha
    // and the promoted cluster's ingress IP on k8s-ha.
    const code = stripComments(LIFECYCLE_SRC);
    expect(code).toContain(
      'const promotedIp = isPostFailoverVerify(stepName)\n      ? readServingIp(config.projectDir, config.envPrefix)\n      : null;',
    );
    expect(code).toMatch(/postFailoverResolutionPin\(\{[^}]*servingIp: promotedIp,/);
    expect(code).toContain('waitForDnsToPoint(config.domain, promotedIp');
    expect(code).toMatch(
      /runDnsFailoverFlipCheck\(\{\s*domain: config\.domain,\s*expectedIp: promotedIp,/,
    );
  });

  it('runs dns_failover_flip at verify-failover on both HA modes, against the promoted address', () => {
    // It is what keeps the pin honest: a pinned battery passes against a
    // record that never published unless the authoritative read can fail it.
    const code = stripComments(body);
    expect(code).toContain('runDnsFailoverFlipCheck({');
    expect(code).toMatch(
      /runDnsFailoverFlipCheck\(\{\s*domain: config\.domain,\s*expectedIp: promotedIp,/,
    );
    expect(code).toMatch(/skipReason: failoverFlipsRecord\(config\.dnsProvider\)\s*\?\s*null/);
  });

  it('keeps the propagation gate as evidence for the docs/rto-rpo.md DNS tail', () => {
    // docs/rto-rpo.md cites this gate's log line as the published evidence for
    // the DNS-propagation tail. The pin makes it advisory, not removable.
    expect(body).toContain('waitForDnsToPoint(config.domain, promotedIp');
  });
});

describe('post-failover DNS wait target', () => {
  // Every k8s-ha verify-failover burned this wait's full 360 s: the record
  // carries the promoted cluster's floating IP, and the wait compared it to
  // the master node's own address, which can never match.
  it('waits for the IP the A records carry, not for a node address', () => {
    const lifecycle = readFileSync(
      fileURLToPath(new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
      'utf8',
    );
    expect(lifecycle).toContain('? readServingIp(config.projectDir, config.envPrefix)');
    expect(lifecycle).not.toContain('const promotedIp = sshCheckMasterIp');
  });
});

// ---------------------------------------------------------------------------
// 7. k8s-ha flips the record too (l4, run 43757126064, 2026-11-15)
// ---------------------------------------------------------------------------
//
// verify-failover on linode/k8s-ha failed auth_protected (get-session 404, 14
// ms) and file_upload_roundtrip ("404 page not found", 16 ms) while 24 checks
// passed. The failover had flipped the A record to the promoted cluster
// (us-ord) 38 s before the step began; the battery was unpinned on k8s-ha, so
// each request dialed whatever 1.1.1.1 / 8.8.8.8 answered first, and some still
// answered the retired primary (us-iad) inside Linode's 300 s TTL. Its app tier is at zero,
// so its Traefik has no app route and answers "404 page not found". The k8s-ha
// exclusion rested on "k8s-ha failover moves a floating IP and never rewrites
// the A record", which was never true: src/failover.js STEP 7 rewrites apex +
// wildcard whenever the DNS is automated, in both HA modes.

const PROMOTED_INGRESS_IP = '198.51.100.20';
const RETIRED_INGRESS_IP = '203.0.113.10';
const LINODE_DOMAIN = 'l4-abc.linode.appcarbon.dev';

describe('the post-failover pin and record flip, both HA modes', () => {
  it('failoverFlipsRecord is true for every automated DNS provider, false for manual', () => {
    for (const id of ['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway', 'cloudflare']) {
      expect(failoverFlipsRecord(id), id).toBe(true);
    }
    expect(failoverFlipsRecord('manual')).toBe(false);
    expect(failoverFlipsRecord(undefined)).toBe(false);
  });

  it('pins k8s-ha to the promoted ingress IP, keeping the domain', () => {
    expect(
      postFailoverResolutionPin({
        stepName: 'verify-failover',
        domain: LINODE_DOMAIN,
        envPrefix: 'cil4',
        dnsProvider: 'linode',
        servingIp: PROMOTED_INGRESS_IP,
      }),
    ).toMatchObject({ domain: LINODE_DOMAIN, ip: PROMOTED_INGRESS_IP });
  });

  it('pins nothing when no record moved (manual DNS) or the address is unknown', () => {
    const base = {
      stepName: 'verify-failover',
      domain: LINODE_DOMAIN,
      envPrefix: 'cil4',
    };
    expect(
      postFailoverResolutionPin({ ...base, dnsProvider: 'manual', servingIp: PROMOTED_INGRESS_IP }),
    ).toBeNull();
    expect(
      postFailoverResolutionPin({ ...base, dnsProvider: 'linode', servingIp: null }),
    ).toBeNull();
  });

  it('reproduces l4: a public resolver still on the retired IP no longer decides the dial', async () => {
    const pin = postFailoverResolutionPin({
      stepName: 'verify-failover',
      domain: LINODE_DOMAIN,
      envPrefix: 'cil4',
      dnsProvider: 'linode',
      servingIp: PROMOTED_INGRESS_IP,
    });
    const captured: CapturedRequest[] = [];
    await withResolutionPin(pin, () =>
      dnsSafeFetch(`https://${LINODE_DOMAIN}/api/v1/files/presign`, undefined, {
        resolveIp: (domain) => resolveCheckIp(domain, async () => RETIRED_INGRESS_IP),
        httpsRequest: stubHttps(captured),
      }),
    );
    expect(captured[0].hostname).toBe(PROMOTED_INGRESS_IP);
    expect(captured[0].servername).toBe(LINODE_DOMAIN);
  });
});

describe('CENSUS: every HA scenario in the registry gets the pin and the TTL window', () => {
  const haScenarios = Object.entries(testConfig.e2e.providers).flatMap(([provider, p]) =>
    p.scenarios
      .filter((s) => s.mode.endsWith('-ha'))
      .map((s) => ({ provider, mode: s.mode, dnsProvider: s.dnsProvider, envPrefix: s.envPrefix })),
  );

  it('the census found both HA modes', () => {
    expect(new Set(haScenarios.map((s) => s.mode))).toEqual(new Set(['compose-ha', 'k8s-ha']));
  });

  it.each(haScenarios)(
    '$provider/$mode: its failover flips the record and its verify is pinned',
    (s) => {
      expect(failoverFlipsRecord(s.dnsProvider)).toBe(true);
      expect(
        postFailoverResolutionPin({
          stepName: 'verify-failover',
          domain: `${s.envPrefix}.example.dev`,
          envPrefix: s.envPrefix,
          dnsProvider: s.dnsProvider,
          servingIp: PROMOTED_INGRESS_IP,
        }),
      ).toMatchObject({ ip: PROMOTED_INGRESS_IP });
    },
  );

  it('every status probe after a failover gets the moved-record window from the same predicate', () => {
    // `vibecarbon status` is a separate process the pin cannot reach, so after
    // a flip its readiness probe can hit the retired side until the TTL runs
    // out. Every call site decides that from failoverFlipsRecord, never from a
    // mode literal (which is how k8s-ha was left with a non-retryable probe).
    const code = stripComments(LIFECYCLE_SRC);
    const sites = [...code.matchAll(/recordJustMoved[^,;\n]*[,;\n]/g)].map((m) => m[0]);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const site of sites) {
      expect(site).not.toMatch(/config\.mode/);
    }
    expect(code).toContain('const recordJustMoved = failoverFlipsRecord(config.dnsProvider);');
    expect(code).toContain('recordJustMoved: failoverFlipsRecord(config.dnsProvider),');
  });

  it('reconverge-deploy probes the promoted cluster through the pin too', () => {
    // It runs a few minutes after the flip: still inside Linode's 300 s TTL.
    const code = stripComments(LIFECYCLE_SRC);
    expect(code).toMatch(
      /withResolutionPin\(\s*postFailoverResolutionPin\(\{[\s\S]{0,400}\}\),\s*\(\) =>\s*runPostReconvergeObservability\(/,
    );
  });
});
