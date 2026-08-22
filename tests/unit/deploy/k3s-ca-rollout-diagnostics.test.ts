/**
 * Unit tests for the cluster-autoscaler rollout-failure diagnostics in
 * src/lib/deploy/k8s/k3s.js.
 *
 * Two blind RCAs paid for this file:
 *
 *  - 2026-07-27: the rollout-failure capture described the Deployment only,
 *    so a failing sidecar left no trace (fixed then by adding `describe pods`).
 *  - 2026-07-31 (k8s e3): the deploy died with "cluster-autoscaler rollout
 *    status failed (timeout 300s)" and the deploy log contained the capture's
 *    HEADER LINE AND NOTHING ELSE. Root cause: the capture ran through
 *    `runCommandAsync(..., { silent: false })`, i.e. `stdio: 'inherit'`, so the
 *    child wrote straight to the inherited fds. `withDeployLog` tees by
 *    monkey-patching `process.stdout.write` IN-PROCESS — an inherited fd never
 *    passes through it, so every byte of the capture bypassed the log file.
 *
 * The regression guard for the second one is the `stdio: 'pipe'` assertion
 * below: diagnostics MUST be captured (silent) and re-emitted through
 * `process.stdout.write`, never inherited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

const {
  captureClusterAutoscalerDiagnostics,
  clusterAutoscalerDiagnosticCommands,
  DIAGNOSTIC_TAIL_LINES,
  runDeployDiagnostic,
  selectNonReadyPods,
} = await import('../../../src/lib/deploy/k8s/k3s.js');

/** Minimal ChildProcess stand-in for runCommandAsync's silent:true path. */
function fakeChild(code: number, stdout = '', stderr = '') {
  const child = {
    stdin: { write: () => true, end: () => {} },
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
    kill: () => {},
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === 'close') {
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => cb(code));
      }
      return child;
    },
  };
  return child;
}

/** Serialize a kubectl `get pods -o json` payload. */
function podList(items: unknown[]) {
  return JSON.stringify({ apiVersion: 'v1', kind: 'List', items });
}

function readyPod(name: string) {
  return {
    metadata: { name },
    spec: { containers: [{ name: 'cluster-autoscaler' }, { name: 'carbon-autoscaler' }] },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: 'cluster-autoscaler', ready: true },
        { name: 'carbon-autoscaler', ready: true },
      ],
    },
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let written: string[];
let errored: string[];

beforeEach(() => {
  spawnMock.mockReset();
  written = [];
  errored = [];
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  stderrSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errored.push(args.map(String).join(' '));
  }) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe('selectNonReadyPods', () => {
  it('returns no pods when every container is ready', () => {
    expect(selectNonReadyPods(podList([readyPod('cluster-autoscaler-abc')]))).toEqual([]);
  });

  it('flags a Running pod whose sidecar is not ready, with both container names', () => {
    const pods = selectNonReadyPods(
      podList([
        {
          metadata: { name: 'cluster-autoscaler-abc' },
          spec: { containers: [{ name: 'cluster-autoscaler' }, { name: 'carbon-autoscaler' }] },
          status: {
            phase: 'Running',
            containerStatuses: [
              { name: 'cluster-autoscaler', ready: true },
              { name: 'carbon-autoscaler', ready: false },
            ],
          },
        },
      ]),
    );
    expect(pods).toHaveLength(1);
    expect(pods[0].name).toBe('cluster-autoscaler-abc');
    expect(pods[0].containers).toEqual(['cluster-autoscaler', 'carbon-autoscaler']);
  });

  it('flags a Pending pod that has no containerStatuses yet (spec names as fallback)', () => {
    const pods = selectNonReadyPods(
      podList([
        {
          metadata: { name: 'cluster-autoscaler-pending' },
          spec: { containers: [{ name: 'cluster-autoscaler' }, { name: 'carbon-autoscaler' }] },
          status: { phase: 'Pending' },
        },
      ]),
    );
    expect(pods).toHaveLength(1);
    expect(pods[0].containers).toEqual(['cluster-autoscaler', 'carbon-autoscaler']);
  });

  it('includes init containers so their logs are captured too', () => {
    const pods = selectNonReadyPods(
      podList([
        {
          metadata: { name: 'ca-init' },
          spec: {
            initContainers: [{ name: 'wait-for-config' }],
            containers: [{ name: 'cluster-autoscaler' }],
          },
          status: { phase: 'Pending' },
        },
      ]),
    );
    expect(pods[0].containers).toEqual(['wait-for-config', 'cluster-autoscaler']);
  });

  it('caps the pod fan-out so a wedged cluster cannot unbound the capture', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      metadata: { name: `ca-${i}` },
      spec: { containers: [{ name: 'cluster-autoscaler' }] },
      status: { phase: 'Pending' },
    }));
    expect(selectNonReadyPods(podList(many)).length).toBeLessThanOrEqual(5);
  });

  it('returns [] for malformed / empty kubectl output instead of throwing', () => {
    expect(selectNonReadyPods('')).toEqual([]);
    expect(selectNonReadyPods('not json')).toEqual([]);
    expect(selectNonReadyPods(undefined as unknown as string)).toEqual([]);
  });
});

