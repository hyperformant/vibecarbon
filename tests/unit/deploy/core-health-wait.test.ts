import { describe, expect, it } from 'vitest';
import {
  coreServicesWarming,
  servicesHealthCommand,
} from '../../../src/lib/deploy/compose/index.js';
import { ADDON_SERVICES_SCRIPT } from '../../../src/lib/services/addon-start.js';

/**
 * I-A2: the deploy no longer waits for add-on health. verifyAppHealth's
 * post-probe wait (waitForServicesHealthy) covers the core services only: the
 * ones addon-services.sh does not defer to the background job, the same
 * derived set reconcile.sh starts.
 */
describe('the post-probe health wait covers core services only', () => {
  it('the remote command reads the deferred list from the node', () => {
    const cmd = servicesHealthCommand('/opt/demo');
    expect(cmd).toContain(`sh ${ADDON_SERVICES_SCRIPT}`);
    expect(cmd).toContain("docker compose ps --format '{{.Service}} {{.Health}}'");
  });

  it('ignores a deferred add-on still starting; waits on a core one', () => {
    const out = [
      'DEFERRED n8n',
      'DEFERRED grafana',
      'n8n starting',
      'grafana unhealthy',
      'traefik healthy',
      'db starting',
      'app healthy',
    ].join('\n');
    expect(coreServicesWarming(out)).toEqual(['db starting']);
  });

  it('nothing deferred: every service counts, as before', () => {
    expect(coreServicesWarming('n8n starting\napp healthy\n')).toEqual(['n8n starting']);
  });
});
