/**
 * Profile page writes. Regression coverage for the "Save" button, which once
 * shipped as a no-op (no onClick), plus the avatar: an upload saves the
 * app's own `/api/files/...` address as the user's `image`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// t returns the key path verbatim so we can query by stable strings.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const updateUser = vi.fn(async (_fields: Record<string, unknown>) => undefined);

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'jane@example.com', name: 'Jane Doe', image: null },
    isSuperAdmin: false,
    signOut: vi.fn(),
    updateUser,
  }),
}));

// The uploader's storage plumbing has its own test (file-upload.test.tsx);
// here it just reports a finished upload.
vi.mock('@/components/FileUpload', () => ({
  AvatarUpload: ({ onUpload }: { onUpload: (url: string) => void }) => (
    <button type="button" onClick={() => onUpload('/api/files/avatars/user-1/a.webp')}>
      upload-avatar
    </button>
  ),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import Profile from '@/pages/settings/Profile';

function renderProfile() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<Profile />, { wrapper: Wrapper });
}

beforeEach(() => updateUser.mockClear());

describe('Profile', () => {
  it('Save persists the edited display name as the user name', async () => {
    renderProfile();

    const nameInput = screen.getByLabelText('profile.fullName') as HTMLInputElement;
    expect(nameInput.value).toBe('Jane Doe');

    fireEvent.change(nameInput, { target: { value: 'Jane Smith' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ name: 'Jane Smith' });
    });
  });

  it('an avatar upload saves the file URL as the user image', async () => {
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'upload-avatar' }));
    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ image: '/api/files/avatars/user-1/a.webp' });
    });
  });
});
