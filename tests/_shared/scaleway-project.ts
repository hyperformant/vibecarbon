/**
 * The configured Scaleway project for unit tests that read Scaleway
 * listings. ScalewayProvider scopes every listing to
 * SCALEWAY_DEFAULT_PROJECT_ID, both on the query and by keeping only the
 * rows of that project, and refuses to list at all without it (projectScope
 * in src/lib/providers/scaleway.js). A fake API's rows therefore carry the
 * project as the real API does: `project` on the Instance API's servers,
 * IPs, security groups and volumes, `project_id` on the Block, VPC, IAM and
 * Load Balancer APIs' rows.
 */
import { vi } from 'vitest';

/** The project the tests configure. */
export const SCALEWAY_TEST_PROJECT = '0f5a7c3e-6b1d-4e2a-9c8f-3d4b5a6e7f80';

/** Another project the same key can see, whose rows are never ours. */
export const SCALEWAY_OTHER_PROJECT = '99999999-8888-4777-8666-555555555555';

/** Configure SCALEWAY_TEST_PROJECT for this test (undone by vi.unstubAllEnvs). */
export function stubScalewayProject() {
  vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', SCALEWAY_TEST_PROJECT);
}

/**
 * Rows as the API lists them in the configured project: each gets `field`
 * unless it names a project of its own.
 * @param rows - the fixture rows
 * @param field - 'project' (Instance API) or 'project_id' (the others)
 */
export function inTestProject<T extends object>(
  rows: T[],
  field: 'project' | 'project_id' = 'project',
): T[] {
  return rows.map((row) => ({ [field]: SCALEWAY_TEST_PROJECT, ...row }));
}
