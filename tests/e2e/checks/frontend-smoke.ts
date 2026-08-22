/// <reference lib="dom" />
/**
 * Frontend smoke check — loads the deployed SPA in a real headless browser
 * and asserts it actually renders, rather than only that APIs respond.
 *
 * RCA prod-1 2026-05-26: a production-only React crash (minified #306, caused
 * by a duplicate React copy across rolldown chunks) white-screened the entire
 * app, yet every e2e check stayed green because they all call APIs directly
 * and none ever loaded the page in a browser. This closes that gap.
 *
 * Drives a browser via Playwright (`playwright-core`) launched against the
 * SYSTEM Chrome/Chromium (`executablePath`) — no bundled-browser download in
 * the toolchain, while getting Playwright's robust launch, condition-based
 * waiting (networkidle + waitForFunction), and screenshot-on-failure instead
 * of the hand-rolled DevTools-Protocol client this used to be (which flaked on
 * browser-launch crashes and blank-after-scale renders). If no Chrome binary
 * is found, the check degrades to a loud skip (status 'skip', NOT pass) — a
 * missing browser is a test-runner limitation, not an application defect, but
 * it must not read as a green render either. Set VIBECARBON_CHROME_PATH or
 * PUPPETEER_EXECUTABLE_PATH to enable it in CI.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright-core';
import type { VerificationResult } from '../scenarios/types.js';
import { chromeHostResolverRules } from '../utils/dns-pin.js';

// Condition-based render wait: poll for real content until the SPA hydrates, a
// crash shows, or the deadline elapses — a just-scaled/slow-starting deploy
// gets time to catch up WITHOUT masking a genuinely blank/crashed page.
const RENDER_POLL_INTERVAL_MS = 1_000;
const RENDER_POLL_DEADLINE_MS = 30_000;

// Below this many chars of rendered text, treat the page as blank/crashed.
const MIN_RENDERED_TEXT = 200;

function pass(details: Record<string, unknown>, start: number): VerificationResult {
  return {
    checkName: 'frontend_render',
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details,
  };
}
/** Precondition missing (no browser) — a skip, never a green render. */
function skip(reason: string, start: number): VerificationResult {
  return {
    checkName: 'frontend_render',
    status: 'skip',
    responseTimeMs: Date.now() - start,
    details: { skipped: true, reason },
  };
}
function fail(
  errorMessage: string,
  details: Record<string, unknown>,
  start: number,
): VerificationResult {
  return {
    checkName: 'frontend_render',
    status: 'fail',
    responseTimeMs: Date.now() - start,
    errorMessage,
    details,
  };
}

