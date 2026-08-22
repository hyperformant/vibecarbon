/**
 * Unit tests for runKubectlWithRetry / KUBECTL_TRANSIENT_PATTERN.
 *
 * A freshly-bootstrapped k3s control plane can drop an http2 connection
 * mid-RPC during applyK3sManifests, surfacing as a `http2: client
 * connection lost` stderr on an otherwise-valid kubectl call — the helper
 * retries those signatures so a single transient doesn't kill the entire
 * deploy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.useFakeTimers() does not fake `node:timers/promises` (sinon limitation),
// so route runWithRetry's sleep through the faked global setTimeout — mirrors
// tests/unit/lib/retry.test.ts. Without this, the 2s/4s backoff between
// retries runs as REAL wall-clock delay.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms?: number, value?: unknown) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms)),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

const { runKubectlWithRetry, KUBECTL_TRANSIENT_PATTERN } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);

/** Minimal ChildProcess stand-in for runCommandAsync's silent:true path. */
function fakeChild(code: number, stdout = '', stderr = '') {
  const writtenStdin: string[] = [];
  const child = {
    stdin: {
      write: (data: string) => {
        writtenStdin.push(data);
        return true;
      },
      end: () => {},
    },
    stdout: {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data' && stdout) queueMicrotask(() => cb(Buffer.from(stdout)));
        return child;
      },
    },
    stderr: {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data' && stderr) queueMicrotask(() => cb(Buffer.from(stderr)));
        return child;
      },
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === 'close') {
        // Let any queued stdout/stderr 'data' microtasks flush first so
        // runCommandAsync's accumulated buffers are populated before close.
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => cb(code));
      }
      return child;
    },
    writtenStdin,
  };
  return child;
}

function ok(stdout = '') {
  return fakeChild(0, stdout);
}
function fail(stderr: string) {
  return fakeChild(1, '', stderr);
}

// pollUntil/runWithRetry schedule a NEW timer after each attempt, so a single
// runAllTimersAsync can't drain the chain — advance the clock in fixed steps
// and stop as soon as the promise actually settles. Mirrors retry.test.ts.
async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  while (!done) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return r;
}

beforeEach(() => {
  spawnMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KUBECTL_TRANSIENT_PATTERN', () => {
  it('matches the http2-connection-lost signature observed in 2026-04-29 k8s-ha runs', () => {
    const stderr =
      'E0429 07:33:32.023375 2067683 request.go:1196] "Unexpected error when reading response body" err="http2: client connection lost"\nerror: unexpected error when reading response body. Please retry. Original error: http2: client connection lost';
    expect(KUBECTL_TRANSIENT_PATTERN.test(stderr)).toBe(true);
  });

  it('matches each transient signature individually', () => {
    for (const sig of [
      'http2: client connection lost',
      'connection reset by peer',
      'context deadline exceeded',
      'unexpected EOF',
      'i/o timeout',
      'TLS handshake error',
      'unexpected error when reading response body',
      // cross-cluster API blip (k8s-ha standby control-plane)
      'read tcp 192.168.8.157:51002->77.42.19.162:6443: read: connection timed out',
    ]) {
      expect(KUBECTL_TRANSIENT_PATTERN.test(sig)).toBe(true);
    }
  });

  it('does not match a regular kubectl 404 / not-found error', () => {
    expect(
      KUBECTL_TRANSIENT_PATTERN.test('Error from server (NotFound): deployment "foo" not found'),
    ).toBe(false);
  });

  it('does not match a typical YAML parse error', () => {
    expect(
      KUBECTL_TRANSIENT_PATTERN.test('error: error parsing STDIN: error converting YAML to JSON'),
    ).toBe(false);
  });
});

