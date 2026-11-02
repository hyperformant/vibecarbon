/**
 * k8s old-primary wal-g demotion is independent of the promoted side (H3).
 *
 * restorePromotedWalgRole used to `return { ok: false }` the moment the
 * promoted cluster's rollout or its backup audit failed, and that return
 * sat BEFORE the old primary's standby demotion. So a failed arm
 * also skipped the disarm: the stale ex-primary kept its primary write-guard,
 * and if it came back its nightly base backups could become LATEST in the
 * shared prefix. The demotion now runs in a `finally`, and the two verdicts
 * are reported separately.
 *
 * The census at the bottom pins the shape: no `return` sits lexically before
 * the demotion call unless it is inside the `finally`, and the demotion call
 * itself is inside a `finally` block.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { k8sRoleReply } from '../helpers/k8s-role-kubectl.js';

// The first base backup on the new timeline has its own tests
// (tests/unit/walg/post-promote-backup-census.test.ts, the step-order census);
// here it lands.
vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  pushBaseBackupAfterPromote: vi.fn(async () => ({ name: 'base_000000020000000000000004' })),
}));

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(async () => ''),
}));

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: () => true };
});

const { failoverHA, restorePromotedWalgRole } = await import('../../../src/failover.js');

const PRIMARY_IP = '10.0.0.1';
const STANDBY_IP = '10.0.0.9';
const SYSID = '7412345678901234567';

type Call = { ip: string; argv: string[]; input?: string };

/**
 * A kubectl seam that records every call, answers the db pod's role surface,
 * and rejects the old primary's standby intent apply when `demote` is set.
 */
function fakeKubectl(fail: { demote?: boolean }) {
  const calls: Call[] = [];
  const kubectl = async (ip: string, argv: string[], opts?: { input?: string }) => {
    calls.push({ ip, argv, input: opts?.input });
    if (fail.demote && ip === PRIMARY_IP && argv.includes('apply')) {
      throw new Error('ssh: connect to host 10.0.0.1 port 22: Connection refused');
    }
    return k8sRoleReply(argv) ?? '';
  };
  return { calls, kubectl };
}

/** The promoted side's requirePrimary audit, failing when asked. */
const auditThat = (fails: boolean) => async () => {
  if (fails) throw new Error('wal-g audit: the promoted db reads the standby role');
};

const isDemotion = (c: Call) =>
  c.ip === PRIMARY_IP &&
  c.argv.includes('apply') &&
  String(c.input).includes('VC_WALG_ROLE_INTENT: standby');

const quiet = { log: () => {}, warn: () => {} };

afterEach(() => {
  vi.clearAllMocks();
});

describe('demoteK8sWalgRole', () => {
  it('a dead old-primary pod still gets the standby intent (its next start applies it)', async () => {
    const { demoteK8sWalgRole } = await import('../../../src/lib/deploy/walg-role.js');
    const kubectl = vi.fn(
      async (_ip: string, argv: string[], _o?: { input?: string; timeout?: number }) => {
        if (argv.includes('get') && argv.includes('pod')) throw new Error('pods "db-0" not found');
        return '';
      },
    );
    const r = await demoteK8sWalgRole({ ip: '9.9.9.9', kubectl, warn: () => {} });
    expect(
      kubectl.mock.calls.some(
        ([, a, o]) =>
          a.join(' ').includes('apply -f -') &&
          String(o?.input).includes('VC_WALG_ROLE_INTENT: standby'),
      ),
    ).toBe(true);
    expect(r).toMatchObject({ intent: true, live: false });
    // Nothing restarts the db for the role.
    expect(kubectl.mock.calls.some(([, a]) => a.includes('set') || a.includes('rollout'))).toBe(
      false,
    );
  });
});

