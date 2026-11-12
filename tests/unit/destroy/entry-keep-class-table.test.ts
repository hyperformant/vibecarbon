/**
 * One keep predicate for the environment's entry and its stack state.
 *
 * destroy keeps the Pulumi stack state exactly when it keeps the
 * environment's entry in .vibecarbon.json, and keeps the entry exactly when a
 * re-run of `vibecarbon destroy <env>` can still find and remove something.
 * Which ledger lines meet that is one table, ENTRY_KEEP_BY_CLASS in
 * src/destroy.js; entryKeptReason reads it for every reader (the config step,
 * the compose tiers' stack-state step, the state bucket under -purge).
 *
 * The defect (final review I1, 2026-11-11): a refused DNS delete became a
 * leak, which kept the compose stack while the entry was removed. Nothing
 * could destroy that stack any more, and the next deploy of the name picked
 * it up (the Vultr refresh-404 class, e2e run 32309395314). The other half
 * (I2): hints told the operator to re-run `vibecarbon destroy <env>` after the
 * entry was gone, so the re-run reported an unknown environment while a
 * server kept billing.
 *
 * Covered here:
 *   - the census: every class a ledger call in src/ can emit has a row, and
 *     every step of every tier's destroy plan has a destroy-step row;
 *   - fail closed: an unknown class or step keeps the entry;
 *   - through the real destroy plan (planDestroy + runPlan + DESTROY_EFFECTS):
 *     a refused DNS delete keeps neither the stack nor the entry; a
 *     compose-ha teardown that throws keeps both and says to re-run; a re-run
 *     against resources already gone removes both (no keep-forever loop);
 *   - a step that throws offers a re-run exactly when its line keeps the
 *     entry, and in the compose plans no step after the stack-state step can
 *     keep it, so the two cannot disagree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, projectConfigStore } from '../helpers/project-config-store.js';

const logs: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const push = (kind: string) => (m: string) => logs.push(`${kind}:${m}`);
  return {
    ...actual,
    log: {
      success: push('success'),
      warn: push('warn'),
      error: push('error'),
      info: push('info'),
      message: push('message'),
      step: push('step'),
    },
    note: push('note'),
    outro: push('outro'),
  };
});

const store = projectConfigStore();
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

/** What the fake clouds answer; each test sets the parts it needs. */
const world = {
  serverDelete: 'gone' as 'gone' | 'deleted' | 'throws' | 'leaves-volume',
  refusedDns: [] as string[],
  haTeardown: 'clean' as 'clean' | 'throws',
  removedStacks: [] as string[],
};

function FakeProvider() {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'constructor') return FakeProvider;
      if (prop === 'deleteServer') {
        return async (
          _id: unknown,
          options?: { onLeftover?: (line: Record<string, string>) => void },
        ) => {
          if (world.serverDelete === 'throws') throw new Error('server is locked (HTTP 423)');
          if (world.serverDelete === 'leaves-volume') {
            // What Scaleway's deleteServer hands over for a detached SBS
            // volume it could not delete.
            options?.onLeftover?.({
              resourceClass: 'detached-volume',
              resource: 'SBS volume vol-9 (fr-par-1)',
              reason: "server 11's delete left it behind, and deleting it failed for 60 s",
              hint: 'Delete it in the FakeCloud console under Volumes; it bills until removed.',
            });
            return true;
          }
          return world.serverDelete === 'deleted';
        };
      }
      if (prop === 'deleteFirewallByName') {
        return async () => ({ deleted: false, everExisted: false, apiError: null });
      }
      if (prop === 'listServersDetailed') return async () => ({ items: [], complete: true });
      if (prop === 'listVolumesDetailed') return async () => ({ items: [], complete: true });
      if (prop === 'deleteReservedIpsByLabels') return async () => ({ deleted: [], failed: [] });
      if (/^(delete|remove|destroy|detach|release)/.test(prop)) return async () => false;
      if (/^(list|find|get)/.test(prop)) return async () => [];
      return () => undefined;
    },
  };
  return new Proxy({}, handler);
}
Object.assign(FakeProvider, {
  NAME: 'FakeCloud',
  RESERVED_IP_NAME: 'reserved IP',
  COMPOSE_FLOATING_IP: false,
  OBJECT_STORAGE_ENV: ['FAKE_ACCESS_KEY', 'FAKE_SECRET_KEY'],
});

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, providerFor: () => FakeProvider };
});

vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getDnsProvider: async () => ({
      getZones: async () => [],
      deleteApexAndWildcard: async (_t: string, _z: string, domain: string) => {
        const failed = world.refusedDns.map((name) => ({
          name,
          target: '203.0.113.1',
          reason: 'HTTP 403: token lacks Zone.DNS edit',
        }));
        return { deletedAny: failed.length < 2, preservedTargets: [], failed, domain };
      },
      deleteHealthCheck: async () => false,
    }),
  };
});

vi.mock('../../../src/lib/iac/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    removeStackState: async (stackEnv: string) => {
      world.removedStacks.push(stackEnv);
      return { removed: true };
    },
  };
});

vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  // An absent stack, as destroyStack answers once a destroy removed it.
  return { ...real, destroyK8s: async () => ({ destroyed: false }) };
});

// Nothing here may run a real command (gh, kubectl): a GitHub environment
// delete against this repository would be real.
vi.mock('../../../src/lib/command.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    runCommand: () => {
      throw new Error('no external commands in this test');
    },
  };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyComposeHA: async () => {
      if (world.haTeardown === 'throws') throw new Error('GET /servers failed: HTTP 503');
      return { leaks: [], handledServerIds: [] };
    },
  };
});

const { DESTROY_EFFECTS, ENTRY_KEEP_BY_CLASS, keepsEntry, PULUMI_TYPE_RESOURCE_CLASS } =
  await import('../../../src/destroy.js');
const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { planDestroy } = await import('../../../src/lib/deploy/plan/destroy-plan.js');
const { runPlan } = await import('../../../src/lib/deploy/plan/runner.js');
const { TIERS } = await import('../../../src/lib/deploy/tier-registry.js');

type Entry = { severity: string; resourceClass: string; resource: string; hint?: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const allText = () => logs.map(plain).join('\n');

let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  logs.length = 0;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  Object.assign(world, {
    serverDelete: 'gone',
    refusedDns: [],
    haTeardown: 'clean',
    removedStacks: [],
  });
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token-for-tests-only');
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
});

// ─────────────────────────── the class table ───────────────────────────

const SRC = join(__dirname, '../../../src');

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

/** Source without comment lines: JSDoc types name `resourceClass: string`. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/**
 * The resourceClass values that are not a literal, each with where its
 * classes come from. A new one fails the census until it is named here.
 */
const DYNAMIC_CLASS_SOURCES: Record<string, string> = {
  // destroyComposeHATier passes compose-ha's own lines through: ha.js's
  // noteLeak literals, which the census reads.
  'leak.resourceClass': 'ha.js noteLeak',
  // recordPulumiDestroyFailure: PULUMI_TYPE_RESOURCE_CLASS's values, or the
  // type token for an unmapped type, which has no row and keeps the entry.
  'pulumiResourceClass(r.type)': 'PULUMI_TYPE_RESOURCE_CLASS',
  // the ledger's normalization, with 'resource' for a line with no class.
  "oneLine(entry?.resourceClass) || 'resource'": 'leak-ledger.js',
  // formatLeakReport renders the class it was given.
  'entry.resourceClass': 'leak-ledger.js rendering',
};

/**
 * Every bare `resourceClass` (not `resourceClass: 'x'`, not `x: expr`, not a
 * read like `entry.resourceClass`) in src/, by file and line text: a
 * shorthand property (`{ resourceClass }`), a parameter or a variable. A
 * shorthand can hand the ledger a class no literal names, so a new one fails
 * the census until it is named here with where its class comes from.
 */
