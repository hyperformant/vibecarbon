/**
 * `vibecarbon scale -direct` builds the replacement's app image on the new
 * server, for an operator whose docker cannot build amd64 (Apple Silicon
 * without emulation), and the deploy's recorded build mode decides it when the
 * flag is absent (replacementImagePlan). The deploy records that mode
 * (imageBuildRecord) on compose tiers.
 */
import { describe, expect, it } from 'vitest';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { imageBuildRecord } from '../../../src/lib/deploy/compose/app-image.js';
import { replacementImagePlan, SPEC } from '../../../src/scale.js';

describe('scale -direct', () => {
  it('is a documented boolean flag', () => {
    const flag = SPEC.flags.find((f: { name: string }) => f.name === 'direct');
    expect(flag?.boolean).toBe(true);
    expect(flag?.description).toMatch(/new server/);
    expect(parseFlags(['-direct'], SPEC).values.direct).toBe(true);
  });
});

describe('replacementImagePlan', () => {
  const local = 'myapp-app:local';
  it('delta only with docker here and no direct choice', () => {
    expect(replacementImagePlan(local, { localDocker: true })).toBe('delta');
    expect(replacementImagePlan(local, { localDocker: false })).toBe('remote-build');
    expect(replacementImagePlan(local, { localDocker: true, recorded: 'direct' })).toBe(
      'remote-build',
    );
    expect(replacementImagePlan(local, { localDocker: true, forceDirect: true })).toBe(
      'remote-build',
    );
    expect(replacementImagePlan(local, { localDocker: true, recorded: 'local' })).toBe('delta');
  });
  it('a registry image is pulled whatever the mode', () => {
    expect(replacementImagePlan('ghcr.io/o/r:abc', { localDocker: true, forceDirect: true })).toBe(
      'pull',
    );
    expect(replacementImagePlan('', { localDocker: true })).toBe('pull');
  });
});

describe('imageBuildRecord: the deploy records its build mode on compose tiers', () => {
  it('records local, direct and push on compose and compose-ha', () => {
    for (const tier of ['compose', 'compose-ha']) {
      for (const mode of ['local', 'direct', 'push']) {
        expect(imageBuildRecord(tier, mode)).toEqual({ imageBuild: mode });
      }
    }
  });
  it('records nothing on k8s tiers', () => {
    expect(imageBuildRecord('k8s', 'local')).toEqual({});
    expect(imageBuildRecord('k8s-ha', 'local')).toEqual({});
  });
  it("is spread into the orchestrator's final env save", async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url),
      'utf-8',
    );
    const save = src.slice(src.indexOf("status: 'deployed',\n      deployMode,"));
    expect(save.slice(0, 400)).toMatch(/\.\.\.imageBuildRecord\(tier, buildMode\)/);
  });
});
