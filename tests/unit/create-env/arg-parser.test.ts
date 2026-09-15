import { describe, expect, it } from 'vitest';
import { buildLegacyArgs, SPEC } from '../../../src/deploy.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import {
  itParsesBooleanFlags,
  itParsesEnvSeed,
  itRejectsDoubleDash,
} from '../../_shared/arg-parser-suite.js';

describe('deploy SPEC + parseFlags integration', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({
      h: false,
      v: false,
      y: false,
      env: null,
      region: null,
      mode: null,
      full: false,
    });
    expect(r.positional.env).toBeUndefined();
  });

  itParsesEnvSeed(SPEC);

  it('parses -region <id>', () => {
    expect(parseFlags(['-region', 'fsn1'], SPEC).values.region).toBe('fsn1');
    expect(parseFlags(['-region', 'hel1'], SPEC).values.region).toBe('hel1');
  });

  it('parses -server-type <id> and buildLegacyArgs hands it to the prompt chain as serverType', () => {
    // A -y compose deploy with no serverType in the env block takes the
    // region's MEDIUM-tier default (cpx32/cx33, ~2x the price of cpx22) and
    // the only override was editing .vibecarbon.json (2026-09-15 prod move).
    // Flag name matches `failover -server-type` — `scale -type` means
    // "scale TO type" and keeps its own spelling.
    expect(parseFlags(['-server-type', 'cpx22'], SPEC).values['server-type']).toBe('cpx22');
    const { values, positional } = parseFlags(['prod', '-server-type', 'cpx22'], SPEC);
    expect(buildLegacyArgs(values, positional).serverType).toBe('cpx22');
    expect(buildLegacyArgs(parseFlags([], SPEC).values, {}).serverType).toBeNull();
  });

  it('parses -mode <enum> against the four declared modes', () => {
    expect(parseFlags(['-mode', 'compose'], SPEC).values.mode).toBe('compose');
    expect(parseFlags(['-mode', 'compose-ha'], SPEC).values.mode).toBe('compose-ha');
    expect(parseFlags(['-mode', 'k8s'], SPEC).values.mode).toBe('k8s');
    expect(parseFlags(['-mode', 'k8s-ha'], SPEC).values.mode).toBe('k8s-ha');
  });

  it('rejects -mode values outside the enum', () => {
    const r = parseFlags(['-mode', 'kubernetes'], SPEC);
    expect(r.values.mode).toBeNull();
    expect(r.errors[0]).toMatch(/-mode must be one of: compose, compose-ha, k8s, k8s-ha/);
  });

  it('parses -full as a boolean (clears resume state)', () => {
    expect(parseFlags(['-full'], SPEC).values.full).toBe(true);
  });

  itParsesBooleanFlags(SPEC);

  it('handles a fully-scripted invocation end-to-end', () => {
    const r = parseFlags(['prod', '-mode', 'k8s-ha', '-region', 'hel1', '-y'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.positional.env).toBe('prod');
    expect(r.values.mode).toBe('k8s-ha');
    expect(r.values.region).toBe('hel1');
    expect(r.values.y).toBe(true);
  });

  itRejectsDoubleDash(SPEC, ['--region hel1', '--k8s', '--ha', '--compose', '--full', '--help']);

  it('rejects all dropped power-user long flags as unknown', () => {
    // Mode flags collapsed into -mode <enum>.
    for (const dropped of ['--k8s', '--ha', '--compose']) {
      expect(parseFlags([dropped], SPEC).errors).toEqual([`unknown flag: ${dropped}`]);
    }
    // Server-type / DNS / S3 / backup / worker-bound flags moved to
    // prompts and `.vibecarbon.json`.
    for (const dropped of [
      '--master-type',
      '--worker-type',
      '--supabase-type',
      '--type',
      '--domain',
      '--dns-provider',
      '--s3-access-key',
      '--s3-secret-key',
      '--s3-region',
      '--backup-schedule',
      '--backup-retention-days',
      '--min-workers',
      '--max-workers',
      '--secondary-region',
    ]) {
      const r = parseFlags([dropped, 'value'], SPEC);
      expect(r.errors[0]).toMatch(new RegExp(`unknown flag: ${dropped.replace(/-/g, '\\-')}`));
    }
  });

  it('rejects -e / -t / -d / -r short forms (the old POSIX shorthands are gone)', () => {
    // The new convention: only -h, -v, -y, -l are single-letter; everything
    // else is spelled out (-env, -type, -domain, -region).
    expect(parseFlags(['-e', 'prod'], SPEC).errors[0]).toMatch(/unknown flag: -e/);
    expect(parseFlags(['-t', 'cx33'], SPEC).errors[0]).toMatch(/unknown flag: -t/);
    expect(parseFlags(['-d', 'app.io'], SPEC).errors[0]).toMatch(/unknown flag: -d/);
    expect(parseFlags(['-r', 'hel1'], SPEC).errors[0]).toMatch(/unknown flag: -r/);
  });
});