describe('clusterAutoscalerDiagnosticCommands', () => {
  const flatten = (cmds: Array<{ label: string; argv: string[] }>) =>
    cmds.map((c) => c.argv.join(' '));

  it('scopes every command to kube-system (the CA does not run in the app namespace)', () => {
    const cmds = clusterAutoscalerDiagnosticCommands([
      { name: 'cluster-autoscaler-abc', containers: ['cluster-autoscaler', 'carbon-autoscaler'] },
    ]);
    expect(cmds.length).toBeGreaterThan(0);
    for (const { argv } of cmds) {
      expect(argv[0]).toBe('kubectl');
      expect(argv).toContain('kube-system');
      expect(argv).not.toContain('vibecarbon');
    }
  });

  it('captures pod state, the deployment, pod describes and namespace events', () => {
    const joined = flatten(clusterAutoscalerDiagnosticCommands([]));
    expect(joined).toContain('kubectl -n kube-system get pods -l app=cluster-autoscaler -o wide');
    expect(joined).toContain('kubectl -n kube-system describe deployment/cluster-autoscaler');
    expect(joined).toContain('kubectl -n kube-system describe pods -l app=cluster-autoscaler');
    expect(joined.some((c) => c.includes('get events'))).toBe(true);
  });

  it('describes and log-dumps every non-ready pod, both containers, previous AND current', () => {
    const joined = flatten(
      clusterAutoscalerDiagnosticCommands([
        { name: 'ca-abc', containers: ['cluster-autoscaler', 'carbon-autoscaler'] },
      ]),
    );
    expect(joined).toContain('kubectl -n kube-system describe pod ca-abc');
    for (const container of ['cluster-autoscaler', 'carbon-autoscaler']) {
      expect(joined).toContain(
        `kubectl -n kube-system logs ca-abc -c ${container} --previous --tail=${DIAGNOSTIC_TAIL_LINES}`,
      );
      expect(joined).toContain(
        `kubectl -n kube-system logs ca-abc -c ${container} --tail=${DIAGNOSTIC_TAIL_LINES}`,
      );
    }
  });

  it('bounds every logs invocation with --tail (a log file, not a database)', () => {
    const cmds = clusterAutoscalerDiagnosticCommands([
      { name: 'ca-abc', containers: ['cluster-autoscaler'] },
    ]);
    const logCmds = cmds.filter((c) => c.argv.includes('logs'));
    expect(logCmds.length).toBeGreaterThan(0);
    for (const { argv } of logCmds) {
      expect(argv.some((a) => a.startsWith('--tail='))).toBe(true);
    }
  });

  it('gives every command a human label so a bare header can never be the whole record', () => {
    for (const { label } of clusterAutoscalerDiagnosticCommands([
      { name: 'ca-abc', containers: ['cluster-autoscaler'] },
    ])) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('runDeployDiagnostic', () => {
  it('captures the child output and re-emits it through process.stdout.write', async () => {
    spawnMock.mockReturnValue(fakeChild(0, 'NAME   READY\nca-abc  1/2\n'));
    const ok = await runDeployDiagnostic(['kubectl', 'get', 'pods'], { label: 'pods' });
    expect(ok).toBe(true);
    const out = written.join('');
    expect(out).toContain('ca-abc  1/2');
    expect(out).toContain('pods');
  });

  it('spawns with piped stdio, never inherited (deploy-log tee regression guard)', async () => {
    spawnMock.mockReturnValue(fakeChild(0, 'ok\n'));
    await runDeployDiagnostic(['kubectl', 'get', 'pods'], { label: 'pods' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { stdio: string };
    expect(opts.stdio).toBe('pipe');
  });

  it('prints a loud one-line reason when the capture itself fails', async () => {
    spawnMock.mockReturnValue(fakeChild(1, '', 'Error from server (NotFound): deployments.apps'));
    const ok = await runDeployDiagnostic(['kubectl', 'describe', 'deploy/nope'], {
      label: 'describe deployment/nope',
    });
    expect(ok).toBe(false);
    const loud = errored.join('\n');
    expect(loud).toMatch(/diagnostic/i);
    expect(loud).toContain('describe deployment/nope');
    expect(loud).toContain('Error from server (NotFound)');
    // One line — a failed capture must not dump a stack trace into the log.
    expect(errored.every((line) => !line.includes('\n'))).toBe(true);
  });

  it('says so explicitly when a capture succeeds but produces no output', async () => {
    spawnMock.mockReturnValue(fakeChild(0, ''));
    await runDeployDiagnostic(['kubectl', 'get', 'pods'], { label: 'pods' });
    expect(written.join('')).toContain('(no output)');
  });

  it('clips long output to the tail bound', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
    spawnMock.mockReturnValue(fakeChild(0, long));
    await runDeployDiagnostic(['kubectl', 'logs', 'x'], { label: 'logs', tailLines: 10 });
    const out = written.join('');
    expect(out).toContain('line-499');
    expect(out).not.toContain('line-100\n');
    expect(out).toMatch(/last 10 of 500 lines/);
  });
});

describe('k3s.js diagnostics wiring (structural pin)', () => {
  const src = async () => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../../../src/lib/deploy/k8s/k3s.js', import.meta.url), 'utf8');
  };

  it('routes the rollout-failure handler through captureClusterAutoscalerDiagnostics', async () => {
    expect(await src()).toContain('await captureClusterAutoscalerDiagnostics({ env });');
  });

  it('routes the cert-manager webhook log dump through runDeployDiagnostic too', async () => {
    expect(await src()).toMatch(/runDeployDiagnostic\(\s*\[\s*'kubectl',\s*'-n',\s*'cert-manager'/);
  });

  it('leaves no best-effort capture on inherited stdio (bypasses the deploy log)', async () => {
    // `silent: false` + `ignoreError: true` is precisely the shape that wrote
    // to the terminal and left the 2026-07-31 deploy log with a bare header:
    // `stdio: 'inherit'` never passes through withDeployLog's patched
    // process.stdout.write. The ONE remaining site is the traefik
    // rollout-status WAIT, which is kept inherited on purpose so its live
    // progress is visible (same rule as runKubectlWithRetry's header) — it is
    // a wait, not a capture. Any NEW match means a capture regressed.
    const text = await src();
    const matches = [...text.matchAll(/silent:\s*false,\s*ignoreError:\s*true/g)];
    expect(matches).toHaveLength(1);
    const preceding = text.slice(Math.max(0, (matches[0].index ?? 0) - 300), matches[0].index);
    expect(preceding).toContain("'rollout'");
    expect(preceding).toContain("'status'");
  });
});

describe('captureClusterAutoscalerDiagnostics', () => {
  it('lists pods first, then runs the full kube-system capture set', async () => {
    const calls: string[][] = [];
    spawnMock.mockImplementation((exe: string, args: string[]) => {
      calls.push([exe, ...args]);
      if (args.includes('-o') && args.includes('json')) {
        return fakeChild(
          0,
          podList([
            {
              metadata: { name: 'ca-abc' },
              spec: { containers: [{ name: 'cluster-autoscaler' }, { name: 'carbon-autoscaler' }] },
              status: {
                phase: 'Running',
                containerStatuses: [
                  { name: 'cluster-autoscaler', ready: true },
                  { name: 'carbon-autoscaler', ready: false },
                ],
              },
            },
          ]),
        );
      }
      return fakeChild(0, 'diagnostic output\n');
    });

    await captureClusterAutoscalerDiagnostics({ env: { KUBECONFIG: '/tmp/kc' } });

    const joined = calls.map((c) => c.join(' '));
    expect(joined[0]).toContain('-o json');
    expect(joined.some((c) => c.includes('describe deployment/cluster-autoscaler'))).toBe(true);
    expect(joined.some((c) => c.includes('describe pod ca-abc'))).toBe(true);
    expect(joined.some((c) => c.includes('logs ca-abc -c carbon-autoscaler --previous'))).toBe(
      true,
    );
    // Every capture landed in the tee-able stream — never a bare header.
    expect(written.join('')).toContain('diagnostic output');
  });

  it('still runs the label-wide captures when the pod listing itself fails', async () => {
    const calls: string[][] = [];
    spawnMock.mockImplementation((exe: string, args: string[]) => {
      calls.push([exe, ...args]);
      if (args.includes('json')) return fakeChild(1, '', 'the server is currently unable');
      return fakeChild(0, 'still captured\n');
    });

    await captureClusterAutoscalerDiagnostics({ env: {} });

    expect(errored.join('\n')).toContain('the server is currently unable');
    const joined = calls.map((c) => c.join(' '));
    expect(joined.some((c) => c.includes('describe deployment/cluster-autoscaler'))).toBe(true);
    expect(written.join('')).toContain('still captured');
  });
});
