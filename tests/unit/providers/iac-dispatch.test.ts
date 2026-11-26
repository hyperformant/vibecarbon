/**
 * IaC program dispatch (CD2), for every provider in the registry.
 *
 * `getComposeProgram` and `getK8sProgram` are the one seam the deploy
 * engine builds a Pulumi program through. Each must dynamic-import its
 * program module (`src/lib/iac/programs/<id>-<compose|k8s>.js`) and hand
 * `config` to the module's builder untouched, returning exactly what the
 * builder returns. A tier the provider does not sell has no program and
 * its static refuses by name.
 *
 * The rows are `PROVIDERS` times the two program kinds, so a provider added
 * to the registry is checked here without an edit. The builder's name is
 * read from the program module itself; the program module is mocked, so
 * this pins dispatch identity only. That the provider graph never loads
 * `@pulumi/*` eagerly is iac-dispatch-laziness.test.ts, which must not mock
 * the program modules, or it would hide a real eager import.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { K8S_BUILT_AHEAD } from '../../_shared/k8s-built-ahead.js';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';

const PROGRAMS_DIR = 'src/lib/iac/programs';

const KINDS = [
  { kind: 'compose', method: 'getComposeProgram', tier: 'compose' },
  { kind: 'k8s', method: 'getK8sProgram', tier: 'k8s' },
] as const;

const ROWS = Object.entries(PROVIDERS).flatMap(([id, Provider]) =>
  KINDS.map(({ kind, method, tier }) => ({
    id,
    name: Provider.NAME,
    kind,
    method,
    // A k8s program built ahead of its tier is dispatched already.
    built:
      Provider.SUPPORTED_TIERS.includes(tier) ||
      (kind === 'k8s' && (K8S_BUILT_AHEAD[id] ?? []).includes('program')),
    program: `${PROGRAMS_DIR}/${id}-${kind}.js`,
  })),
);

/** The program module's one exported `build...Program`. */
function builderOf(program: string): string {
  const names = [...readRepoFile(program).matchAll(/^export function (build\w+Program)\(/gm)].map(
    (m) => m[1],
  );
  expect(names, `${program} should export exactly one build...Program`).toHaveLength(1);
  return names[0];
}

/**
 * The static named by `method`, on a provider class loaded after the
 * program module was replaced by `{ [builder]: build }`.
 */
async function dispatchThrough(row: (typeof ROWS)[number], build: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock(join(REPO_ROOT, row.program), () => ({ [builderOf(row.program)]: build }));
  const { PROVIDERS: fresh } = await import('../../../src/lib/providers/index.js');
  const Provider = fresh[row.id as keyof typeof fresh];
  return (config: unknown) => (Provider[row.method] as (c: unknown) => Promise<unknown>)(config);
}

afterEach(() => {
  for (const row of ROWS) vi.doUnmock(join(REPO_ROOT, row.program));
});

it('every program module is reached by a registered provider tier, and every built tier has one', () => {
  const onDisk = readdirSync(join(REPO_ROOT, PROGRAMS_DIR))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${PROGRAMS_DIR}/${f}`)
    .sort();
  const dispatched = ROWS.filter((r) => r.built)
    .map((r) => r.program)
    .sort();
  expect(dispatched).toEqual(onDisk);
});

describe.each(ROWS.filter((r) => r.built))('$id $method', (row) => {
  it('forwards config verbatim to the program module builder', async () => {
    const build = vi.fn().mockReturnValue(async () => ({}));
    const config = { projectName: 'proj', environment: 'prod', location: 'region-1' };

    await (await dispatchThrough(row, build))(config);

    expect(build).toHaveBeenCalledTimes(1);
    // The same object: no defaulting, cloning or mutation in the static.
    expect(build.mock.calls[0][0]).toBe(config);
    expect(build).toHaveBeenCalledWith(config);
  });

  it('returns exactly the builder-produced program closure', async () => {
    const sentinelProgram = async () => ({ serverIp: '9.9.9.9' });
    const build = vi.fn().mockReturnValue(sentinelProgram);

    expect(await (await dispatchThrough(row, build))({ any: 'config' })).toBe(sentinelProgram);
  });

  it('propagates a builder throw without wrapping it', async () => {
    const build = vi.fn(() => {
      throw new Error('allowedSshIps required');
    });

    await expect((await dispatchThrough(row, build))({})).rejects.toThrow(
      /^allowedSshIps required$/,
    );
  });
});

describe.each(ROWS.filter((r) => !r.built))('$id $method', (row) => {
  it('refuses by name: the provider does not sell this tier', async () => {
    const Provider = PROVIDERS[row.id as keyof typeof PROVIDERS];
    await expect((Provider[row.method] as (c: unknown) => Promise<unknown>)({})).rejects.toThrow(
      `${row.name}'s ${row.kind} tier is not built`,
    );
  });
});
