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
