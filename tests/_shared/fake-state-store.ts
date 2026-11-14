/**
 * A stand-in for the object storage client getObjectStorageProvider builds,
 * for unit tests that drive a destroy through the real iac layer. After a
 * verified destroy, removeStackBackup (src/lib/iac/state-history.js) deletes
 * the stack's previous-state copy (`.json.bak`) through that client; without
 * this the DELETE goes to the real bucket host with fake keys (2026-11-14).
 *
 * Mock it in where the client is built:
 *
 *   vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
 *     ...(await orig()),
 *     getObjectStorageProvider: (...args) => stateStore.getObjectStorageProvider(...args),
 *   }));
 *
 * Hetzner's endpoint for the region it is built for, as the real client has,
 * so the check that the client reaches the bucket Pulumi uses passes. Any
 * method but deleteObjectKeys is missing on purpose: a new call fails loudly.
 */
export function fakeHetznerStateStore() {
  return {
    getObjectStorageProvider: async (
      _provider: string,
      _accessKey: string,
      _secretKey: string,
      region: string,
    ) => ({
      endpoint: `https://${region}.your-objectstorage.com`,
      deleteObjectKeys: async (_bucket: string, _keys: string[]) => {},
    }),
  };
}
