/**
 * Census of the "scp outside the transient-retry wrapper" class (2026-08-11).
 *
 * The failure: a hetzner/compose-ha warm deploy died at step merge-walg-role
 * because `mergeRemoteDotenv`'s scp hit `Connection timed out during banner
 * exchange` exactly once. SSH to the same host worked seconds before and
 * after. The `ssh` calls on either side of that copy were already retrying
 * that wording through sshRunAsync — but EVERY scp in the deploy path spawned
 * `runCommandAsync(['scp', …])` bare, so the whole family had zero retries.
 * Ten sites, one fix each, would have left the eleventh open.
 *
 * THIS test is the class guard, and it drafts future members automatically:
 * it sweeps src/ for anything that spawns scp and fails unless the site lives
 * in the wrapper's own module. A new copy step written the old way fails here
 * on the day it is written rather than on the night it eats a deploy.
 *
 * Split of duties:
 *   - Ladder behavior (retries, classification, ignoreError-after-exhaustion)
 *     is proven behaviorally against a real spawned fake scp in
 *     scp-transient-retry.test.ts — existence-checked below so the pointer
 *     cannot rot.
 *   - Per-site error-message framing that callers depend on is pinned here,
 *     because the conversion had to thread each wrapper's message through a
 *     new helper without flattening it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/**
 * The one module allowed to spawn scp. Everything else routes through its
 * `scpWithRetry` export.
 */
const WRAPPER_MODULE = 'src/lib/ssh.js';

/** Behavioral depth for the ladder itself; existence-checked, not read. */
const DEEP_TESTS = ['tests/unit/lib/scp-transient-retry.test.ts'];

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** A quoted `scp` used as an argv element / spawner target: ['scp', …],
 *  spawn('scp'), execFile('scp', …). */
const ARGV_SCP_RE = /(['"])scp\1\s*[,)\]]/;

/** A command STRING that starts with `scp ` — the shell-form escape hatch
 *  (`runCommand('scp -i …')`, `sshRunScript(\`scp …\`)`). */
const SHELL_SCP_RE = /(['"`])\s*scp\s+-/;

function detectScpSpawn(line: string): boolean {
  return ARGV_SCP_RE.test(line) || SHELL_SCP_RE.test(line);
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function findSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        findSourceFiles(join(dir, entry.name), out);
      }
    } else if (entry.name.endsWith('.js')) {
      out.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  text: string;
}

function collectSites(): { spawns: Site[]; consumers: Set<string> } {
  const spawns: Site[] = [];
  const consumers = new Set<string>();
  for (const file of findSourceFiles(join(ROOT, 'src'))) {
    const lines = readFileSync(join(ROOT, file), 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (detectScpSpawn(line)) spawns.push({ file, line: i + 1, text: line.trim() });
      if (/\bscpWithRetry\s*\(/.test(line) && file !== WRAPPER_MODULE) consumers.add(file);
    });
  }
  return { spawns, consumers };
}

const { spawns, consumers } = collectSites();

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('scp call-site census', () => {
  it('the detector still sees the scp population (not vacuously green)', () => {
    // If a refactor drops this to zero the sweep has gone blind — fix the
    // detector, don't relax the rule.
    expect(spawns.length).toBeGreaterThanOrEqual(1);
  });

  it('only the wrapper module spawns scp — everything else routes through it', () => {
    const strays = spawns.filter((s) => s.file !== WRAPPER_MODULE);
    expect(
      strays.map((s) => `${s.file}:${s.line}  ${s.text}`),
      `New bare scp call site(s). A bare scp has NO transient-transport retry: one ` +
        `'Connection timed out during banner exchange' fails the whole deploy (2026-08-11, ` +
        `merge-walg-role). Route it through scpWithRetry() from ${WRAPPER_MODULE} instead.`,
    ).toEqual([]);
  });

  it('the converted consumers are all still routed (a mass revert fails here)', () => {
    // Drafted from the sweep, not hand-listed: the floor is what makes a
    // silent re-inline visible.
    expect(
      [...consumers].sort(),
      'Consumers of scpWithRetry dropped below the converted set — did a site get re-inlined?',
    ).toEqual([
      'src/lib/deploy/k8s/ha/index.js',
      'src/lib/deploy/k8s/k3s.js',
      'src/lib/deploy/utils.js',
    ]);
  });

  it('every consumer imports the helper from the wrapper module', () => {
    const missing = [...consumers].filter(
      (file) =>
        !/import\s*\{[^}]*\bscpWithRetry\b[^}]*\}\s*from\s*['"][^'"]*ssh\.js['"]/s.test(
          readFileSync(join(ROOT, file), 'utf-8'),
        ),
    );
    expect(missing, 'scpWithRetry used without importing it from lib/ssh.js').toEqual([]);
  });

  it('the wrapper actually wraps: retry ladder + the shared classifier', () => {
    const src = readFileSync(join(ROOT, WRAPPER_MODULE), 'utf-8');
    expect(src).toMatch(/export async function scpWithRetry/);
    // A wrapper that stopped retrying would satisfy every other assertion
    // here while restoring the exact bug.
    expect(src).toMatch(/runWithRetry\(/);
    expect(src).toMatch(/isTransient:\s*isTransientSshCommandError/);
  });

  it('the behavioral ladder tests it defers to still exist', () => {
    for (const t of DEEP_TESTS) expect(existsSync(join(ROOT, t)), `missing: ${t}`).toBe(true);
  });
});

describe('per-site error framing survived the conversion', () => {
  const utils = readFileSync(join(ROOT, 'src/lib/deploy/utils.js'), 'utf-8');

  it('mergeRemoteDotenv still distinguishes a failed pull from a failed push', () => {
    // The push message is the operationally load-bearing one: it tells the
    // operator the remote still holds the PREVIOUS .env, so the deploy is
    // half-applied rather than corrupt.
    expect(utils).toMatch(/Failed to pull \$\{remoteDir\}\/\.env from \$\{host\}/);
    expect(utils).toMatch(/remote still has the previous contents/);
  });

  it('the best-effort pushes still swallow their failures (ignoreError preserved)', () => {
    // setupServerFiles copies optional files that may legitimately be absent;
    // converting them must not turn a missing prometheus dir into a hard fail.
    const swallowed = utils.match(/ignoreError:\s*true/g) ?? [];
    expect(swallowed.length).toBeGreaterThanOrEqual(6);
  });
});

describe('detector sanity (not vacuously permissive)', () => {
  it('flags every argv shape the repo actually used', () => {
    expect(detectScpSpawn("      ['scp', ...sshOpts.split(' '), local, dest],")).toBe(true);
    expect(detectScpSpawn("        'scp',")).toBe(true);
    expect(detectScpSpawn("  const r = spawn('scp');")).toBe(true);
    expect(detectScpSpawn("  execFile('scp', args);")).toBe(true);
  });

  it('flags the shell-string escape hatch', () => {
    expect(detectScpSpawn("  await runCommand('scp -i key a b');")).toBe(true);
    expect(detectScpSpawn('  await sshRun(ip, key, `scp -r x y`);')).toBe(true);
  });

  it('does not flag prose, identifiers, or the helper call itself', () => {
    expect(detectScpSpawn('  await scpWithRetry([...sshOpts, local, dest]);')).toBe(false);
    expect(detectScpSpawn("  const label = 'scp-upload';")).toBe(false);
    expect(detectScpSpawn('  // scp the kubeconfig down')).toBe(false);
  });
});
