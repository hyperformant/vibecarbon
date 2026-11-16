/**
 * The scanner a generated project runs from its pre-commit hook
 * (carbon/scripts/secret-scan.mjs), exercised as the hook runs it: a child
 * process given file paths, exit 1 on a finding.
 *
 * Every token here is assembled at run time from an obviously fake body
 * (repeated letters, the alphabet). None was ever issued by a provider.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'carbon', 'scripts', 'secret-scan.mjs');

const FAKE_64 = 'a'.repeat(64);
const FAKE_UUID = '00000000-aaaa-bbbb-cccc-000000000000';

const PROVIDER_FIXTURES: Array<{ ruleId: string; line: string }> = [
  { ruleId: 'hetzner-token', line: `HETZNER_API_TOKEN="${FAKE_64}"` },
  { ruleId: 'digitalocean-token', line: `DIGITALOCEAN_TOKEN=dop_v1_${'ab'.repeat(32)}` },
  { ruleId: 'linode-token', line: `LINODE_TOKEN="${FAKE_64}"` },
  { ruleId: 'vultr-token', line: 'VULTR_API_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { ruleId: 'scaleway-access-key', line: `SCW_ACCESS_KEY=SCW${'FAKE0'.repeat(3)}FA` },
  { ruleId: 'scaleway-secret-key', line: `SCALEWAY_SECRET_KEY=${FAKE_UUID}` },
];

describe('the generated project pre-commit secret scan', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-project-scan-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scan = (args: string[], input?: string) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf-8', input });

  for (const { ruleId, line } of PROVIDER_FIXTURES) {
    it(`refuses a staged file holding a ${ruleId}`, () => {
      writeFileSync(join(dir, 'config.txt'), `# deploy settings\n${line}\n`);
      const r = scan(['config.txt']);
      expect(r.stderr).toContain(`[${ruleId}]`);
      expect(r.status).toBe(1);
    });
  }

  it('reads the file list from stdin, as the hook passes it', () => {
    writeFileSync(join(dir, 'a.txt'), `${PROVIDER_FIXTURES[1].line}\n`);
    const r = scan(['--stdin'], 'a.txt\n');
    expect(r.stderr).toContain('[digitalocean-token]');
    expect(r.status).toBe(1);
  });

  it('passes a clean file', () => {
    writeFileSync(join(dir, 'ok.ts'), 'export const greeting = "hello";\n');
    const r = scan(['ok.ts']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('honours .vibecarbonignore', () => {
    writeFileSync(join(dir, 'config.txt'), `${PROVIDER_FIXTURES[3].line}\n`);
    writeFileSync(
      join(dir, '.vibecarbonignore'),
      '# fixture\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n',
    );
    const r = scan(['config.txt']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('does not open binary extensions', () => {
    writeFileSync(join(dir, 'logo.png'), `${PROVIDER_FIXTURES[1].line}\n`);
    expect(scan(['logo.png']).status).toBe(0);
  });
});
