import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeStartAddonJobCmd, swapComposeHaRoles } from '../../../src/lib/deploy/compose/ha.js';
import { reconcileCommand } from '../../../src/lib/deploy/compose/index.js';
import { attemptEnv, mintAttemptId } from '../../../src/lib/services/addon-start.js';

/**
 * Minor 1: the add-on status file is current only for the attempt (deploy,
 * scale or failover) that ran its job, matched by an id, never by clocks.
 * The id is minted per attempt, persisted as envConfig.lastAttemptId (never
 * cleared on success), and reaches the job through the ssh command's
 * environment only: never .env, never the bundle.
 */
describe('attempt ids', () => {
  it('are 12 hex characters, fresh each time', () => {
    const a = mintAttemptId();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(mintAttemptId()).not.toBe(a);
  });

  it('reach a remote command only as a validated environment prefix', () => {
    expect(attemptEnv('a1b2c3d4e5f6')).toBe('VC_ATTEMPT_ID=a1b2c3d4e5f6 ');
    expect(attemptEnv(undefined)).toBe('');
    expect(() => attemptEnv('x; rm -rf /')).toThrow(/attempt id/);
  });
});

describe('reconcile.sh gets the attempt id from its ssh command', () => {
  it('prefixes VC_ATTEMPT_ID to the reconcile run', () => {
    expect(reconcileCommand('/opt/demo', 'a1b2c3d4e5f6')).toBe(
      'VC_ATTEMPT_ID=a1b2c3d4e5f6 /bin/bash /opt/demo/reconcile.sh',
    );
    expect(reconcileCommand('/opt/demo')).toBe('/bin/bash /opt/demo/reconcile.sh');
  });
});

describe('a failover passes its own id to the job and saves the same id', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the promoted-node job launch carries the id', () => {
    const cmd = composeStartAddonJobCmd('demo', 'a1b2c3d4e5f6');
    expect(cmd).toContain(
      'VC_ATTEMPT_ID=a1b2c3d4e5f6 setsid nohup /bin/sh addons-start.sh promoted',
    );
  });

  it('the swap save records it as lastAttemptId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-attempt-swap-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'demo',
        environments: {
          e2: {
            lastAttemptId: '000000000000',
            servers: [
              { name: 'demo-e2-primary', role: 'primary', region: 'nyc3' },
              { name: 'demo-e2-standby', role: 'standby', region: 'sfo3' },
            ],
          },
        },
      }),
    );
    swapComposeHaRoles('e2', { attemptId: 'a1b2c3d4e5f6' });
    const env = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf8')).environments.e2;
    expect(env.lastAttemptId).toBe('a1b2c3d4e5f6');
  });
});

describe('the deploy mints and wires its id (structural)', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
    'utf8',
  );
  it('the skeleton save persists it, and the tier ctx carries it', () => {
    expect(src).toMatch(/const attemptId = mintAttemptId\(\);/);
    expect(src).toMatch(/lastAttemptId: attemptId,/);
    const ctx = src.slice(src.indexOf('const deployCtx = {'));
    expect(ctx.slice(0, ctx.indexOf('};'))).toContain('attemptId,');
  });

  it('every reconcile caller passes ctx.attemptId (compose, compose-ha)', () => {
    const effects = readFileSync(
      join(import.meta.dirname, '../../../src/lib/deploy/effects/index.js'),
      'utf8',
    );
    expect(effects).toMatch(
      /startComposeStackRemote\(serverIp, sshKeyPath, projectConfig\.projectName, \{\s*\.\.\.services,\s*attemptId: ctx\.attemptId,/,
    );
    const ha = readFileSync(
      join(import.meta.dirname, '../../../src/lib/deploy/effects/compose-ha.js'),
      'utf8',
    );
    expect(ha).toMatch(/const haServiceOpts = \(ctx\) => \{[\s\S]*?attemptId: ctx\.attemptId/);
  });
});
