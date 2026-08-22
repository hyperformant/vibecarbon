/**
 * The end of a destroy: the leak report and the exit code it sets.
 *
 * `destroy` is best-effort per resource by design — one class failing must not
 * abort the teardown. Before this, the cost was that it also exited 0 whenever
 * it REACHED the end, regardless of what it had failed to delete: on
 * 2026-07-22 (prod re-home) a destroy printed `Environment "prod" destroyed.`
 * over a live server and two live firewalls. These tests pin the two halves of
 * the fix: the report is printed, and the exit code comes from the ledger.
 *
 * Also covers the finish-then-report wrapper on the effect registry — a step
 * that THROWS must not skip the remaining steps (and, above all, must not skip
 * the report itself).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMessages: string[] = [];
const outroMessages: string[] = [];

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    log: {
      success: (m: string) => logMessages.push(`success:${m}`),
      warn: (m: string) => logMessages.push(`warn:${m}`),
      error: (m: string) => logMessages.push(`error:${m}`),
      info: (m: string) => logMessages.push(`info:${m}`),
      message: (m: string) => logMessages.push(`message:${m}`),
      step: (m: string) => logMessages.push(`step:${m}`),
    },
    outro: (m: string) => outroMessages.push(m),
  };
});

const { DESTROY_EFFECTS, destroyOutro } = await import('../../../src/destroy.js');
const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');

/** Strip ANSI so assertions read the text, not the colour codes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const allText = () => logMessages.map(plain).join('\n');

let previousExitCode: number | string | undefined;

beforeEach(() => {
  logMessages.length = 0;
  outroMessages.length = 0;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.clearAllMocks();
});

describe('destroyOutro — clean teardown', () => {
  it('prints a one-line all-clear and exits 0', () => {
    const results = { leaks: createLeakLedger() };

    destroyOutro('prod', '1m 4s', results);

    expect(allText()).toMatch(/Environment "prod" destroyed\./);
    expect(allText()).toMatch(/no leaked resources/i);
    expect(allText()).toMatch(/read in full/i);
    expect(process.exitCode).toBe(0);
  });
});

describe('destroyOutro — the 2026-07-22 shape', () => {
  it('prints one line per survivor with class, identity and reason, then a count — and exits 2', () => {
    const results = { leaks: createLeakLedger() };
    results.leaks.leak({
      resourceClass: 'server',
      resource: 'acme-prod (id 4821)',
      reason: 'delete failed: server is locked by another action',
      hint: 'Delete it via the Hetzner Cloud console.',
    });
    results.leaks.leak({
      resourceClass: 'firewall',
      resource: 'acme-prod-firewall',
      reason: 'delete did not complete: rate_limit_exceeded',
    });

    destroyOutro('prod', '2m 10s', results);

    const text = allText();
    // NOT the success line — that misreport is the whole bug.
    expect(text).not.toMatch(/Environment "prod" destroyed\./);
    expect(text).toMatch(/was NOT fully torn down/);
    expect(text).toMatch(/LEAK\s+server\s+acme-prod \(id 4821\): delete failed: server is locked/);
    expect(text).toMatch(/LEAK\s+firewall\s+acme-prod-firewall: delete did not complete/);
    expect(text).toContain('Delete it via the Hetzner Cloud console.');
    expect(text).toMatch(/2 leaked/);
    expect(process.exitCode).toBe(2);
    expect(outroMessages.map(plain).join()).toMatch(/leaks/);
  });

  it('exits 2 on an unreadable listing alone — no leak observed, but none ruled out either', () => {
    const results = { leaks: createLeakLedger() };
    results.leaks.unverified({
      resourceClass: 'volume',
      resource: 'volume listing (nbg1)',
      reason: 'listing incomplete — surviving pvc-* volumes cannot be ruled out',
    });

    destroyOutro('prod', '1m', results);

    expect(allText()).toMatch(/UNVERIFIED\s+volume/);
    expect(process.exitCode).toBe(2);
  });
});

describe('destroyOutro — reported but exit-neutral', () => {
  it('reports a foreign volume and an at-risk bucket without failing the exit code', () => {
    const results = { leaks: createLeakLedger() };
    results.leaks.foreign({
      resourceClass: 'volume',
      resource: 'pvc-aaaaaaaa-1111-2222-3333-444444444444 (nbg1)',
      reason:
        "left in place (pvc-in-cluster-region match only): this environment's own PersistentVolume list was captured in full and does not contain it",
    });
    results.leaks.risk({
      resourceClass: 'bucket',
      resource: 'acme-prod (fsn1)',
      reason: 'HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY are not set',
    });

    destroyOutro('prod', '55s', results);

    const text = allText();
    // Still SEEN...
    expect(text).toMatch(/with observations/);
    expect(text).toMatch(/FOREIGN\s+volume/);
    expect(text).toMatch(/AT-RISK\s+bucket/);
    expect(text).toMatch(/1 foreign/);
    expect(text).toMatch(/1 at risk/);
    // ...but a volume proven NOT ours, and a risk that predicts rather than
    // observes, must not turn somebody else's problem into our red build.
    expect(process.exitCode).toBe(0);
  });
});

describe('finish-then-report wrapper (DESTROY_EFFECTS)', () => {
  function makeCtx() {
    return {
      environment: 'prod',
      results: { leaks: createLeakLedger(), pulumiDestroyFailed: false },
      projectConfig: { projectName: 'acme', environments: { prod: {} } },
      spinner: { start: vi.fn(), stop: vi.fn() },
      envConfig: {},
      cwd: '/nonexistent-project-dir',
      args: {},
    };
  }

  it('records a throwing step as unverified instead of aborting the plan', async () => {
    const ctx = makeCtx();
    // cleanupLocalFiles is the cheapest real effect to force into a throw:
    // a null cwd makes join() throw inside cleanupLocalEnvFiles.
    ctx.cwd = null as unknown as string;

    await expect(DESTROY_EFFECTS.cleanupLocalFiles(ctx)).resolves.toBeUndefined();

    expect(ctx.results.leaks.entries).toHaveLength(1);
    const [entry] = ctx.results.leaks.entries;
    expect(entry.severity).toBe('unverified');
    expect(entry.resourceClass).toBe('destroy-step');
    expect(entry.resource).toBe('cleanup-local-files');
    expect(entry.reason).toMatch(/step threw/);
    // Non-zero, so the caller still learns the teardown was not clean.
    expect(ctx.results.leaks.exitCode()).toBe(2);
  });

  it('wraps every effect EXCEPT finishOutro — the reporter must never swallow its own failure', () => {
    // A wrapped finishOutro that swallowed would exit 0 with no report at all,
    // which is precisely the defect being fixed. Structural pin: the wrapper
    // returns an anonymous arrow, so every wrapped entry has an empty `.name`
    // while the one bare effect keeps its declared name.
    const bare = Object.entries(DESTROY_EFFECTS)
      .filter(([, fn]) => fn.name !== '')
      .map(([key]) => key);
    expect(bare).toEqual(['finishOutro']);
    expect(DESTROY_EFFECTS.finishOutro.name).toBe('finishOutroEffect');
  });
});