describe('restorePromotedWalgRole: two independent verdicts', () => {
  it('touches nothing on the promoted side but the audit: no set env, no rollout (armed before the promote)', async () => {
    const { calls, kubectl } = fakeKubectl({});
    const audit = vi.fn(async () => {});
    const health = await restorePromotedWalgRole({
      promotedIp: STANDBY_IP,
      oldPrimaryIp: PRIMARY_IP,
      sshKeyPath: '/fake/key',
      deps: { kubectl, audit, ...quiet },
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.ip === STANDBY_IP)).toEqual([]);
    expect(calls.some((c) => c.argv.includes('set') || c.argv.includes('rollout'))).toBe(false);
    expect(health).toEqual({ promoted: { ok: true }, demoted: { ok: true } });
  });

  it('demotes the old primary even when the promoted audit fails', async () => {
    const { calls, kubectl } = fakeKubectl({});
    const health = await restorePromotedWalgRole({
      promotedIp: STANDBY_IP,
      oldPrimaryIp: PRIMARY_IP,
      sshKeyPath: '/fake/key',
      deps: {
        kubectl,
        audit: async () => {
          throw new Error('wal-g audit: stale standby write-guard');
        },
        ...quiet,
      },
    });
    expect(calls.some(isDemotion)).toBe(true);
    expect(health.promoted.ok).toBe(false);
    expect(health.demoted.ok).toBe(true);
  });

  it('reports a failed demotion on its own verdict, leaving a good arm intact', async () => {
    const { kubectl } = fakeKubectl({ demote: true });
    const warn = vi.fn();
    const health = await restorePromotedWalgRole({
      promotedIp: STANDBY_IP,
      oldPrimaryIp: PRIMARY_IP,
      sshKeyPath: '/fake/key',
      deps: { kubectl, audit: async () => {}, log: () => {}, warn },
    });
    expect(health.promoted).toEqual({ ok: true });
    expect(health.demoted.ok).toBe(false);
    expect(health.demoted.error?.message).toMatch(/Connection refused/);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('both sides healthy: two ok verdicts', async () => {
    const { kubectl } = fakeKubectl({});
    const health = await restorePromotedWalgRole({
      promotedIp: STANDBY_IP,
      oldPrimaryIp: PRIMARY_IP,
      sshKeyPath: '/fake/key',
      deps: { kubectl, audit: async () => {}, ...quiet },
    });
    expect(health).toEqual({ promoted: { ok: true }, demoted: { ok: true } });
  });
});

describe('failoverHA (k8s): a failed arm still disarms, and the exit names both verdicts', () => {
  async function runFailover(fail: { audit?: boolean; demote?: boolean }) {
    const { calls, kubectl } = fakeKubectl(fail);
    const servers = {
      primary: { ip: PRIMARY_IP, floatingIp: PRIMARY_IP, region: 'nbg1' },
      standby: { ip: STANDBY_IP, floatingIp: '10.0.0.99', region: 'ash' },
    };
    const envConfig = {
      domain: 'app.example.com',
      region: 'nbg1',
      secondaryRegion: 'ash',
      replication: 'streaming',
      deployedAt: '2026-10-01T00:00:00.000Z',
      ha: {
        primary: { masterIp: PRIMARY_IP },
        standby: { masterIp: STANDBY_IP },
        systemIdentifier: SYSID,
      },
    };
    const state = {
      inRecovery: true,
      systemIdentifier: SYSID,
      replayLsn: '0/3000060',
      receiverStatus: null,
      lastMsgAgeS: null,
    };
    const deps = {
      identify: () => servers,
      getKeyPath: () => '/fake/key',
      keyExists: () => true,
      // The live standby image check (standby-image-precheck.test.ts): present.
      assertStandbyImage: async () => 'sha256:aa',
      preflight: async () => ({
        workerSpec: { count: 2, serverType: 'cx23' },
        scaleUpList: [{ name: 'app', namespace: 'vibecarbon', replicas: 2 }],
        creds: {},
      }),
      provision: async () => ({ provisioned: true as const }),
      // Unplanned: the old primary is down, so nothing is fenced first.
      isPrimaryReady: async () => false,
      readStandbyState: async () => state,
      readPrimaryState: async () => ({ ...state, inRecovery: false }),
      psql: () => async () => '',
      isStreaming: async () => true,
      scale: async () => {},
      reseed: async () => {},
      writeMarker: () => {},
      clearMarker: () => {},
      writeJournal: async () => 'journal-id',
      clearJournal: async () => {},
      promote: async () => 'promoted' as const,
      kubectl,
      // The REAL restorePromotedWalgRole, with only its kubectl and audit seams faked.
      restoreWalgRole: (a: { promotedIp: string; oldPrimaryIp: string; sshKeyPath: string }) =>
        restorePromotedWalgRole({
          ...a,
          deps: { kubectl, audit: auditThat(!!fail.audit), ...quiet },
        }),
      gate: async () => {},
      promoteIssuer: async () => ({ patched: [] }),
      swapRoles: () => {},
      reconcileRetired: async () => ({ fenced: [], unreachable: [] }),
      writeFence: async () => ({ ok: true }),
      recordFence: () => {},
    };
    let flippedTo: string | null = null;
    const strategy = {
      getAuth: async () => ({ token: 't', zoneId: 'z' }),
      updateDns: async (_auth: unknown, _domain: string, ip: string) => {
        flippedTo = ip;
      },
      readDns: async () => (flippedTo ? [flippedTo] : []),
    };
    const tracker = { spinner: () => ({ start() {}, stop() {}, message() {} }) };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    let thrown: unknown;
    try {
      await failoverHA(
        'prod',
        envConfig,
        {},
        { dryRun: false, yes: true, serverType: null },
        tracker,
        strategy,
        // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
        deps as any,
      );
    } catch (err) {
      thrown = err;
    } finally {
      exitSpy.mockRestore();
    }
    return { calls, thrown };
  }

  it('the promoted audit failing still demotes the old primary, and the command fails naming both', async () => {
    const { calls, thrown } = await runFailover({ audit: true });
    expect(calls.some(isDemotion), 'the old primary standby intent must still be set').toBe(true);
    expect(
      thrown,
      'a failover whose new primary archives nothing must exit non-zero',
    ).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/FAILOVER COMPLETED, BACKUPS DID NOT/);
    expect(msg).toMatch(/promoted cluster: write-guard not confirmed/);
    expect(msg).toMatch(/reads the standby role/);
    expect(msg).toMatch(/old primary: demoted to the standby wal-g role/);
  });

  it('both arms failing: the exit names both failures', async () => {
    const { thrown } = await runFailover({ audit: true, demote: true });
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/promoted cluster: write-guard not confirmed/);
    expect(msg).toMatch(/old primary: NOT demoted/);
    expect(msg).toMatch(/Connection refused/);
  });

  it('a clean arm with an unreachable old primary completes without a throw', async () => {
    const { calls, thrown } = await runFailover({ demote: true });
    expect(calls.some(isDemotion)).toBe(true);
    expect(thrown).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Census: the demotion can never again be skipped by an early return.
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../../src/failover.js', import.meta.url));

/** Blank out comments and string/template literal text, keeping offsets. */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      out += q;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += q;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The body of `restorePromotedWalgRole`, comments and strings blanked. */
function functionBody(): { raw: string; code: string } {
  const src = readFileSync(SRC, 'utf8');
  const start = src.indexOf('export async function restorePromotedWalgRole(');
  expect(start, 'restorePromotedWalgRole not found in src/failover.js').toBeGreaterThan(-1);
  // Strip from the function on, so a literal earlier in the file cannot
  // desynchronise the scanner.
  const tail = src.slice(start);
  const code = stripCommentsAndStrings(tail);
  // Skip the destructured parameter list's braces: the body is the first `{`
  // after the closing `)` of the signature.
  const open = code.indexOf(') {') + 2;
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}' && --depth === 0) {
      return { raw: tail.slice(open, j + 1), code: code.slice(open, j + 1) };
    }
  }
  throw new Error('unbalanced braces in restorePromotedWalgRole');
}

type Block = 'finally' | 'function' | 'other';

/** The blocks enclosing an offset in `code`, outermost first. */
function enclosingBlocks(code: string, offset: number): Block[] {
  const stack: Block[] = [];
  for (let j = 0; j < offset; j++) {
    if (code[j] === '{') {
      const before = code.slice(Math.max(0, j - 200), j);
      if (/\bfinally\s*$/.test(before)) stack.push('finally');
      else if (/=>\s*$/.test(before) || /\bfunction\b[^;{}]*\)\s*$/.test(before)) {
        stack.push('function');
      } else stack.push('other');
    } else if (code[j] === '}') stack.pop();
  }
  return stack;
}

