/**
 * Regression + census for the SILENT-SUCCESS class.
 *
 * RCA (2026-08-11 matrix, v1/vultr compose): `VULTR_API_TOKEN` was set but
 * invalid, so getApiToken fell through to its interactive `p.password()`
 * prompt. The e2e batch runs with `stdin < /dev/null`, and clack's prompt
 * promise NEVER SETTLES on an EOF/non-TTY stdin — it neither resolves nor
 * cancels, so `p.isCancel` never runs. Node's event loop simply drained and
 * the process exited **0** after 1.1s having provisioned nothing. The
 * sibling l1/linode run only failed loudly (missing `@pulumi/linode` at
 * provision-server) because its token happened to be VALID and it got that
 * far — the two modules are byte-identical in shape, so the asymmetry was
 * purely which runtime condition fired first.
 *
 * Two properties are pinned here:
 *   1. A credential prompt reached off-TTY must THROW (naming the env var),
 *      never open a prompt into a stdin that can never answer it.
 *   2. Nothing may exit 0 while a command is still in flight — the
 *      process-level backstop for every never-settling await we haven't
 *      thought of.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  password: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../../src/lib/project.js', () => ({ setEnvVar: vi.fn() }));

const SRC_LIB = fileURLToPath(new URL('../../../../src/lib/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Every provider/DNS guided-setup module — the credential-prompt family. */
function guidedSetupFiles(): string[] {
  return readdirSync(SRC_LIB)
    .filter((f) => f.endsWith('-guided-setup.js'))
    .sort();
}