const BARE_CLASS_SITES: Record<string, string> = {
  'src/destroy.js :: function entryVerdict({ severity, resourceClass, resource }) {':
    "entryVerdict's parameter: it reads a line's class",
  'src/destroy.js :: if (!Object.hasOwn(ENTRY_KEEP_BY_CLASS, resourceClass)) return true;':
    'entryVerdict reads it',
  'src/destroy.js :: const { keeps } = ENTRY_KEEP_BY_CLASS[resourceClass];':
    'entryVerdict reads it',
  'src/lib/deploy/compose/ha.js :: const noteLeak = (resourceClass, resource, reason, hint) =>':
    "noteLeak's parameter: its callers pass literals, which the census reads",
  'src/lib/deploy/compose/ha.js :: leaks.push({ resourceClass, resource, reason, ...(hint && { hint }) });':
    "noteLeak's write of that parameter",
};

/** An expression up to its end: a depth-0 `,` `;` `)` `]` `}` or newline. */
function expressionAt(text: string): string {
  let depth = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if ((ch === ',' || ch === ';' || ch === '\n') && depth === 0) break;
  }
  return text.slice(0, i).trim();
}

/**
 * Every code mention of `resourceClass` in `files` (path to code), sorted by
 * how it is written. A read (`x.resourceClass`, `x?.resourceClass`) is
 * skipped; an assignment to one (`x.resourceClass = expr`) is dynamic.
 */
