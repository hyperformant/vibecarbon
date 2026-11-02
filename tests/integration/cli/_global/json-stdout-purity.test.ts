/**
 * `-json` stdout purity, CLI-wide.
 *
 * DO e2e 2026-11-02: `vibecarbon status -json` printed a clack `│` gutter and
 * `●  ✓ Using Spaces credentials from ...` ahead of the JSON, because status
 * reaches the guided-setup credential resolvers and they log through
 * `p.log.info` (stdout). Any code a JSON command calls can do that, so the
 * contract is structural: in JSON mode stdout carries ONLY the document and
 * everything else goes to stderr.
 *
 * Census: every command whose SPEC declares a `json` flag must have a fixture
 * here, so a new JSON command cannot ship without proving the contract.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyRealProject, realProject, runCli } from '../../_harness/index.js';

const NOTICE = /Using Spaces credentials from/;

/** Per-command fixture: builds a project whose run reaches the credential notice. */
const FIXTURES: Record<string, (project: string) => void> = {
  status: (project) => {
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.environments = {
      prod: {
        provider: 'digitalocean',
        deployMode: 'compose',
        domain: 'prod.example.invalid',
        status: 'deployed',
        servers: [{ name: 'prod', ip: '127.0.0.1' }],
        backup: { lineage: '1' },
        // Bucket recorded, keys not: backup health resolves them from the
        // shell env, which is where the "Using Spaces credentials" line fires.
        backupS3: { bucket: 'b', region: 'nyc3', endpoint: 'http://127.0.0.1:9' },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  },
};

describe('-json keeps stdout to the JSON document', () => {
  const projects: string[] = [];
  afterEach(() => {
    for (const p of projects.splice(0)) destroyRealProject(p);
  });

  it('every command with a json flag has a fixture (census)', async () => {
    const { loadAllSpecs } = await import('../../../../src/lib/cli/command-registry.js');
    const specs = await loadAllSpecs();
    const jsonCommands = specs
      .filter(({ spec }: any) => (spec.flags ?? []).some((f: any) => f.name === 'json'))
      .map(({ entry }: any) => entry.name)
      .sort();
    expect(jsonCommands.length).toBeGreaterThan(0);
    expect(Object.keys(FIXTURES).sort()).toEqual(jsonCommands);
  });

  for (const [command, setup] of Object.entries(FIXTURES)) {
    it(`${command} -json: stdout parses as JSON, notices go to stderr`, () => {
      const project = realProject({ envs: ['prod'] });
      projects.push(project);
      setup(project);

      const r = runCli(command, ['-json'], {
        cwd: project,
        timeoutMs: 60_000,
        env: {
          DIGITALOCEAN_ACCESS_KEY: 'DO00FAKEACCESSKEY',
          DIGITALOCEAN_SECRET_KEY: 'fakesecretfakesecretfakesecret',
        },
      });

      expect(() => JSON.parse(r.stdout), `stdout was:\n${r.stdout}`).not.toThrow();
      expect(r.stdout).not.toMatch(NOTICE);
      expect(r.stdout).not.toContain('│');
      // The fixture must actually reach the notice, or this proves nothing.
      expect(r.stderr).toMatch(NOTICE);
    });
  }
});