// EVERY clack prompt that blocks on stdin. `confirm` and the multiselects were
// missing from the first cut of this census, which made a confirm-only
// function invisible to it — see the mutation probes below.
const ANY_PROMPT = /await p\.(password|text|select|confirm|multiselect|groupMultiselect)\(/;

// Top-level function boundaries, EXPORTED OR NOT: `function f`, `async
// function f`, and `const f = async (` arrow exports. Splitting only on
// `export` misattributed a non-exported helper's prompts to whichever export
// happened to precede it — so a guard on the export "covered" a helper that
// had none. Walking every function makes attribution exact and needs no
// caveat: the invariant is simply "any function that prompts, guards first".
const FUNCTION_START =
  /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = async \(/gm;

/**
 * Walk the family and return one string per violation.
 * @param overrides in-memory file contents, for the mutation probes.
 */
function promptGuardOffenders(overrides: Map<string, string> = new Map()): string[] {
  const offenders: string[] = [];
  for (const file of guidedSetupFiles()) {
    const src = overrides.get(file) ?? readFileSync(join(SRC_LIB, file), 'utf-8');
    const marks: Array<{ at: number; name: string }> = [];
    for (const m of src.matchAll(FUNCTION_START)) {
      marks.push({ at: m.index, name: m[1] ?? m[2] });
    }
    for (const [i, mark] of marks.entries()) {
      const body = src.slice(mark.at, marks[i + 1]?.at ?? src.length);
      const prompt = body.match(ANY_PROMPT);
      if (!prompt) continue;
      const guardIdx = body.indexOf('assertInteractiveStdin(');
      if (guardIdx === -1) offenders.push(`${file}:${mark.name} — no assertInteractiveStdin`);
      else if (guardIdx > prompt.index)
        offenders.push(`${file}:${mark.name} — guard AFTER first prompt`);
    }
  }
  return offenders;
}

/**
 * Apply a transform to one named function's body, leaving the rest of the
 * module byte-identical.
 */
function withinFunction(src: string, name: string, transform: (body: string) => string): string {
  const marks = [...src.matchAll(FUNCTION_START)].map((m) => ({
    at: m.index,
    name: m[1] ?? m[2],
  }));
  const i = marks.findIndex((m) => m.name === name);
  if (i === -1) throw new Error(`fixture drift: function ${name} not found`);
  const start = marks[i].at;
  const end = marks[i + 1]?.at ?? src.length;
  return src.slice(0, start) + transform(src.slice(start, end)) + src.slice(end);
}

/**
 * Neutralise the guard inside one function by RENAMING the call rather than
 * deleting its text. Biome reflows these calls across lines whenever the
 * arguments grow, so any mutation that matched an exact source line would
 * silently stop mutating after a reformat — and a mutation probe that no
 * longer mutates passes for the wrong reason, which is worse than no probe.
 */
function disarmGuardIn(file: string, fn: string): string {
  const src = readFileSync(join(SRC_LIB, file), 'utf-8');
  return withinFunction(src, fn, (body) => {
    if (!body.includes('assertInteractiveStdin(')) {
      throw new Error(`fixture drift: ${file}:${fn} has no guard to disarm`);
    }
    return body.replaceAll('assertInteractiveStdin(', 'noGuardHere(');
  });
}

// ── 1. The guard itself ────────────────────────────────────────────────────

describe('assertInteractiveStdin', () => {
  it('is a no-op on a TTY', async () => {
    const { assertInteractiveStdin } = await import('../../../../src/lib/cli/tty-guard.js');
    expect(() =>
      assertInteractiveStdin({
        what: 'the Vultr API key',
        envVar: 'VULTR_API_TOKEN',
        stdin: { isTTY: true },
      }),
    ).not.toThrow();
  });

  it('throws off-TTY, naming both the prompt and the env var that skips it', async () => {
    const { assertInteractiveStdin } = await import('../../../../src/lib/cli/tty-guard.js');
    expect(() =>
      assertInteractiveStdin({
        what: 'the Vultr API key',
        envVar: 'VULTR_API_TOKEN',
        stdin: { isTTY: false },
      }),
    ).toThrow(/VULTR_API_TOKEN/);
    expect(() =>
      assertInteractiveStdin({
        what: 'the Vultr API key',
        envVar: 'VULTR_API_TOKEN',
        stdin: { isTTY: false },
      }),
    ).toThrow(/not a TTY|non-interactive/i);
  });
});

// ── 2. Behavioural regression: the exact v1 vs l1 pair ─────────────────────

/**
 * The observed bug and its sibling, driven end-to-end through the real
 * guided-setup modules with a non-TTY stdin. Every one of these would have
 * hung-then-exited-0 before the fix.
 */
const CREDENTIAL_ENTRY_POINTS: Array<{ module: string; envVar: string }> = [
  { module: 'vultr-guided-setup.js', envVar: 'VULTR_API_TOKEN' },
  { module: 'linode-guided-setup.js', envVar: 'LINODE_API_TOKEN' },
  { module: 'hetzner-guided-setup.js', envVar: 'HETZNER_API_TOKEN' },
  { module: 'digitalocean-guided-setup.js', envVar: 'DIGITALOCEAN_API_TOKEN' },
  { module: 'cloudflare-guided-setup.js', envVar: 'CLOUDFLARE_API_TOKEN' },
  // Scaleway's credential is the secret key itself — it has no *_API_TOKEN
  // spelling, which is exactly why it needs to be listed rather than inferred.
  { module: 'scaleway-guided-setup.js', envVar: 'SCALEWAY_SECRET_KEY' },
];

describe('credential prompts off-TTY fail loudly instead of exiting 0', () => {
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.resetModules();
    clackMock.password.mockReset();
    clackMock.text.mockReset();
    // A prompt reached off-TTY is the bug: make any prompt that DOES open
    // hang exactly as the real one does, so a regression can never pass by
    // silently resolving.
    clackMock.password.mockImplementation(() => new Promise(() => {}));
    clackMock.text.mockImplementation(() => new Promise(() => {}));
    // vitest's stdin is already non-TTY; pin it so the assertion is explicit.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
  });

  for (const { module, envVar } of CREDENTIAL_ENTRY_POINTS) {
    it(`${module}: getApiToken rejects (never prompts) when ${envVar} is absent`, async () => {
      vi.stubEnv(envVar, '');
      const mod = (await import(`../../../../src/lib/${module}`)) as {
        getApiToken: (p?: string, o?: object) => Promise<unknown>;
      };
      await expect(mod.getApiToken('my-project', { save: false })).rejects.toThrow(
        new RegExp(envVar),
      );
      expect(clackMock.password).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    });
  }

  // The v1 failure verbatim: token PRESENT but rejected by the API, which is
  // what made vultr fall through to the prompt while linode sailed past.
  it('vultr: an INVALID env token falls through to the prompt — and now throws', async () => {
    vi.stubEnv('VULTR_API_TOKEN', 'A'.repeat(36));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const { getApiToken } = await import('../../../../src/lib/vultr-guided-setup.js');
    await expect(getApiToken('my-project', { save: false })).rejects.toThrow(/VULTR_API_TOKEN/);
    expect(clackMock.password).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

// ── 3. Census: the property holds for every member of the family ───────────

describe('census — every guided-setup credential entry point guards its prompt', () => {
  it('finds the whole family (all five providers/DNS)', () => {
    expect(guidedSetupFiles()).toHaveLength(CREDENTIAL_ENTRY_POINTS.length);
  });

  it('every function that opens a prompt calls assertInteractiveStdin first', () => {
    expect(promptGuardOffenders()).toEqual([]);
  });

  // Mutation probes — a census nobody has watched fail is just a passing test.
  // Each deletes the guard from a real module in memory and asserts the walk
  // notices, so the widened regexes are proven to bite rather than assumed to.
  it('MUTATION: catches a password prompt whose guard is deleted', () => {
    const mutated = new Map([
      ['vultr-guided-setup.js', disarmGuardIn('vultr-guided-setup.js', 'getApiToken')],
    ]);
    expect(promptGuardOffenders(mutated)).toEqual([
      'vultr-guided-setup.js:getApiToken — no assertInteractiveStdin',
    ]);
  });

  // The pre-widening regex omitted `confirm`, so a confirm-only function was
  // invisible to this census no matter how unguarded it was.
  it('MUTATION: catches a confirm-only function whose guard is deleted', () => {
    const mutated = new Map([
      ['cloudflare-guided-setup.js', disarmGuardIn('cloudflare-guided-setup.js', 'saveIfWanted')],
    ]);
    expect(promptGuardOffenders(mutated)).toEqual([
      'cloudflare-guided-setup.js:saveIfWanted — no assertInteractiveStdin',
    ]);
  });

  it('MUTATION: catches a guard placed AFTER the prompt it is meant to protect', () => {
    // Disarm the real guard, then re-add one BELOW the prompt it should
    // precede — a guard that runs after the prompt has already hung protects
    // nothing, and the census must say so rather than just seeing the name.
    const moved = withinFunction(
      disarmGuardIn('linode-guided-setup.js', 'getApiToken'),
      'getApiToken',
      (body) => {
        if (!body.includes('warnIfBadTokenFormat(token);')) {
          throw new Error('fixture drift: linode post-prompt anchor missing');
        }
        return body.replace(
          'warnIfBadTokenFormat(token);',
          "warnIfBadTokenFormat(token);\n    assertInteractiveStdin({ what: 'x', envVar: 'Y' });",
        );
      },
    );
    expect(promptGuardOffenders(new Map([['linode-guided-setup.js', moved]]))).toEqual([
      'linode-guided-setup.js:getApiToken — guard AFTER first prompt',
    ]);
  });
});

// ── 4. Census: a cancelled prompt must not look like success ───────────────

describe('census — cancelled prompts never exit 0', () => {
  function jsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsFilesUnder(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  /**
   * A cancel that neither exits non-zero NOR throws lets the command carry on
   * (or return) as if the operator had approved. `return` is as much a silent
   * success as `exit(0)` — access.js used to do exactly that, cancelling the
   * self-lockout prompt and then falling through to remove the CIDR anyway.
   */
  function cancelEscapeOffenders(overrides: Map<string, string> = new Map()): string[] {
    const offenders: string[] = [];
    for (const file of jsFilesUnder(join(REPO_ROOT, 'src'))) {
      const rel = file.replace(REPO_ROOT, '');
      const lines = (overrides.get(rel) ?? readFileSync(file, 'utf-8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Skip prose: only a real call, not a mention inside a comment.
        if (!/\bp\.cancel\(/.test(lines[i]) || /^\s*[*/]/.test(lines[i])) continue;
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          if (/process\.exit\(0\)/.test(lines[j])) offenders.push(`${rel}:${j + 1} — exit(0)`);
          else if (/^\s*return\b/.test(lines[j])) offenders.push(`${rel}:${j + 1} — bare return`);
        }
      }
    }
    return offenders;
  }

  it('no p.cancel() handler escapes via exit(0) or a bare return', () => {
    expect(cancelEscapeOffenders()).toEqual([]);
  });

  it('MUTATION: catches a cancel that escapes by returning', () => {
    const mutated = new Map([
      [
        'src/access.js',
        ['if (p.isCancel(ok)) {', "  p.cancel('Cancelled.');", '  return;', '}'].join('\n'),
      ],
    ]);
    expect(cancelEscapeOffenders(mutated)).toEqual(['src/access.js:3 — bare return']);
  });
});

// ── 4b. Census: cancel and decline are distinct, and neither is success ────

describe('census — an explicit "no" never routes to 130 or 0', () => {
  function jsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsFiles(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const CONFLATED =
    /if \(\s*(?:p\.isCancel\((\w+)\)\s*\|\|\s*!\1|!(\w+)\s*\|\|\s*p\.isCancel\(\2\))\s*\)([\s\S]{0,120})/g;

  /**
   * The conflated form `if (p.isCancel(x) || !x)` forced ONE exit code onto
   * two different operator intents: Ctrl-C (an interrupt, 130) and an explicit
   * "no" (a considered refusal, 1).
   *
   * SCOPED TO BRANCHES THAT EXIT. Conflation is only a defect when the branch
   * ENDS THE PROCESS, because then the code is the only thing the caller sees.
   * Where the branch instead returns a value the caller consumes — "Add Redis?"
   * → `return false`, "Replace license?" → `return`, "Overwrite?" → `return
   * null` — declining is an ordinary answer the surrounding flow handles, not a
   * silent success, and forcing an exit code on those would be wrong. That
   * distinction is why this walks the branch BODY rather than the condition.
   */
  it('no site that EXITS conflates isCancel with a falsy answer', () => {
    const offenders: string[] = [];
    for (const file of jsFiles(join(REPO_ROOT, 'src'))) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(CONFLATED)) {
        // Ignore prose: the doc comment in exit-guard.js quotes this pattern.
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*[*/]/.test(src.slice(lineStart, m.index))) continue;
        if (!/exitCancelled\(|exitDeclined\(|process\.exit\(/.test(m[3])) continue;
        offenders.push(
          `${file.replace(REPO_ROOT, '')}:${src.slice(0, m.index).split('\n').length}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('MUTATION: catches a re-conflated exiting branch', () => {
    const src = ['if (p.isCancel(ok) || !ok) {', '  exitCancelled();', '}'].join('\n');
    const found = [...src.matchAll(CONFLATED)].filter((m) =>
      /exitCancelled\(|exitDeclined\(|process\.exit\(/.test(m[3]),
    );
    expect(found).toHaveLength(1);
  });

  it('exitDeclined exits 1 and exitCancelled exits 130', async () => {
    const { DECLINED_EXIT_CODE, CANCELLED_EXIT_CODE } = await import(
      '../../../../src/lib/cli/exit-guard.js'
    );
    expect(DECLINED_EXIT_CODE).toBe(1);
    expect(CANCELLED_EXIT_CODE).toBe(130);
  });
});

// ── 5. The universal backstop ──────────────────────────────────────────────

describe('unsettled-command exit guard', () => {
  it('turns a never-settling command into a loud non-zero exit', () => {
    // A faithful stand-in for the v1 failure: an await that never settles
    // (clack prompt on EOF stdin), inside a command the CLI awaited.
    const script = [
      `import { installUnsettledExitGuard } from ${JSON.stringify(join(REPO_ROOT, 'src/lib/cli/exit-guard.js'))};`,
      'const settled = installUnsettledExitGuard();',
      'async function main() { await new Promise(() => {}); }',
      'main().then(settled.done, settled.done);',
    ].join('\n');

    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/without completing|never completed/i);
  });

  it('stays out of the way when the command settles normally', () => {
    const script = [
      `import { installUnsettledExitGuard } from ${JSON.stringify(join(REPO_ROOT, 'src/lib/cli/exit-guard.js'))};`,
      'const settled = installUnsettledExitGuard();',
      'async function main() { return 1; }',
      'main().then(settled.done, settled.done);',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    expect(out).toBe('');
  });

  // L2: `beforeExit` can fire on a drain that a later handler rescues — the
  // command settles after all. The guard must retract its own verdict rather
  // than leave a 70 on a run that finished.
  it('done() retracts the exit code it set when the command settles late', () => {
    const script = [
      `import { installUnsettledExitGuard } from ${JSON.stringify(join(REPO_ROOT, 'src/lib/cli/exit-guard.js'))};`,
      'const settled = installUnsettledExitGuard();',
      // Resolve only once the drain has already happened.
      'let release; const stalled = new Promise((r) => { release = r; });',
      'process.once("beforeExit", () => { setImmediate(release); });',
      'stalled.then(settled.done);',
    ].join('\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    // execFileSync throws on a non-zero exit, so reaching here IS the assertion.
    expect(true).toBe(true);
  });
});

// ── 6. M4: the deploy diagnostic survives the exit-70 path ─────────────────

describe('deploy completion guard on the unsettled-drain path', () => {
  it('evaluateExitGuard annotates code 70 without changing it', async () => {
    const { evaluateExitGuard } = await import('../../../../src/lib/deploy/completion-guard.js');
    const { UNSETTLED_EXIT_CODE } = await import('../../../../src/lib/cli/exit-guard.js');

    // Armed, never completed, drained → keep 70 but say what it means.
    const drained = evaluateExitGuard({
      armed: true,
      completed: false,
      exitCode: UNSETTLED_EXIT_CODE,
    });
    expect(drained.fail).toBe(true);
    expect(drained.exitCode).toBe(UNSETTLED_EXIT_CODE);
    expect(drained.message).toMatch(/NOT persisted/);

    // The original silent-exit-0 case still forces a failure code.
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 0 })).toMatchObject({
      fail: true,
      exitCode: 1,
    });
    // A real failure that already reported itself is never masked.
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 1 }).fail).toBe(false);
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 130 }).fail).toBe(false);
    // A completed deploy is untouched on every code.
    expect(evaluateExitGuard({ armed: true, completed: true, exitCode: 0 }).fail).toBe(false);
  });

  it('a hung deploy prints BOTH the unsettled message and the deploy diagnostic', () => {
    const script = [
      `import { installUnsettledExitGuard } from ${JSON.stringify(join(REPO_ROOT, 'src/lib/cli/exit-guard.js'))};`,
      `import { armDeployCompletionGuard } from ${JSON.stringify(join(REPO_ROOT, 'src/lib/deploy/completion-guard.js'))};`,
      'const settled = installUnsettledExitGuard();',
      'armDeployCompletionGuard();',
      // A deploy that hangs and never marks completion.
      'async function main() { await new Promise(() => {}); }',
      'main().then(settled.done, settled.done);',
    ].join('\n');

    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        // completion-guard skips registration under Vitest; this is a real
        // process standing in for the CLI, so clear the marker.
        env: { ...process.env, VITEST: '' },
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }
    expect(status).toBe(70);
    expect(stderr).toMatch(/without completing/i);
    expect(stderr).toMatch(/configuration was NOT persisted/);
    expect(stderr).toMatch(/Treat this environment as NOT deployed/);
  });
});