const insideFinally = (code: string, offset: number) =>
  enclosingBlocks(code, offset).includes('finally');

/** A return inside a nested function (a probe callback) returns from that one. */
const insideNestedFunction = (code: string, offset: number) =>
  enclosingBlocks(code, offset).includes('function');

describe('census: restorePromotedWalgRole demotes before any return', () => {
  it('the demotion call sits in a finally, and no return precedes it outside one', () => {
    const { raw, code } = functionBody();
    // demoteK8sWalgRole: the one k8s standby role write (slot-drop-on-demotion census).
    const demotion = raw.indexOf('demoteK8sWalgRole(');
    expect(demotion, 'the old-primary demotion call is missing').toBeGreaterThan(-1);
    expect(insideFinally(code, demotion), 'the demotion must run in a finally block').toBe(true);
    const offenders: number[] = [];
    for (const m of code.slice(0, demotion).matchAll(/\breturn\b/g)) {
      const at = m.index ?? 0;
      if (!insideFinally(code, at) && !insideNestedFunction(code, at)) offenders.push(at);
    }
    expect(
      offenders.map((o) => raw.slice(o, raw.indexOf('\n', o)).trim()),
      'a return before the demotion (outside its finally) can skip disarming the old primary',
    ).toEqual([]);
  });
});
