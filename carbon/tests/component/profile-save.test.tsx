/**
 * Regression coverage for the Profile "Save" button. It shipped as a no-op:
 * the <Button> had no onClick, so editing the display name and clicking Save
 * fired nothing. This test edits the name and asserts Save persists it via
 * supabase.auth.updateUser({ data: { full_name } }) — mirroring the avatar
 * handler in the same page.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// updateUser is the seam under test; getSession keeps the @/lib/api import
// chain (pulled in transitively) from touching a real Supabase client.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } } })),
    },
  },
}));

// t returns the key path verbatim so we can query by stable strings.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      email: 'jane@example.com',
      user_metadata: { full_name: 'Jane Doe' },
    },
    isSuperAdmin: false,
    signOut: vi.fn(),
  }),
}));

// Avatar uploader pulls in storage plumbing we don't exercise here.
vi.mock('@/components/FileUpload', () => ({
  AvatarUpload: () => null,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import Profile from '@/pages/settings/Profile';
import { supabase } from '@/lib/supabase';

function renderProfile() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<Profile />, { wrapper: Wrapper });
}

describe('Profile Save button', () => {
  it('persists the edited display name via supabase.auth.updateUser', async () => {
    renderProfile();

    const nameInput = screen.getByLabelText('profile.fullName') as HTMLInputElement;
    expect(nameInput.value).toBe('Jane Doe');

    fireEvent.change(nameInput, { target: { value: 'Jane Smith' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({
        data: { full_name: 'Jane Smith' },
      });
    });
  });
});
