/**
 * The CI matrix's per-leg `scenarios` filter, tested by RUNNING it.
 *
 * `.github/workflows/e2e-us-perf.yml` has one `scenarios` dispatch input but
 * one job per provider, and scenario tokens are provider-qualified. The
 * selection grammar hard-errors on a token outside the `--provider` pool
 * (tests/e2e/selection.ts: "is outside --provider", pinned by
 * selection-grammar.test.ts) — so broadcasting the raw input to every leg
 * kills whichever leg the token doesn't name. The workflow's own example
 * input, `hetzner/k8s-ha,digitalocean/compose`, was a guaranteed
 * SelectionError on at least one leg under every provider choice.
 *
 * The fix lives in shell inside the leg step, which no type-checker or
 * census can see. This test extracts that step's `run:` script, neuters the
 * one line that would spend real money (`pnpm test:e2e:batch …` becomes an
 * echo of the assembled flags), and executes the rest under bash with the
 * same `-e` + `pipefail` semantics GitHub uses. That makes the assertions
 * about actual behavior — comma splitting, whitespace tolerance, the
 * skip-with-exit-0 branch — rather than about the text of the script.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/e2e-us-perf.yml';
const LEG_STEP_NAME = 'Run e2e (provider leg)';

interface WorkflowDoc {
  jobs?: { matrix?: { steps?: Array<{ name?: string; run?: string }> } };
}

function legStepScript(): string {
  const doc = loadYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowDoc;
  const step = doc.jobs?.matrix?.steps?.find((s) => s.name === LEG_STEP_NAME);
  if (!step?.run) {
    throw new Error(`${WORKFLOW_PATH}: no matrix step named '${LEG_STEP_NAME}' with a run: script`);
  }
  return step.run;
}

/**
 * Replace the real batch invocation with an echo of the flags it would have
 * received. Anchored on the command name, so a change to its flags or tee
 * target keeps working — but a rename of the command fails loudly here
 * rather than silently running the e2e suite from a unit test.
 */
function neuter(script: string): string {
  const marker = /^\s*pnpm test:e2e:batch .*$/m;
  if (!marker.test(script)) {
    throw new Error(
      `${WORKFLOW_PATH}: leg step no longer invokes \`pnpm test:e2e:batch\` — ` +
        'this test must be re-anchored before it can safely execute the script.',
    );
  }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell array expansion, not a JS placeholder
  return script.replace(marker, 'printf "%s\\n" "${FLAGS[@]}"');
}

const workDir = mkdtempSync(join(tmpdir(), 'vc-leg-filter-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** Run the leg step's script as GitHub would (`bash -e`, plus its own pipefail). */
function runLeg(provider: string, scenarios: string): { stdout: string; flags: string[] } {
  const stdout = execFileSync('bash', ['-e', '-c', neuter(legStepScript())], {
    cwd: workDir,
    env: { ...process.env, PROVIDER: provider, SCENARIOS: scenarios },
    encoding: 'utf8',
  });
  const flags = stdout
    .split('\n')
    .filter((l) => l.length > 0 && !l.startsWith('no scenarios for this provider'));
  return { stdout, flags };
}

describe('e2e-us-perf.yml leg step filters `scenarios` to its own provider', () => {
  it('passes the provider defaults (no --scenario) when the input is empty', () => {
    const { flags } = runLeg('hetzner', '');
    expect(flags).toEqual(['--skip-steps', 'setup-repo', '--provider', 'hetzner']);
  });

  it('keeps only this leg’s tokens from a mixed-provider input', () => {
    const input = 'hetzner/k8s-ha,digitalocean/compose';

    const hetzner = runLeg('hetzner', input);
    expect(hetzner.flags).toEqual([
      '--skip-steps',
      'setup-repo',
      '--provider',
      'hetzner',
      '--scenario',
      'hetzner/k8s-ha',
    ]);

    const digitalocean = runLeg('digitalocean', input);
    expect(digitalocean.flags).toEqual([
      '--skip-steps',
      'setup-repo',
      '--provider',
      'digitalocean',
      '--scenario',
      'digitalocean/compose',
    ]);
  });

  it('rejoins multiple same-provider tokens into one comma-separated --scenario', () => {
    const { flags } = runLeg('hetzner', 'hetzner/compose,digitalocean/compose,hetzner/k8s');
    expect(flags.slice(-2)).toEqual(['--scenario', 'hetzner/compose,hetzner/k8s']);
  });

  it('tolerates spaces around the commas', () => {
    const { flags } = runLeg('digitalocean', 'hetzner/k8s-ha , digitalocean/compose');
    expect(flags.slice(-2)).toEqual(['--scenario', 'digitalocean/compose']);
  });

  it('skips the leg (exit 0, no run) when the named subset excludes this provider', () => {
    const { stdout, flags } = runLeg('digitalocean', 'hetzner/k8s-ha');
    // The whole point: NOT a SelectionError, and NOT a fall-through to
    // DigitalOcean's default selection either — the dispatcher asked for a
    // subset that names no DigitalOcean scenario.
    expect(flags).toEqual([]);
    expect(stdout).toContain('no scenarios for this provider');
  });
});
