/**
 * verify-scale post-resize serving gate.
 *
 * Live RCA (CI matrix run 29180322032, 2026-07-13): a k8s master resize
 * reboots the k3s control plane and restarts every pod (traefik included).
 * verify-scale's frontend render check navigated once right after "Pods
 * Ready", landed inside the ~40–60s recovery churn (empty response /
 * connection refused), and its 30s DOM poll could never recover — while
 * the failure diagnostics seconds later saw HTTP/2 200 and healthy pods.
 * The gate: before the render assertion, wait (bounded) until the app root
 * serves 200 + a non-empty body. A genuinely blank SPA serves 200 + HTML
 * instantly, so the gate cannot mask the white-screen class the render
 * check exists for.
 */
import { describe, expect, it, vi } from 'vitest';
import { waitForAppServing } from '../../e2e/checks/health.js';

const noSleep = () => Promise.resolve();

function res(status: number, body: string) {
  return { status, text: async () => body };
}

describe('waitForAppServing', () => {
  it('returns ok once the root serves 200 with a non-empty body', async () => {
    const answers = [
      res(503, ''),
      res(502, 'Bad Gateway'),
      res(200, '<!doctype html><div id="root">'),
    ];
    const fetchImpl = vi.fn(async () => answers.shift() ?? res(200, '<html>'));
    const gate = await waitForAppServing('e3.carbonstack.dev', {
      budgetMs: 10_000,
      intervalMs: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(gate.ok).toBe(true);
    expect(gate.attempts).toBe(3);
    expect(gate.lastStatus).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith('https://e3.carbonstack.dev/');
  });

  it('keeps polling through thrown network errors (connection refused mid-reboot)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('connect ECONNREFUSED');
      return res(200, '<html>app</html>');
    });
    const gate = await waitForAppServing('e3.carbonstack.dev', {
      budgetMs: 10_000,
      intervalMs: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(gate.ok).toBe(true);
    expect(gate.attempts).toBe(3);
  });

  it('does not accept a 200 with an empty body', async () => {
    const answers = [res(200, '   '), res(200, '<html>real</html>')];
    const fetchImpl = vi.fn(async () => answers.shift() ?? res(200, '<html>'));
    const gate = await waitForAppServing('e3.carbonstack.dev', {
      budgetMs: 10_000,
      intervalMs: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(gate.ok).toBe(true);
    expect(gate.attempts).toBe(2);
  });

  it('returns ok:false (never throws) when the budget lapses, with last failure context', async () => {
    const fetchImpl = vi.fn(async () => res(503, 'Service Unavailable'));
    const gate = await waitForAppServing('e3.carbonstack.dev', {
      budgetMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(gate.ok).toBe(false);
    expect(gate.lastStatus).toBe(503);
    expect(gate.attempts).toBeGreaterThanOrEqual(1);
  });

  it('reports the last error message when every attempt threw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('DNS resolution failed for e3.carbonstack.dev after retries');
    });
    const gate = await waitForAppServing('e3.carbonstack.dev', {
      budgetMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(gate.ok).toBe(false);
    expect(gate.lastStatus).toBeNull();
    expect(gate.lastError).toContain('DNS resolution failed');
  });
});
