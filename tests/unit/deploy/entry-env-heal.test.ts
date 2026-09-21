/**
 * Final review M1 (2026-09-21): `deploy` and `scale` heal a pre-2026-09-20
 * `.env`/`.env.local` at ENTRY, before their first env read. Compose was
 * already truncating such a value server-side, but the k8s/gitops paths
 * never handed the file to Compose — the old CLI parser decoded `'\''`
 * correctly and rendered the right Secret, so shipping the truncated read
 * would have been a regression until `upgrade` ran.
 *
 * Two layers, no infra:
 *   1. the hook the commands call (`repairLegacyEnvQuoting`) on a fixture
 *      project: every later reader (`readEnvFiles`, the k8s `loadEnvLocal`
 *      shape, `.env` as the bundle baseline) sees the decoded value;
 *   2. a source pin that deploy's `main` and scale's `run` call the hook
 *      before the first place either reads env (deploy: the 0d
 *      `findMissingRequiredEnv` preflight; scale: the strategy dispatch that
 *      pulls the local `.env` into the bundle).
 * Fixture values only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDotenv, readEnvFiles } from '../../../src/lib/dotenv.js';
import { loadEnvVariables, repairLegacyEnvQuoting } from '../../../src/lib/project.js';

const ROOT = join(import.meta.dirname, '../../..');

describe('deploy/scale entry heal — the hook the commands call', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('after the entry heal, every reader deploy uses sees the decoded value', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vc-deploy-heal-'));
    dirs.push(cwd);
    writeFileSync(join(cwd, '.env'), "JWT_SECRET=abc\nSMTP_PASS='pa'\\''ss'\n");
    writeFileSync(join(cwd, '.env.local'), "SMTP_PASS='pa'\\''ss'\nHETZNER_API_TOKEN=t\n");
    const log = { info: vi.fn(), warn: vi.fn() };

    // Before: the truncated read every reader would act on.
    expect(readEnvFiles(cwd).SMTP_PASS).toBe('pa');

    repairLegacyEnvQuoting(cwd, { log });

    // readEnvFiles — the merged read (preflight's operatorCheckEnvs, status).
    expect(readEnvFiles(cwd).SMTP_PASS).toBe("pa'ss");
    // loadEnvVariables — .env.local only (k8s loadEnvLocal → Secrets, gitops env secrets).
    expect(loadEnvVariables(cwd).SMTP_PASS).toBe("pa'ss");
    // .env alone — the compose bundle baseline renderBundle copies verbatim.
    expect(parseDotenv(readFileSync(join(cwd, '.env'), 'utf-8'))).toEqual({
      JWT_SECRET: 'abc',
      SMTP_PASS: "pa'ss",
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).not.toContain("pa'ss");
  });
});

describe('deploy/scale entry heal — call order pinned in source', () => {
  const body = (src: string, opener: string) => {
    const start = src.indexOf(opener);
    expect(start, `${opener} not found`).toBeGreaterThan(-1);
    return src.slice(start);
  };
  const runsBefore = (fn: string, a: string, b: string) => {
    const ia = fn.indexOf(a);
    const ib = fn.indexOf(b);
    expect(ia, `${a} not found`).toBeGreaterThan(-1);
    expect(ib, `${b} not found`).toBeGreaterThan(-1);
    expect(ia, `${a} must run before ${b}`).toBeLessThan(ib);
  };

  it('deploy.js main() heals before the 0d env preflight and the operator gate', () => {
    const src = readFileSync(join(ROOT, 'src/deploy.js'), 'utf-8');
    expect(src).toMatch(
      /import \{[^}]*\brepairLegacyEnvQuoting\b[^}]*\} from '\.\/lib\/project\.js'/,
    );
    const main = body(src, 'async function main(values, positional) {');
    runsBefore(main, 'repairLegacyEnvQuoting(', 'findMissingRequiredEnv(');
    runsBefore(main, 'repairLegacyEnvQuoting(', 'findEnvDrift(');
    runsBefore(main, 'repairLegacyEnvQuoting(', 'assertOperatorConfig(');
    runsBefore(main, 'repairLegacyEnvQuoting(', 'await gatherDeploymentConfig(');
    runsBefore(main, 'repairLegacyEnvQuoting(', 'await executeDeployment(');
    // …but only once inside a project (the guard is the documented first action).
    runsBefore(main, 'assertInProjectDir(', 'repairLegacyEnvQuoting(');
  });

  it('scale.js run() heals after the project guard and before the strategy that bundles the local .env', () => {
    const src = readFileSync(join(ROOT, 'src/scale.js'), 'utf-8');
    expect(src).toMatch(
      /import \{[^}]*\brepairLegacyEnvQuoting\b[^}]*\} from '\.\/lib\/project\.js'/,
    );
    const run = body(src, 'export async function run(args) {');
    runsBefore(run, 'assertInProjectDir(', 'repairLegacyEnvQuoting(');
    runsBefore(run, 'repairLegacyEnvQuoting(', 'SCALE_STRATEGIES[tier](');
  });
});