describe('runKubectlWithRetry', () => {
  it('runs kubectl once when the first attempt succeeds', async () => {
    const child = ok('namespace/vibecarbon created\n');
    spawnMock.mockReturnValueOnce(child);
    await settled(runKubectlWithRetry(['apply', '-f', '-'], { env: {}, input: 'yaml' }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('kubectl');
    expect(args).toEqual(['apply', '-f', '-']);
    expect(opts.stdio).toBe('pipe');
    // `input` is written to the child's stdin (not passed as a spawn option
    // — that's the runCommandAsync contract).
    expect(child.writtenStdin.join('')).toBe('yaml');
  });

  it('retries on transient http2 error and succeeds on the second attempt', async () => {
    spawnMock.mockReturnValueOnce(fail('http2: client connection lost'));
    spawnMock.mockReturnValueOnce(ok());
    const r = await settled(runKubectlWithRetry(['apply', '-f', '-'], { env: {} }));
    expect(r.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('retries `connection refused` — the apiserver-mid-cycle wording (2026-08-07 sweep)', async () => {
    spawnMock.mockReturnValueOnce(
      fail(
        'The connection to the server 10.43.0.1:443 was refused - dial tcp 10.43.0.1:443: connect: connection refused',
      ),
    );
    spawnMock.mockReturnValueOnce(ok());
    const r = await settled(runKubectlWithRetry(['get', 'nodes'], { env: {} }));
    expect(r.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('matches transient wording arriving on the MESSAGE when stderr is empty (haystack join)', async () => {
    // runCommandAsync always assigns stderr (empty string when nothing was
    // written) — the old `err.stderr ?? err.message` never fell through, so
    // an empty-stderr failure could never match any pattern.
    const child = fail('');
    spawnMock.mockReturnValueOnce(child);
    spawnMock.mockReturnValueOnce(ok());
    // Simulate the transient text landing in the thrown message only: an
    // empty-stderr close builds `Command failed: kubectl …` — inject the
    // wording via the argv so it lands in the message.
    const r = await settled(
      runKubectlWithRetry(['get', 'pods', '--context=connection timed out'], { env: {} }),
    );
    expect(r.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on a non-transient error without retrying', async () => {
    spawnMock.mockReturnValueOnce(fail('Error from server (Forbidden): forbidden'));
    const r = await settled(
      runKubectlWithRetry(['apply', '-f', '-'], { env: {}, description: 'apply forbidden' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e.message).toMatch(/apply forbidden failed.*forbidden/i);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 transient attempts and throws with stderr tail', async () => {
    spawnMock
      .mockReturnValueOnce(fail('http2: client connection lost'))
      .mockReturnValueOnce(fail('http2: client connection lost'))
      .mockReturnValueOnce(fail('http2: client connection lost (final)'));
    const r = await settled(
      runKubectlWithRetry(['apply', '-f', '-'], { env: {}, description: 'final retry' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e.message).toMatch(/final retry failed.*http2: client connection lost/i);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('returns captured stdout when captureStdout=true', async () => {
    spawnMock.mockReturnValueOnce(ok('["arg1","--nodes={{ARG_PLACEHOLDER}}"]'));
    const r = await settled(
      runKubectlWithRetry(['get', 'deploy/cluster-autoscaler', '-o', 'jsonpath=...'], {
        env: {},
        captureStdout: true,
      }),
    );
    expect(r).toEqual({ ok: true, v: '["arg1","--nodes={{ARG_PLACEHOLDER}}"]' });
  });

  it('passes env through to the exec layer (e.g. KUBECONFIG)', async () => {
    spawnMock.mockReturnValueOnce(ok());
    await settled(
      runKubectlWithRetry(['version'], {
        env: { KUBECONFIG: '/tmp/kubeconfig-e4-primary' },
      }),
    );
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env).toEqual({ KUBECONFIG: '/tmp/kubeconfig-e4-primary' });
  });
});

// The webhook warm-up and psql lifecycle opt-in suites that lived here are
// REMOVED with the ladders they tested (band-aid removal, 2026-08-16): the
// admission probe and the pg-accepting gate close those windows at the
// source, and their incident shapes are preserved verbatim in
// tests/unit/deploy/k8s-readiness.test.ts.

describe('census: every psql-over-kubectl call site opts into the lifecycle ladder', () => {
  // A pattern only helps where it is passed. The 2026-08-14 failure was not a
  // missing regex, it was two call sites that never opted in — so the durable
  // guard walks the call sites rather than testing the regex again. A new
  // `kubectl exec ... psql` added without transientExtra fails here.
  const source = readFileSync(
    join(import.meta.dirname, '../../../src/lib/deploy/k8s/k3s.js'),
    'utf-8',
  );

  /** Span of each runKubectlWithRetry(...) call, by paren depth. */
  function callSites(src: string): { line: number; text: string }[] {
    const out: { line: number; text: string }[] = [];
    const re = /runKubectlWithRetry\(/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((m = re.exec(src)) !== null) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) break;
      }
      out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i + 1) });
    }
    return out;
  }

  const sites = callSites(source);

  it('found the call sites (guards against a walk that stopped matching)', () => {
    expect(sites.length).toBeGreaterThan(5);
  });

  it('every site that execs psql sits AFTER the pg-accepting gate — and none re-grows a ladder', () => {
    // Inverted 2026-08-16 (band-aid removal): the per-call lifecycle ladder is
    // deleted. The guard is the CONDITION — awaitPostgresAccepting proves the
    // db accepts before any psql runs — and this census pins two things: every
    // psql call site is downstream of that gate in source order, and no call
    // site quietly reintroduces a lifecycle opt-in (the band-aid coming back
    // under the old name).
    const psqlSites = sites.filter((s) => s.text.includes("'psql'") || /PsqlArgs\(/.test(s.text));
    expect(psqlSites.length).toBeGreaterThanOrEqual(2);

    const gateIdx = source.indexOf('awaitPostgresAccepting({ env, dbPod })');
    expect(gateIdx, 'the pg-accepting gate must be wired').toBeGreaterThan(-1);
    const gateLine = source.slice(0, gateIdx).split('\n').length;
    for (const site of psqlSites) {
      expect(
        site.line,
        `k3s.js:${site.line}: psql call site BEFORE the pg-accepting gate — it would race a ` +
          'mid-lifecycle database (the 0fbb296f RCA, reintroduced by reordering)',
      ).toBeGreaterThan(gateLine);
    }

    const regrown = psqlSites
      .filter((s) => /PSQL_LIFECYCLE|transientExtra/.test(s.text))
      .map((s) => `k3s.js:${s.line}`);
    expect(
      regrown,
      'A psql call site carries a lifecycle retry opt-in again — that is the band-aid this ' +
        'removal deleted. Fix the gate (or the regression behind the failure), do not re-absorb it:',
    ).toEqual([]);
  });
});
