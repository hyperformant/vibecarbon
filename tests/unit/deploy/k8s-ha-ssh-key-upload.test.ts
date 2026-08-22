import { afterEach, describe, expect, it, vi } from 'vitest';
import { K8S_HA_EFFECTS } from '../../../src/lib/deploy/effects/k8s-ha.js';

// The k8s-ha shared-key upload must carry provider.createSSHKey's dedup
// semantics: must dedup by exact name AND key content across the FULL
// paginated list — a partial listing or substring fallback can hand each
// cluster a different key, so servers then boot without our public key and
// every SSH step of the run fails with auth errors.
//
// Scenario pinned here: the shared key's bytes are already registered under
// another name (e2e reruns share one dev key pair) and the account holds
// enough keys that the match sits past page 1. Correct answer: the id of the
// key with matching bytes (222), not an unrelated same-prefix-named key
// (111).

const TARGET_KEY_BYTES = 'ssh-ed25519 TARGETBYTES';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('haK8sUploadSshKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the shared key by content across pagination, never by vibecarbon-name fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/ssh_keys') && method === 'GET') {
        const page = new URL(u).searchParams.get('page') ?? '1';
        if (page === '1') {
          return jsonResponse({
            ssh_keys: [
              { id: 111, name: 'vibecarbon-old-e2e', public_key: 'ssh-ed25519 OTHERBYTES x' },
            ],
            meta: { pagination: { next_page: 2 } },
          });
        }
        return jsonResponse({
          ssh_keys: [
            { id: 222, name: 'other-project-key', public_key: `${TARGET_KEY_BYTES} other@host` },
          ],
          meta: { pagination: { next_page: null } },
        });
      }
      if (u.includes('/ssh_keys') && method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'uniqueness_error',
              message: 'SSH key with the same fingerprint already exists',
            },
          },
          false,
          409,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    });

    const ctx: Record<string, unknown> = {
      options: { projectName: 'testapp', environment: 'production', apiToken: 'test-token' },
      sharedSshPublicKey: `${TARGET_KEY_BYTES} deploy@host`,
      s: { start: () => {}, stop: () => {} },
    };

    await K8S_HA_EFFECTS.haK8sUploadSshKey(ctx);

    expect(ctx.sharedSshKeyId).toBe(222);
  });
});
