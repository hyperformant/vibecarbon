import type { User } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';
import { jsonPost } from '../../../_helpers/app';

/**
 * The docs visibility toggles ride the existing app-settings endpoints:
 * GET /settings is public (unauthenticated marketing pages read it to decide
 * whether to render docs links) and PATCH /admin/settings is super-admin only.
 *
 * The load-bearing behavior is that both flags default to ON. A project that
 * upgrades without running the migration, or whose settings row is missing,
 * must keep serving the documentation it already had.
 */

const { selectRows, upserts } = vi.hoisted(() => ({
  selectRows: { data: [] as { key: string; value: unknown }[], error: null as unknown },
  upserts: [] as { key: string; value: unknown; updated_by?: string }[],
}));

// auth.ts aliases `supabaseAdmin` to a loosely-typed `adminDb` locally, so the
// mock has to stand in for supabaseAdmin itself.
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: async () => selectRows,
      }),
      upsert: async (row: { key: string; value: unknown; updated_by?: string }) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  },
  createAuthClient: () => ({}),
}));

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { authRoutes } = await import('@server/routes/v1/auth');

function app(asSuperAdmin: boolean) {
  const instance = new Hono<{ Variables: HonoVariables }>();
  instance.use('*', async (c, next) => {
    c.set(
      'user',
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
      { id: 'admin1', app_metadata: { role: asSuperAdmin ? 'super_admin' : 'user' } } as any
    );
    await next();
  });
  instance.route('/api/v1/auth', authRoutes);
  return instance;
}

function getSettings() {
  return app(false).request('/api/v1/auth/settings');
}

function patchSettings(body: unknown, asSuperAdmin = true) {
  return app(asSuperAdmin).request('/api/v1/auth/admin/settings', {
    ...jsonPost(body),
    method: 'PATCH',
  });
}

beforeEach(() => {
  selectRows.data = [];
  selectRows.error = null;
  upserts.length = 0;
});

describe('GET /settings docs visibility', () => {
  it('defaults both surfaces to enabled when no rows exist', async () => {
    const { settings } = await (await getSettings()).json();
    expect(settings.userDocsEnabled).toBe(true);
    expect(settings.apiDocsEnabled).toBe(true);
  });

  it('reflects stored values when the rows are present', async () => {
    selectRows.data = [
      { key: 'user_docs_enabled', value: { enabled: false } },
      { key: 'api_docs_enabled', value: { enabled: true } },
    ];
    const { settings } = await (await getSettings()).json();
    expect(settings.userDocsEnabled).toBe(false);
    expect(settings.apiDocsEnabled).toBe(true);
  });

  it('reports the two surfaces independently', async () => {
    selectRows.data = [
      { key: 'user_docs_enabled', value: { enabled: true } },
      { key: 'api_docs_enabled', value: { enabled: false } },
    ];
    const { settings } = await (await getSettings()).json();
    expect(settings.userDocsEnabled).toBe(true);
    expect(settings.apiDocsEnabled).toBe(false);
  });

  it('falls back to enabled when the settings query errors', async () => {
    selectRows.error = { message: 'relation does not exist' };
    const res = await getSettings();
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.userDocsEnabled).toBe(true);
    expect(settings.apiDocsEnabled).toBe(true);
  });
});

describe('PATCH /admin/settings docs visibility', () => {
  it('persists user_docs_enabled under the expected key and shape', async () => {
    const res = await patchSettings({ user_docs_enabled: false });
    expect(res.status).toBe(200);
    expect(upserts).toContainEqual(
      expect.objectContaining({ key: 'user_docs_enabled', value: { enabled: false } })
    );
  });

  it('persists api_docs_enabled under the expected key and shape', async () => {
    const res = await patchSettings({ api_docs_enabled: false });
    expect(res.status).toBe(200);
    expect(upserts).toContainEqual(
      expect.objectContaining({ key: 'api_docs_enabled', value: { enabled: false } })
    );
  });

  it('writes both in one request without disturbing other settings', async () => {
    await patchSettings({ user_docs_enabled: false, api_docs_enabled: false });
    expect(upserts.map((u) => u.key).sort()).toEqual(['api_docs_enabled', 'user_docs_enabled']);
  });

  it('touches nothing when neither flag is present in the body', async () => {
    await patchSettings({ mfa_enabled: true });
    expect(upserts.map((u) => u.key)).not.toContain('user_docs_enabled');
    expect(upserts.map((u) => u.key)).not.toContain('api_docs_enabled');
  });

  it('records who made the change', async () => {
    await patchSettings({ api_docs_enabled: false });
    expect(upserts[0]?.updated_by).toBe('admin1');
  });

  it('rejects a non-boolean value', async () => {
    const res = await patchSettings({ user_docs_enabled: 'no' });
    expect(res.status).toBe(400);
    expect(upserts).toHaveLength(0);
  });

  it('SECURITY: a non-super-admin cannot change docs visibility', async () => {
    const res = await patchSettings({ api_docs_enabled: false }, false);
    expect(res.status).toBe(403);
    expect(upserts).toHaveLength(0);
  });
});
