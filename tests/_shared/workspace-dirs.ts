/**
 * Remove the Pulumi workspace dirs (src/lib/iac/workspace-dir.js) that the
 * module instance loaded now made. The test setup removes the ones its own
 * copy made before the temp-dir census looks, but a file that calls
 * vi.resetModules gives each test a copy of its own, whose dirs the setup's
 * copy cannot see. Such a file calls this from afterEach, which runs before
 * the next reset.
 */
export async function removeCurrentWorkspaceDirs(): Promise<void> {
  const { removeWorkspaceDirs } = await import('../../src/lib/iac/workspace-dir.js');
  removeWorkspaceDirs();
}
