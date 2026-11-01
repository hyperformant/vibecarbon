import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDON_JOB_SCRIPT } from '../../../src/lib/services/addon-start.js';

/**
 * M-A6: the scale cutover's whole-stack `up -d --force-recreate` must not run
 * while an add-on job (services/addon-start.js) on the same node is mid
 * compose operation. It stops the job first, as reconcile.sh does.
 */
describe('scale cutover recreate stops the add-on job first', () => {
  const src = readFileSync(join(import.meta.dirname, '../../../src/scale.js'), 'utf8');

  it('runs `addons-start.sh stop` before its force-recreate up', () => {
    const up = src.indexOf('up -d --force-recreate');
    expect(up).toBeGreaterThan(-1);
    const cmd = src.slice(src.lastIndexOf('await sshRunScript(', up), up);
    expect(cmd).toContain(
      `if [ -f ${'${ADDON_JOB_SCRIPT}'} ]; then sh ${'${ADDON_JOB_SCRIPT}'} stop; fi; `,
    );
    expect(ADDON_JOB_SCRIPT).toBe('addons-start.sh');
  });
});

/**
 * Important (fix round 3): the scale's reconcile starts the add-on job on the
 * new server, and the db restore then runs underneath it. The job is stopped
 * BEFORE the restore, so it never runs (or dies) mid-restore and leaves a
 * file the next reader takes for current.
 */
describe('the scale restore stops the add-on job first', () => {
  const src = readFileSync(join(import.meta.dirname, '../../../src/scale.js'), 'utf8');
  it('runs `addons-start.sh stop` on the new server before restoreCompose', () => {
    const restore = src.indexOf('restoreCompose(newIp, sshKeyPath, projectName, {');
    expect(restore).toBeGreaterThan(-1);
    const before = src.slice(
      src.lastIndexOf("s.start('Restoring database from S3 via wal-g...');", restore) - 600,
      restore,
    );
    expect(before).toMatch(/stopAddonJob\(newIp, sshKeyPath, projectName\)/);
  });

  it("the new server's reconcile runs with the scale's attempt id", () => {
    expect(src).toMatch(
      /startComposeStack\(newIp, sshKeyPath, projectName, \{\s*\.\.\.services,\s*attemptId: ctx\.attemptId/,
    );
  });
});
