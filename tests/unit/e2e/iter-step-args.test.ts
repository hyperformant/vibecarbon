/**
 * `scripts/iter-step.js` must run each step with arguments that step's own
 * command accepts. It hand-listed one exception (status) and gave every other
 * step `<env> -y`, so `iter-step <rig> diagnose` died on `unknown flag: -y`
 * before diagnosing anything (live on a Linode k8s rig, 2026-11-08). These
 * tests parse the built arguments with the CLI's own parser and spec, so a
 * new step, or a command that gains or drops `-y`, cannot drift again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../../src/lib/cli/command-registry.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { REPO_ROOT } from '../../../tests/e2e/utils/e2e-env.js';
import {
  ITER_STEPS,
  isPurgeDestroy,
  iterStepCliArgs,
} from '../../../tests/e2e/utils/iter-step-args.js';

const ENV = 'prod-e2e1234';

async function specOf(step: string) {
  const entry = COMMANDS.find((c) => c.name === step);
  if (!entry) throw new Error(`no CLI command named "${step}"`);
  return entry.loadSpec();
}

describe('iter-step runs each step with arguments its command accepts', () => {
  it.each(ITER_STEPS)('%s parses cleanly and reaches the rig env', async (step) => {
    const [name, ...rest] = await iterStepCliArgs(step, ENV, []);
    expect(name).toBe(step);
    const spec = await specOf(step);
    const parsed = parseFlags(rest, spec);
    expect(parsed.errors).toEqual([]);
    if ((spec.positional ?? []).some((p: { name: string }) => p.name === 'env')) {
      expect(parsed.positional.env).toBe(ENV);
    }
  });

  it('diagnose gets the rig env and no -y; status gets neither', async () => {
    expect(await iterStepCliArgs('diagnose', ENV, [])).toEqual(['diagnose', ENV]);
    expect(await iterStepCliArgs('status', ENV, [])).toEqual(['status']);
    expect(await iterStepCliArgs('destroy', ENV, [])).toEqual(['destroy', ENV, '-y']);
  });

  it("passes the caller's arguments after the env, where the command reads them", async () => {
    const diagnose = await iterStepCliArgs('diagnose', ENV, ['nodes']);
    const parsed = parseFlags(diagnose.slice(1), await specOf('diagnose'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.positional).toMatchObject({ env: ENV, section: 'nodes' });

    const failover = await iterStepCliArgs('failover', ENV, ['-dry']);
    expect(failover).toEqual(['failover', ENV, '-y', '-dry']);
    expect(parseFlags(failover.slice(1), await specOf('failover')).values.dry).toBe(true);
  });

  it('backup defaults to -action create unless the caller chose an action', async () => {
    expect(await iterStepCliArgs('backup', ENV, [])).toEqual([
      'backup',
      ENV,
      '-y',
      '-action',
      'create',
    ]);
    expect(await iterStepCliArgs('backup', ENV, ['-l'])).toEqual(['backup', ENV, '-y', '-l']);
    expect(await iterStepCliArgs('backup', ENV, ['-action', 'list'])).toEqual([
      'backup',
      ENV,
      '-y',
      '-action',
      'list',
    ]);
  });

  it('the script takes its steps and arguments from this module', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'iter-step.js'), 'utf-8');
    expect(script).toMatch(/iterStepCliArgs\(step, envPrefix, extraArgs\)/);
    expect(script).toMatch(/new Set\(ITER_STEPS\)/);
    // No hand-built argv left beside it.
    expect(script).not.toMatch(/'-y'/);
    expect(script).not.toMatch(/'-action'/);
  });

  it("only destroy -purge is a full teardown, read with the CLI's own parser", async () => {
    expect(await isPurgeDestroy('destroy', ['-purge'])).toBe(true);
    expect(await isPurgeDestroy('destroy', [])).toBe(false);
    expect(await isPurgeDestroy('destroy', ['-y'])).toBe(false);
    expect(await isPurgeDestroy('backup', ['-purge'])).toBe(false);
  });

  it("the script runs the lifecycle's post-destroy cleanup only after destroy -purge", () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'iter-step.js'), 'utf-8');
    const gate = script.indexOf('if (await isPurgeDestroy(step, extraArgs)) {');
    const cleanup = script.indexOf('await finishRigTeardown(');
    expect(gate).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(gate);
    // One call, inside that branch.
    expect(script.split('await finishRigTeardown(').length).toBe(2);
    expect(script.slice(gate, cleanup)).not.toMatch(/\n {2}\}\n/);
  });
});
