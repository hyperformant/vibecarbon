import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_GATES } from '../../../../src/lib/licensing/gate.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI = join(REPO_ROOT, 'src', 'cli.js');

// Licensing is deploy-mode-based, not command-based: single-server Compose
// is free, and Compose HA / Kubernetes / Kubernetes HA require a license.
// deploy/backup/restore/failover/scale (COMMAND_GATES = 'mode') each gate
// themselves in-flow, immediately after their deploy-mode tier is known
// (requirePaidTier() — see src/lib/licensing/index.js), rather than
// pre-dispatch in cli.js. A gated invocation without a license must exit
// NON-ZERO — a command that silently does nothing is a failed invocation,
// not a success (see src/lib/licensing/index.js requireLicense()).
//
// These run inside minimal project fixtures (so assertInProjectDir passes)
// with an isolated empty HOME (so no license is found), exercising
// requirePaidTier()'s requireLicense() exit path directly.

/** Every command classified 'mode' — derived so a reclassification in
 * gate.js without a matching fixture here fails loudly. */
const MODE_COMMANDS = Object.entries(COMMAND_GATES)
  .filter(([, gate]) => gate === 'mode')
  .map(([cmd]) => cmd)
  .sort();

// argv for each mode-gated command against a single pre-existing "prod"
// environment. `-l` (list) on backup/restore avoids the interactive
// action prompt so the process reaches the gate deterministically.
const MODE_ARGV: Record<string, string[]> = {
  backup: ['backup', 'prod', '-l'],
  deploy: ['deploy', 'prod'],
  failover: ['failover', 'prod'],
  restore: ['restore', 'prod', '-l'],
  scale: ['scale', 'prod'],
};

function writeProject(dir: string, envConfig?: Record<string, unknown>): void {
  const config: Record<string, unknown> = { projectName: 'lictest' };
  if (envConfig) {
    config.environments = { prod: envConfig };
  }
  writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching them
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function run(argv: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    encoding: 'utf-8',
    // Isolated HOME with no ~/.vibecarbon/license → Graphite (unlicensed).
    env: { ...process.env, HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeout: 15000,
  });
}

describe('vibecarbon — mode-gated commands without a license', () => {
  let proj: string;
  let home: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'vc-licproj-'));
    home = mkdtempSync(join(tmpdir(), 'vc-lichome-'));
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('has an argv fixture for every mode-gated command', () => {
    expect(Object.keys(MODE_ARGV).sort()).toEqual(MODE_COMMANDS);
  });

  describe('paid modes: refuse with "License required"', () => {
    // compose-ha and kubernetes+ha resolve to the 'compose-ha' and 'k8s-ha'
    // tiers (see src/lib/deploy/tier-registry.js) — both PAID_TIERS.
    const PAID_FIXTURES: Record<string, Record<string, unknown>> = {
      'compose-ha': { deployMode: 'compose-ha', status: 'deployed', servers: [{ ip: '10.0.0.1' }] },
      'kubernetes+ha': {
        deployMode: 'kubernetes',
        // Real persisted shape (see orchestrator.js) — ha is always an
        // object with `enabled`, never a bare boolean.
        ha: { enabled: true },
        status: 'deployed',
        servers: [{ ip: '10.0.0.1' }],
      },
    };

    // Tier labels the upsell names for each fixture (src/lib/licensing/index.js
    // TIER_LABELS) — used below to assert the per-command phrasing.
    const TIER_LABEL_BY_FIXTURE: Record<string, string> = {
      'compose-ha': 'Docker Compose HA',
      'kubernetes+ha': 'Kubernetes HA',
    };

    for (const [fixtureName, envConfig] of Object.entries(PAID_FIXTURES)) {
      for (const name of MODE_COMMANDS) {
        it(`${name} (${fixtureName}) → emits "License required" and exits non-zero`, () => {
          writeProject(proj, envConfig);
          const result = run(MODE_ARGV[name], proj, home);
          const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
          const plain = stripAnsi(combined);
          expect(
            result.status,
            `${name}: expected non-zero exit. status=${result.status} output:\n${combined}`,
          ).not.toBe(0);
          expect(combined, `${name}: missing "License required"`).toContain('License required');

          // Diamond retired — the upsell must only ever mention Fullerene.
          expect(plain, `${name}: must not mention the retired Diamond tier`).not.toContain(
            'Diamond',
          );
          expect(plain, `${name}: missing Fullerene mention`).toContain('Fullerene');
          // Agency is a contact-us channel, not a self-serve upsell price.
          expect(plain, `${name}: missing Agency contact-us line`).toContain(
            'Agencies & client work',
          );

          const tierLabel = TIER_LABEL_BY_FIXTURE[fixtureName];
          if (name === 'deploy') {
            expect(plain, `${name}: missing free-single-server framing`).toContain(
              'Single-server Compose deploys are free',
            );
            expect(plain, `${name}: missing mode-specific requirement`).toContain(
              `${tierLabel} requires Fullerene`,
            );
          } else {
            // Fix for Task 1 reviewer's minor: the message must not say
            // "deploys are free" verbatim for non-deploy commands like
            // scale/backup/restore/failover — phrase as "<command> on
            // <mode> requires Fullerene" instead.
            expect(plain, `${name}: wrongly uses deploy-only framing`).not.toContain(
              'deploys are free',
            );
            expect(
              plain,
              `${name}: missing "<command> on <mode> requires Fullerene" phrasing`,
            ).toContain(`${name} on ${tierLabel} requires Fullerene`);
          }
        });
      }
    }
  });

  describe('free mode: never mentions "License required"', () => {
    for (const name of MODE_COMMANDS) {
      it(`${name} (compose) → no "License required"`, () => {
        writeProject(proj, {
          deployMode: 'compose',
          status: 'deployed',
          servers: [{ ip: '10.0.0.1' }],
        });
        const result = run(MODE_ARGV[name], proj, home);
        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        expect(result.signal, `${name}: process was killed (likely hung)\n${combined}`).toBeNull();
        expect(combined, `${name}: unexpectedly emitted "License required"`).not.toContain(
          'License required',
        );
      });
    }

    it('fresh project, no environments yet: `deploy -y` defaults to compose — no "License required"', () => {
      writeProject(proj); // no environments key at all
      // -provider is required for a NEW env under -y (2026-08-08, PR 2
      // opening commit) — without it the provider-explicitness error would
      // fire before this test's subject (the license gate) is ever reached.
      const result = run(['deploy', 'prod', '-provider', 'hetzner', '-y'], proj, home);
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      expect(result.signal, `deploy -y: process was killed (likely hung)\n${combined}`).toBeNull();
      expect(combined, 'deploy -y: unexpectedly emitted "License required"').not.toContain(
        'License required',
      );
    });

    it('`deploy prod -mode k8s -y` on a fresh project refuses — -mode picks a paid tier explicitly', () => {
      writeProject(proj); // no environments key at all
      // -provider hetzner: see the sibling case above — reach the license
      // gate, not the provider-explicitness error.
      const result = run(
        ['deploy', 'prod', '-provider', 'hetzner', '-mode', 'k8s', '-y'],
        proj,
        home,
      );
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      expect(
        result.status,
        `deploy -mode k8s -y: expected non-zero exit. status=${result.status} output:\n${combined}`,
      ).not.toBe(0);
      expect(combined, 'deploy -mode k8s -y: missing "License required"').toContain(
        'License required',
      );
    });
  });
});