function classMentions(files: Record<string, string>) {
  const literal = new Set<string>();
  const dynamic = new Set<string>();
  const bare = new Set<string>();
  for (const [file, code] of Object.entries(files)) {
    for (const m of code.matchAll(/\bresourceClass\b/g)) {
      const at = m.index ?? 0;
      const before = code.slice(0, at);
      const after = code.slice(at + m[0].length);
      if (/\??\.\s*$/.test(before)) {
        const assigned = after.match(/^\s*=(?![=>])\s*/);
        if (assigned) dynamic.add(expressionAt(after.slice(assigned[0].length)));
        continue;
      }
      const lit = after.match(/^\s*:\s*'([^']+)'/);
      if (lit) {
        literal.add(lit[1]);
        continue;
      }
      const colon = after.match(/^\s*:\s*/);
      if (colon) {
        dynamic.add(expressionAt(after.slice(colon[0].length)));
        continue;
      }
      const lineStart = code.lastIndexOf('\n', at) + 1;
      const lineEnd = code.indexOf('\n', at);
      bare.add(`${file} :: ${code.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim()}`);
    }
    for (const m of code.matchAll(/noteLeak\(\s*'([^']+)'/g)) literal.add(m[1]);
    for (const m of code.matchAll(/noteLeak\(\s*([^'\s)][^,]*)/g)) dynamic.add(`noteLeak(${m[1]}`);
  }
  return { literal, dynamic, bare };
}

/** The text inside the parentheses of the call whose `(` is at `open`. */
function callArgs(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** The destroy side: every server delete in these reports what it left. */
const DESTROY_SIDE = /^src\/(destroy\.js|lib\/destroy\/|lib\/deploy\/compose\/ha\.js)/;

/**
 * Server deletes on the destroy side that drop what a delete left behind
 * (Scaleway's detached SBS volumes): every `deleteServer(` call there passes
 * `onLeftover`, and so does every call of a function that takes it and
 * passes it on.
 */
function leftoverViolations(files: Record<string, string>): string[] {
  const forwarders = new Set<string>();
  for (const code of Object.values(files)) {
    for (const m of code.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)) {
      if (/\bonLeftover\b/.test(m[2])) forwarders.add(m[1]);
    }
  }
  const bad: string[] = [];
  for (const [file, code] of Object.entries(files)) {
    const names = DESTROY_SIDE.test(file) ? ['deleteServer', ...forwarders] : [...forwarders];
    for (const name of names) {
      for (const m of code.matchAll(new RegExp(`(?<!function\\s+)\\b${name}\\s*\\(`, 'g'))) {
        const open = (m.index ?? 0) + m[0].length - 1;
        if (name === 'deleteServer' && !/\.\s*$/.test(code.slice(0, m.index))) continue;
        if (!/\bonLeftover\b/.test(callArgs(code, open))) {
          bad.push(
            `${file}:${code.slice(0, m.index).split('\n').length} ${name}() without onLeftover`,
          );
        }
      }
    }
  }
  return bad;
}

describe('ENTRY_KEEP_BY_CLASS census', () => {
  const files = Object.fromEntries(
    jsFiles(SRC).map((path) => [`src/${relative(SRC, path)}`, codeOf(path)]),
  );
  const { literal, dynamic, bare } = classMentions(files);

  it('finds the emitters (the walk is not vacuous)', () => {
    for (const cls of ['server', 'dns-record', 'pulumi-stack', 'destroy-step', 'volume']) {
      expect(literal, cls).toContain(cls);
    }
  });

  it('every class not written as a literal comes from a source named here', () => {
    expect([...dynamic].sort()).toEqual(Object.keys(DYNAMIC_CLASS_SOURCES).sort());
    expect([...bare].sort()).toEqual(Object.keys(BARE_CLASS_SITES).sort());
  });

  // Final review N1: the walk read a non-literal class only at the end of its
  // line, so these escaped it.
  it('a class on one line with the rest, a shorthand, or an assignment is never missed', () => {
    const planted = classMentions({
      'src/a.js':
        "leaks.leak({ resourceClass: cls, resource: r });\nconst line = { resourceClass, resource };\nline.resourceClass = next;\nleaks.leak({ resourceClass: 'server', resource: x });\nif (entry.resourceClass === 'x') use(entry?.resourceClass);\n",
    });
    expect([...planted.literal]).toEqual(['server']);
    expect([...planted.dynamic].sort()).toEqual(['cls', 'next']);
    expect([...planted.bare]).toEqual(['src/a.js :: const line = { resourceClass, resource };']);
  });

  it('every destroy-side server delete reports what it left behind', () => {
    expect(leftoverViolations(files)).toEqual([]);
    // Not vacuous: the walk sees the calls and the forwarder.
    const calls = Object.entries(files)
      .filter(([file]) => DESTROY_SIDE.test(file))
      .flatMap(([, code]) => [...code.matchAll(/\.deleteServer\s*\(/g)]);
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('a destroy-side server delete, or a forwarder call, without onLeftover is refused', () => {
    expect(
      leftoverViolations({
        'src/destroy.js':
          'async function f() {\n  await provider.deleteServer(id, { waitUntilGone: true });\n}\n',
      }),
    ).toEqual(['src/destroy.js:2 deleteServer() without onLeftover']);
    expect(
      leftoverViolations({
        'src/lib/destroy/x.js':
          'async function reap(p, { onLeftover } = {}) {\n  await p.deleteServer(1, { onLeftover });\n}\nawait reap(p);\n',
      }),
    ).toEqual(['src/lib/destroy/x.js:4 reap() without onLeftover']);
    // Scale deletes are not destroy's, and warn on their own.
    expect(leftoverViolations({ 'src/scale.js': 'await provider.deleteServer(id);\n' })).toEqual(
      [],
    );
  });

  it('every class a ledger call in src/ can emit has a row', () => {
    const emitted = new Set([
      ...literal,
      ...PULUMI_TYPE_RESOURCE_CLASS.map(([, cls]: [RegExp, string]) => cls),
      'resource',
    ]);
    const missing = [...emitted].filter((cls) => !Object.hasOwn(ENTRY_KEEP_BY_CLASS, cls));
    expect(missing, 'add a row: does a re-run of destroy find and remove it?').toEqual([]);
    // And no row outlives its emitter.
    const stale = Object.keys(ENTRY_KEEP_BY_CLASS).filter((cls) => !emitted.has(cls));
    expect(stale).toEqual([]);
  });

  it('every row says why, and every verdict is a boolean or a by-hand step', () => {
    for (const [cls, row] of Object.entries(ENTRY_KEEP_BY_CLASS) as [
      string,
      { keeps: unknown; why: string },
    ][]) {
      expect(row.why, cls).toMatch(/\w{3,}/);
      expect(row.why, cls).not.toContain('—');
      if (typeof row.keeps === 'boolean') continue;
      for (const [step, verdict] of Object.entries(row.keeps as Record<string, unknown>)) {
        if (verdict === true) continue;
        const byHand = (verdict as { byHand?: (env: string) => string }).byHand;
        expect(typeof byHand, `${cls}/${step}`).toBe('function');
        const text = byHand?.('prod') ?? '';
        expect(text, `${cls}/${step}`).toMatch(/\w{3,}/);
        expect(text, `${cls}/${step}`).not.toContain('—');
      }
    }
  });

  it('every step of every tier plan has a destroy-step verdict', () => {
    const steps = ENTRY_KEEP_BY_CLASS['destroy-step'].keeps as Record<string, unknown>;
    const missing = TIERS.flatMap((tier: string) => planDestroy(tier, {}))
      .map((step: { name: string }) => step.name)
      .filter((name: string) => !Object.hasOwn(steps, name));
    expect(missing).toEqual([]);
  });

  it('fails closed: an unknown class or an unknown step keeps the entry', () => {
    expect(keepsEntry({ severity: 'leak', resourceClass: 'quantum-disk', resource: 'q1' })).toBe(
      true,
    );
    expect(
      keepsEntry({ severity: 'unverified', resourceClass: 'constructor', resource: 'x' }),
    ).toBe(true);
    expect(
      keepsEntry({ severity: 'unverified', resourceClass: 'destroy-step', resource: 'new-step' }),
    ).toBe(true);
  });

  it('a line a re-run cannot act on keeps nothing: DNS records, health checks, buckets', () => {
    for (const resourceClass of ['dns-record', 'health-check', 'bucket']) {
      expect(keepsEntry({ severity: 'leak', resourceClass, resource: 'r' }), resourceClass).toBe(
        false,
      );
    }
  });

  it('FOREIGN and AT-RISK lines never keep it, whatever their class', () => {
    for (const severity of ['foreign', 'risk']) {
      expect(keepsEntry({ severity, resourceClass: 'server', resource: 's' })).toBe(false);
      expect(keepsEntry({ severity, resourceClass: 'quantum-disk', resource: 's' })).toBe(false);
    }
  });
});

// ─────────────────────────── a step that throws ───────────────────────────

describe('a destroy step that throws', () => {
  /**
   * A ctx every effect throws on before any I/O: no plan or cwd, and config
   * that throws when read, so an effect that tolerates a missing record (the
   * backups bucket's, read through backupsTargetOf) still throws.
   */
  function throwingCtx() {
    const unreadable = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    return {
      environment: 'prod',
      envConfig: unreadable,
      projectConfig: unreadable,
      results: { leaks: createLeakLedger() },
      spinner: {
        start() {
          throw new Error('boom');
        },
        stop() {},
        message() {},
      },
    };
  }

  const wrapped = TIERS.flatMap((tier: string) =>
    planDestroy(tier, {}).map((step: { name: string; effect: string }) => [tier, step] as const),
  ).filter(([, step]) => step.effect !== 'finishOutro');

  it.each(wrapped)(
    '%s %o: names its step, and offers a re-run exactly when it keeps the entry',
    async (_tier, step) => {
      const ctx = throwingCtx();
      await (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[
        step.effect
      ](ctx, {});
      const lines = ctx.results.leaks.entries as Entry[];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ resourceClass: 'destroy-step', resource: step.name });
      const rerun = /vibecarbon destroy prod` again once/.test(lines[0].hint ?? '');
      expect(rerun).toBe(keepsEntry(lines[0]));
      expect(lines[0].hint).not.toContain('—');
    },
  );

  it('in the compose plans, no step after the stack-state step keeps the entry', async () => {
    for (const tier of ['compose', 'compose-ha']) {
      const steps = planDestroy(tier, {});
      const at = steps.findIndex((s: { name: string }) => s.name === 'remove-stack-state');
      expect(at, tier).toBeGreaterThan(0);
      for (const step of steps.slice(at + 1)) {
        if (step.effect === 'finishOutro') continue;
        const ctx = throwingCtx();
        await (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[
          step.effect
        ](ctx, {});
        const [line] = ctx.results.leaks.entries as Entry[];
        expect(keepsEntry(line), `${tier}: ${step.name}`).toBe(false);
      }
    }
  });
});

// ─────────────────────────── through the destroy plan ───────────────────────────

const spinnerStops: string[] = [];
const spinner = {
  start: () => {},
  stop: (m?: string) => spinnerStops.push(m ?? ''),
  message: () => {},
};

function composeEnv(tier: 'compose' | 'compose-ha') {
  const servers =
    tier === 'compose-ha'
      ? [
          { name: 'primary', role: 'primary', ip: '203.0.113.1', id: 11 },
          { name: 'standby', role: 'standby', ip: '203.0.113.2', id: 12 },
        ]
      : [{ name: 'master', role: 'master', ip: '203.0.113.1', id: 11 }];
  return {
    provider: 'hetzner',
    deployMode: tier,
    status: 'deployed',
    region: 'nbg1',
    domain: 'app.example.test',
    dns: { provider: 'cloudflare', zoneId: 'zone1' },
    servers,
  };
}

/** One `vibecarbon destroy prod` of a compose tier, through its real plan. */
async function destroyOnce(tier: 'compose' | 'compose-ha') {
  const disk = store.state.disk as Config;
  const envConfig = disk.environments.prod;
  const projectConfig = structuredClone(disk);
  const stackEnvs = tier === 'compose-ha' ? ['prod-primary', 'prod-standby'] : ['prod'];
  const results = {
    leaks: createLeakLedger(),
    servers: [] as string[],
    volumes: [] as string[],
    firewalls: [] as string[],
    sshKeys: [] as string[],
    dns: [] as string[],
    healthChecks: [] as string[],
    loadBalancers: [] as string[],
    s3Bucket: null,
    github: false,
    pulumiDestroyFailed: false,
    unreleasedReservedIps: [] as string[],
  };
  logs.length = 0;
  spinnerStops.length = 0;
  world.removedStacks = [];
  const ctx = {
    plan: {
      tier,
      stackEnvs,
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      hasPulumiStack: false,
      ownedIps: envConfig.servers.map((s: { ip: string }) => s.ip),
    },
    envConfig,
    projectConfig,
    environment: 'prod',
    args: {},
    results,
    providerToken: 'tok',
    cwd: '/nonexistent-vibecarbon-entry-keep',
    spinner,
    tracker: { spinner: () => spinner, finish: () => ({ formatted: '1s' }) },
    isK8s: false,
  };
  await runPlan(planDestroy(tier, {}), ctx, DESTROY_EFFECTS);
  return {
    entries: results.leaks.entries as Entry[],
    entryKept: Boolean((store.state.disk as Config).environments?.prod),
    removedStacks: [...world.removedStacks],
    exitCode: process.exitCode,
  };
}

function deployed(tier: 'compose' | 'compose-ha') {
  store.reset({ projectName: 'proj', environments: { prod: composeEnv(tier) } });
}

describe('through the destroy plan', () => {
  it('compose: one refused DNS delete leaves neither the stack state nor the entry', async () => {
    deployed('compose');
    world.serverDelete = 'deleted';
    world.refusedDns = ['*.app.example.test'];

    const run = await destroyOnce('compose');

    expect(run.removedStacks).toEqual(['prod']);
    expect(run.entryKept).toBe(false);
    const leaks = run.entries.filter((e) => e.severity === 'leak');
    expect(leaks.map((e) => e.resourceClass)).toEqual(['dns-record']);
    // A by-hand step, never a re-run: the entry is gone.
    expect(leaks[0].hint).toContain('Delete *.app.example.test in your Cloudflare DNS settings');
    expect(allText()).not.toMatch(/vibecarbon destroy prod/);
    expect(allText()).not.toMatch(/stack state kept/i);
    expect(run.exitCode).toBe(2);
  });

  it('compose-ha: a teardown that throws keeps both, and the report says to re-run', async () => {
    deployed('compose-ha');
    world.haTeardown = 'throws';

    const run = await destroyOnce('compose-ha');

    expect(run.removedStacks).toEqual([]);
    expect(run.entryKept).toBe(true);
    expect(run.entries).toContainEqual(
      expect.objectContaining({ severity: 'unverified', resourceClass: 'compose-ha teardown' }),
    );
    const text = allText();
    expect(text).toMatch(/Pulumi stack state kept for prod-primary, prod-standby/);
    expect(text).toContain('re-run `vibecarbon destroy prod`');
    expect(text).not.toContain('next clean destroy');
    expect(spinnerStops.join('\n')).toMatch(
      /Configuration kept: the leak report lists what a re-run can still find and remove \(compose-ha teardown\)/,
    );
    expect(run.exitCode).toBe(2);
  });

  it("compose-ha: the kept entry's re-run, against resources already gone, removes both", async () => {
    deployed('compose-ha');
    world.haTeardown = 'throws';
    await destroyOnce('compose-ha');
    expect((store.state.disk as Config).environments.prod).toBeDefined();

    world.haTeardown = 'clean';
    const rerun = await destroyOnce('compose-ha');

    expect(rerun.removedStacks).toEqual(['prod-primary', 'prod-standby']);
    expect(rerun.entryKept).toBe(false);
    expect(rerun.entries).toEqual([]);
    expect(rerun.exitCode).toBe(0);
  });

  it('k8s: a re-run after the cluster is gone removes the entry, though nothing is left to capture', async () => {
    // The first destroy tore the cluster down and removed its kubeconfig, so
    // every later destroy's PersistentVolume capture fails. That line names
    // an identity source, not a resource: were it to keep the entry, no
    // destroy of a k8s environment could ever finish once its first one
    // kept the entry for something else.
    store.reset({
      projectName: 'proj',
      environments: { prod: { ...composeEnv('compose'), deployMode: 'kubernetes' } },
    });
    const ctx = {
      plan: {
        tier: 'k8s',
        stackEnvs: ['prod'],
        clusterNames: ['proj-prod'],
        hasPulumiStack: true,
        ownedIps: ['203.0.113.1'],
      },
      envConfig: (store.state.disk as Config).environments.prod,
      projectConfig: structuredClone(store.state.disk),
      environment: 'prod',
      args: {},
      results: {
        leaks: createLeakLedger(),
        servers: [] as string[],
        volumes: [] as string[],
        firewalls: [] as string[],
        sshKeys: [] as string[],
        dns: [] as string[],
        healthChecks: [] as string[],
        loadBalancers: [] as string[],
        pulumiDestroyFailed: false,
        unreleasedReservedIps: [] as string[],
      },
      providerToken: 'tok',
      cwd: '/nonexistent-vibecarbon-entry-keep',
      spinner,
      tracker: { spinner: () => spinner },
      isK8s: true,
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await DESTROY_EFFECTS.destroyK8sInfra(ctx, {});
    } finally {
      log.mockRestore();
    }
    const lines = ctx.results.leaks.entries as Entry[];
    expect(lines.map((e) => e.resourceClass)).toEqual(['volume-identity']);

    await DESTROY_EFFECTS.updateProjectConfig(ctx, {});

    expect((store.state.disk as Config).environments.prod).toBeUndefined();
  });

  // A volume the server's delete left behind bills on, and a re-run cannot
  // find it: a leak (exit 2) with the console step, keeping neither.
  it('compose: a volume the server delete left behind is a leak, and keeps nothing', async () => {
    deployed('compose');
    world.serverDelete = 'leaves-volume';

    const run = await destroyOnce('compose');

    const leaks = run.entries.filter((e) => e.severity === 'leak');
    expect(leaks.map((e) => e.resourceClass)).toEqual(['detached-volume']);
    expect(leaks[0].resource).toBe('SBS volume vol-9 (fr-par-1)');
    expect(leaks[0].hint).toContain('console');
    expect(run.exitCode).toBe(2);
    expect(run.entryKept).toBe(false);
    expect(run.removedStacks).toEqual(['prod']);
    expect(allText()).not.toMatch(/vibecarbon destroy prod/);
  });

  it('compose: a server delete that fails keeps both; the re-run once it is gone removes both', async () => {
    deployed('compose');
    world.serverDelete = 'throws';

    const first = await destroyOnce('compose');

    expect(first.removedStacks).toEqual([]);
    expect(first.entryKept).toBe(true);
    expect(first.entries.map((e) => e.resourceClass)).toContain('server');

    world.serverDelete = 'gone';
    const rerun = await destroyOnce('compose');

    expect(rerun.removedStacks).toEqual(['prod']);
    expect(rerun.entryKept).toBe(false);
    expect(rerun.entries).toEqual([]);
    expect(rerun.exitCode).toBe(0);
  });
});
