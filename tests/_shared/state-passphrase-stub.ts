/**
 * The state passphrase module for a test that opens Pulumi stacks through a
 * mocked LocalWorkspace (getOrCreateStack, upStack, destroyStack, ...):
 *
 *   vi.mock('../../../src/lib/state-passphrase.js', async (orig) =>
 *     (await import('../../_shared/state-passphrase-stub.js')).fixedStatePassphrase(await orig()),
 *   );
 *
 * Opening a stack checks the project's passphrase first, and the real
 * ensureStatePassphrase would write one into the working directory's
 * .env.local and .vibecarbon.json, which under the test runner is the
 * repository root. So it answers a fixed passphrase, and every other export
 * is the real module's. tests/unit/iac/state-passphrase-census.test.ts
 * covers the real wiring.
 */
export function fixedStatePassphrase(real: unknown) {
  return { ...(real as object), ensureStatePassphrase: async () => 'test-passphrase' };
}
