import type { HostMaintenance, HostServer } from '@shared/host-maintenance';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/lib/i18n';
import { HostMaintenanceNotice } from '@/components/admin/HostMaintenanceNotice';
import { apiJson } from '@/lib/api';

// The super-admin restart notice: shown only when a server has a restart due or
// has not started reporting, and it names the exact command to run.

vi.mock('@/lib/api', () => ({ apiJson: vi.fn() }));

const server = (over: Partial<HostServer> = {}): HostServer => ({
  name: 'web-1',
  reporting: true,
  rebootRequired: false,
  since: null,
  packages: [],
  ...over,
});

const state = (over: Partial<HostMaintenance> = {}): HostMaintenance => ({
  runtime: 'compose',
  envName: 'production',
  rebootRequired: false,
  since: null,
  servers: [server()],
  ...over,
});

function renderNotice() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HostMaintenanceNotice />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiJson).mockReset();
});

describe('HostMaintenanceNotice', () => {
  it('names the due server, the command, and links to the docs', async () => {
    vi.mocked(apiJson).mockResolvedValue(
      state({
        rebootRequired: true,
        servers: [
          server({ rebootRequired: true, packages: ['libc6'] }),
          server({ name: 'web-2' }),
        ],
      })
    );
    renderNotice();
    expect(
      await screen.findByText('A restart is needed to finish security updates')
    ).toBeTruthy();
    const body = screen.getByText(/Security updates are installed on/);
    expect(body.textContent).toBe(
      'Security updates are installed on web-1 and take effect after a restart. Nothing restarts on its own. To restart safely, run vibecarbon update production from your project.'
    );
    expect(screen.getByRole('link', { name: 'How updates work' }).getAttribute('href')).toBe(
      '/docs/cli#update'
    );
    expect(screen.getByText('Show packages')).toBeTruthy();
  });

  it('falls back to a placeholder environment when none is known', async () => {
    vi.mocked(apiJson).mockResolvedValue(
      state({ envName: null, rebootRequired: true, servers: [server({ rebootRequired: true })] })
    );
    renderNotice();
    expect(
      await screen.findByText(/run vibecarbon update <your environment> from your project/)
    ).toBeTruthy();
  });

  it('says which servers are not reporting, even when nothing is due', async () => {
    vi.mocked(apiJson).mockResolvedValue(
      state({ servers: [server(), server({ name: 'web-2', reporting: false })] })
    );
    renderNotice();
    expect(
      await screen.findByText(
        'web-2 not reporting yet. Run vibecarbon update production once to set it up.'
      )
    ).toBeTruthy();
    expect(screen.queryByText('A restart is needed to finish security updates')).toBeNull();
  });

  it('renders nothing when the query fails', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('403'));
    const { container } = renderNotice();
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for runtime none', async () => {
    vi.mocked(apiJson).mockResolvedValue(state({ runtime: 'none', servers: [] }));
    const { container } = renderNotice();
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when nothing is due and every server reports', async () => {
    vi.mocked(apiJson).mockResolvedValue(state());
    const { container } = renderNotice();
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
