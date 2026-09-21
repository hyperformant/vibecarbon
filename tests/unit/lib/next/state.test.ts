import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProjectState } from '../../../../src/lib/next/state.js';

/** No-op stand-ins so a test never shells out to docker or loads configure.js. */
const noComposePs = () => ({ available: false, running: [] });
const noFeatures: Array<{
  value: string;
  label: string;
  isConfigured: (env: Record<string, string>, ctx: { projectConfig: object }) => boolean;
}> = [];
const noOperatorKeys = () => [] as string[];

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    composePs: noComposePs,
    features: noFeatures,
    operatorKeys: noOperatorKeys,
    ...overrides,
  };
}

describe('detectProjectState', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reports no-project for an empty directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    const result = await detectProjectState(dir, baseDeps());
    expect(result).toEqual({ kind: 'no-project', cwd: dir });
  });

  it('reports no-project when only package.json is present', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    const result = await detectProjectState(dir, baseDeps());
    expect(result).toEqual({ kind: 'no-project', cwd: dir });
  });

  it('reports no-project when the manifest exists but docker-compose.yml does not', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    const result = await detectProjectState(dir, baseDeps());
    expect(result).toEqual({ kind: 'no-project', cwd: dir });
  });

  it('reports a project with project.name from projectName when manifest and compose file are present', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(dir, baseDeps());
    expect(result.kind).toBe('project');
    expect((result as { project: { name: string } }).project).toEqual({ name: 'acme' });
  });

  it('maps composePs({available:false, running:[]}) to localDev.dockerAvailable === false', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(
      dir,
      baseDeps({ composePs: () => ({ available: false, running: [] }) }),
    );
    expect((result as { localDev: { dockerAvailable: boolean } }).localDev.dockerAvailable).toBe(
      false,
    );
  });

  it('passes the running services list through unchanged', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(
      dir,
      baseDeps({ composePs: () => ({ available: true, running: ['web', 'db'] }) }),
    );
    expect((result as { localDev: { running: string[] } }).localDev).toEqual({
      dockerAvailable: true,
      running: ['web', 'db'],
    });
  });

  it('includes a feature label when isConfigured returns true', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(
      dir,
      baseDeps({
        features: [{ value: 'cicd', label: 'CI/CD', isConfigured: () => true }],
      }),
    );
    expect((result as { configured: { features: string[] } }).configured.features).toEqual([
      'CI/CD',
    ]);
  });

  it('excludes the providers feature even when its predicate returns true', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(
      dir,
      baseDeps({
        features: [{ value: 'providers', label: 'Providers', isConfigured: () => true }],
      }),
    );
    expect((result as { configured: { features: string[] } }).configured.features).toEqual([]);
  });

  it('does not count a throwing predicate as configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(
      dir,
      baseDeps({
        features: [
          {
            value: 'oauth',
            label: 'OAuth',
            isConfigured: () => {
              throw new Error('boom');
            },
          },
        ],
      }),
    );
    expect((result as { configured: { features: string[] } }).configured.features).toEqual([]);
  });

  it('reports providers: true when an operator key has a non-blank value in .env.local', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(dir, '.env.local'), 'HETZNER_API_TOKEN=x\n');
    const result = await detectProjectState(
      dir,
      baseDeps({ operatorKeys: () => ['HETZNER_API_TOKEN'] }),
    );
    expect((result as { configured: { providers: boolean } }).configured.providers).toBe(true);
  });

  it('reports providers: false when the operator key value is blank', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(dir, '.env.local'), 'HETZNER_API_TOKEN=\n');
    const result = await detectProjectState(
      dir,
      baseDeps({ operatorKeys: () => ['HETZNER_API_TOKEN'] }),
    );
    expect((result as { configured: { providers: boolean } }).configured.providers).toBe(false);
  });

  it('includes only live environments, ignoring destroyedEnvironments, preserving order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'acme',
        environments: {
          prod: { status: 'deployed' },
        },
        destroyedEnvironments: {
          staging: { status: 'destroyed' },
        },
      }),
    );
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(dir, baseDeps());
    expect((result as { environments: unknown[] }).environments).toEqual([
      {
        name: 'prod',
        status: 'deployed',
        deployMode: null,
        region: null,
        domain: null,
        deployedAt: null,
      },
    ]);
  });

  it('lists two environments in manifest insertion order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'acme',
        environments: {
          staging: { status: 'deployed', deployMode: 'compose' },
          prod: { status: 'deployed', deployMode: 'k8s' },
        },
      }),
    );
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(dir, baseDeps());
    const names = (result as { environments: Array<{ name: string }> }).environments.map(
      (e) => e.name,
    );
    expect(names).toEqual(['staging', 'prod']);
  });

  it('returns a deploying status as-is, leaving step decisions to the caller', async () => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'acme',
        environments: {
          prod: { status: 'deploying', deployMode: 'compose', region: 'fsn1' },
        },
      }),
    );
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const result = await detectProjectState(dir, baseDeps());
    expect((result as { environments: unknown[] }).environments).toEqual([
      {
        name: 'prod',
        status: 'deploying',
        deployMode: 'compose',
        region: 'fsn1',
        domain: null,
        deployedAt: null,
      },
    ]);
  });

  describe('configured.any truth table', () => {
    it('is false when there are no configured features and no providers', async () => {
      dir = mkdtempSync(join(tmpdir(), 'next-state-'));
      writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const result = await detectProjectState(dir, baseDeps());
      expect((result as { configured: { any: boolean } }).configured.any).toBe(false);
    });

    it('is true when a feature is configured but no providers', async () => {
      dir = mkdtempSync(join(tmpdir(), 'next-state-'));
      writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const result = await detectProjectState(
        dir,
        baseDeps({ features: [{ value: 'cicd', label: 'CI/CD', isConfigured: () => true }] }),
      );
      expect((result as { configured: { any: boolean } }).configured.any).toBe(true);
    });

    it('is true when providers are configured but no features', async () => {
      dir = mkdtempSync(join(tmpdir(), 'next-state-'));
      writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(join(dir, '.env.local'), 'HETZNER_API_TOKEN=x\n');
      const result = await detectProjectState(
        dir,
        baseDeps({ operatorKeys: () => ['HETZNER_API_TOKEN'] }),
      );
      expect((result as { configured: { any: boolean } }).configured.any).toBe(true);
    });

    it('is true when both features and providers are configured', async () => {
      dir = mkdtempSync(join(tmpdir(), 'next-state-'));
      writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(join(dir, '.env.local'), 'HETZNER_API_TOKEN=x\n');
      const result = await detectProjectState(
        dir,
        baseDeps({
          features: [{ value: 'cicd', label: 'CI/CD', isConfigured: () => true }],
          operatorKeys: () => ['HETZNER_API_TOKEN'],
        }),
      );
      expect((result as { configured: { any: boolean } }).configured.any).toBe(true);
    });
  });
});