/** Locate a Chrome/Chromium binary, or null if none is available. */
function findChrome(): string | null {
  const envPaths = [
    process.env.VIBECARBON_CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ].filter((p): p is string => Boolean(p));
  for (const p of envPaths) {
    if (existsSync(p)) return p;
  }

  // `which` for common binary names
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const p = execFileSync('which', [name], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (p && existsSync(p)) return p;
    } catch {
      // not on PATH — keep looking
    }
  }

  // puppeteer's download cache (chrome-headless-shell or full chrome)
  const cacheRoot = join(homedir(), '.cache', 'puppeteer');
  for (const [dir, leaf] of [
    ['chrome-headless-shell', 'chrome-headless-shell'],
    ['chrome', 'chrome'],
  ] as const) {
    const base = join(cacheRoot, dir);
    if (!existsSync(base)) continue;
    try {
      for (const ver of readdirSync(base).sort().reverse()) {
        // e.g. linux-145.0.x/chrome-headless-shell-linux64/chrome-headless-shell
        for (const sub of [`${leaf}-linux64`, `${leaf}-linux`, '']) {
          const candidate = join(base, ver, sub, leaf);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // unreadable cache dir — ignore
    }
  }

  return null;
}

/** Save a screenshot to the diagnostics dir; returns the path or undefined. */
async function captureScreenshot(page: import('playwright-core').Page, label: string) {
  try {
    const dir = join(homedir(), '.vibecarbon', 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `frontend-${label}-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Load https://<domain>/ in a headless browser and assert it renders without a
 * React crash. Returns a single VerificationResult.
 */
export async function runFrontendSmokeChecks(domain: string): Promise<VerificationResult[]> {
  const start = Date.now();
  const chrome = findChrome();
  if (!chrome) {
    return [
      skip(
        'No Chrome/Chromium binary found — set VIBECARBON_CHROME_PATH or PUPPETEER_EXECUTABLE_PATH to enable the frontend render check.',
        start,
      ),
    ];
  }

  // Chromium has no `dnsSafeFetch` to route through — it owns its own resolver
  // stack. Under a verify-failover resolution pin (tests/e2e/utils/dns-pin.ts)
  // it gets the same pin via `--host-resolver-rules`, which remaps the address
  // ONLY: the navigation URL, the `Host` header and the TLS SNI all remain the
  // domain, so the promoted node still has to route by name and serve a cert
  // valid for it. Null (the normal case) leaves the browser on the OS resolver.
  const hostResolverRules = chromeHostResolverRules(domain);
  const launchArgs = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  if (hostResolverRules) {
    launchArgs.push(`--host-resolver-rules=${hostResolverRules}`);
  }

  // Playwright absorbs transient browser start-up crashes/races that a raw
  // CDP client would surface as hard failures.
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: launchArgs,
    });
  } catch (err) {
    return [
      fail(
        `Browser failed to launch: ${err instanceof Error ? err.message : String(err)}`,
        { chrome, hostResolverRules },
        start,
      ),
    ];
  }

  const consoleErrors: string[] = [];
  try {
    // ignoreHTTPSErrors is scoped to THIS context (not a global browser flag):
    // the matrix serves Let's Encrypt *staging* certs (ACME_CA_SERVER=staging,
    // to dodge prod rate limits) whose CA isn't trusted, so every navigation
    // would otherwise land on the cert interstitial and read as 0 chars.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e instanceof Error ? e.message : String(e)));

    // networkidle gives the SPA time to fetch + hydrate; a bare load can read
    // blank. A navigation timeout isn't fatal on its own — the render assertion
    // below is the real gate.
    await page
      .goto(`https://${domain}/`, { waitUntil: 'networkidle', timeout: RENDER_POLL_DEADLINE_MS })
      .catch(() => {});

    // Condition wait: real content rendered OR the ErrorBoundary tripped.
    await page
      .waitForFunction(
        (min) => {
          const root = document.getElementById('root');
          const txt = (root?.innerText ?? '').replace(/\s+/g, ' ').trim();
          return txt.includes('Something went wrong') || txt.length >= min;
        },
        MIN_RENDERED_TEXT,
        { timeout: RENDER_POLL_DEADLINE_MS, polling: RENDER_POLL_INTERVAL_MS },
      )
      .catch(() => {});

    const info = await page.evaluate(() => {
      const root = document.getElementById('root');
      const txt = (root?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const h1 = document.querySelector('h1');
      return {
        textLen: txt.length,
        errorBoundaryShown: txt.includes('Something went wrong'),
        title: document.title,
        h1: (h1 instanceof HTMLElement ? h1.innerText : '').trim().slice(0, 80),
        hasNav: !!document.querySelector('nav'),
      };
    });

    const crashMarkers = consoleErrors.filter((e) =>
      /Minified React error|Element type is invalid|ErrorBoundary caught|#306/i.test(e),
    );

    const details: Record<string, unknown> = {
      chrome,
      hostResolverRules,
      textLen: info.textLen,
      title: info.title,
      h1: info.h1,
      hasNav: info.hasNav,
      consoleErrorCount: consoleErrors.length,
    };

    if (crashMarkers.length > 0) {
      return [
        fail(
          `React crash detected: ${crashMarkers[0].slice(0, 160)}`,
          { ...details, crashMarkers, screenshot: await captureScreenshot(page, 'crash') },
          start,
        ),
      ];
    }
    if (info.errorBoundaryShown) {
      return [
        fail(
          'App rendered the ErrorBoundary fallback ("Something went wrong")',
          { ...details, screenshot: await captureScreenshot(page, 'errorboundary') },
          start,
        ),
      ];
    }
    if (info.textLen < MIN_RENDERED_TEXT) {
      return [
        fail(
          `Rendered text is ${info.textLen} chars (< ${MIN_RENDERED_TEXT}) — page likely blank/crashed`,
          {
            ...details,
            consoleErrors: consoleErrors.slice(0, 5),
            screenshot: await captureScreenshot(page, 'blank'),
          },
          start,
        ),
      ];
    }

    return [pass(details, start)];
  } catch (err) {
    return [fail(err instanceof Error ? err.message : String(err), { chrome }, start)];
  } finally {
    await browser.close().catch(() => {});
  }
}
