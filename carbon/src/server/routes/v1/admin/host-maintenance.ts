import { Hono } from 'hono';
import { sanitizeError } from '../../../lib/errors';
import { readHostMaintenance } from '../../../lib/host-maintenance';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

const hostMaintenanceRoutes = new Hono<{ Variables: HonoVariables }>();

hostMaintenanceRoutes.use('*', requireSuperAdmin);

/** Which servers need a restart, from what the host reporter published. */
hostMaintenanceRoutes.get('/', async (c) => {
  try {
    return c.json(await readHostMaintenance());
  } catch (err) {
    return c.json({ error: sanitizeError(err, 'Could not read server restart state') }, 503);
  }
});

export { hostMaintenanceRoutes };
