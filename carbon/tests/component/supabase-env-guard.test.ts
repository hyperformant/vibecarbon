import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The supabase module runs its env check at module load, before React mounts.
// A bare throw leaves #root empty — a completely black page with the only
// clue buried in the console. The guard must paint a human-readable
// configuration error into the DOM *and* still throw to halt the app.
describe('supabase env guard', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    document.body.innerHTML = '';
  });

  it('renders a visible configuration error naming the missing vars before throwing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    await expect(import('@/lib/supabase')).rejects.toThrow(
      'Missing Supabase environment variables',
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('Configuration error');
    expect(text).toContain('VITE_SUPABASE_URL');
    expect(text).toContain('VITE_SUPABASE_ANON_KEY');
  });

  it('names only the vars that are actually missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    await expect(import('@/lib/supabase')).rejects.toThrow(
      'Missing Supabase environment variables',
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('VITE_SUPABASE_ANON_KEY');
    expect(text).not.toContain('VITE_SUPABASE_URL,');
  });

  it('exports the client and paints nothing when env is present', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

    const mod = await import('@/lib/supabase');

    expect(mod.supabase).toBeDefined();
    expect(document.body.textContent).not.toContain('Configuration error');
  });
});
