/**
 * A failed list request shows its error, never the "nothing here yet" state.
 *
 * Newsletter, Jobs and Contact Submissions used to read only `isLoading` and
 * `data`, so a 500 rendered "No subscribers yet." (or the Jobs and Contact
 * equivalents) as if the list were simply empty. They now show the request's
 * error the way the Organizations and Users pages do.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The header pulls in the notification and account menus; this test is about
// the list body only.
vi.mock('@/components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import AdminContactSubmissions from '@/pages/admin/ContactSubmissions';
import AdminJobs from '@/pages/admin/Jobs';
import AdminNewsletter from '@/pages/admin/Newsletter';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 500 })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(page: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('admin list pages when the request fails', () => {
  it('Newsletter shows the error instead of "No subscribers yet."', async () => {
    renderPage(<AdminNewsletter />);

    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No subscribers yet.')).toBeNull();
  });

  it('Jobs shows the error in both lists instead of their empty text', async () => {
    renderPage(<AdminJobs />);

    expect(await screen.findAllByText('Database unavailable')).toHaveLength(2);
    expect(screen.queryByText(/No job history yet/)).toBeNull();
    expect(screen.queryByText('No execution history yet.')).toBeNull();
  });

  it('Contact Submissions shows the error instead of "No contact submissions yet."', async () => {
    renderPage(<AdminContactSubmissions />);

    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No contact submissions yet.')).toBeNull();
  });

  it('still shows the empty state when the request succeeds with no rows', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ subscribers: [], submissions: [], total: 0 }), {
          status: 200,
        })
    );
    renderPage(<AdminNewsletter />);

    expect(await screen.findByText('No subscribers yet.')).toBeInTheDocument();
  });
});
