import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PerformanceMetrics } from '@/components/admin/PerformanceMetrics';
import { ServicesStatus } from '@/components/admin/ServicesStatus';

// The super-admin Overview's Services Status panel and its metric cards.
// The panel shows exactly the rows the server reports (the server lists only
// containers this environment runs), offers restart only on rows the server
// marks restartable, and drops "Restart All" where nothing is. The memory card
// says what it measures: the app process, not the stack.

const fetchMock = vi.fn();

function respond(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const path = String(input);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
}

function renderWithQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Row = {
  name: string;
  container: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  restartable?: boolean;
};

const statusBody = (services: Row[]) => ({
  summary: {
    healthy: services.filter((s) => s.status === 'healthy').length,
    unhealthy: services.filter((s) => s.status !== 'healthy').length,
    total: services.length,
  },
  services,
  timestamp: '2026-10-16T00:00:00Z',
});

const DEV_ROWS: Row[] = [
  { name: 'App', container: 'app', status: 'healthy', latencyMs: 1, restartable: true },
  { name: 'PostgreSQL', container: 'db', status: 'healthy', latencyMs: 2, restartable: true },
  { name: 'Storage (S3)', container: 's3', status: 'healthy', restartable: true },
  { name: 'Traefik', container: 'traefik', status: 'healthy', latencyMs: 4, restartable: true },
];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServicesStatus panel', () => {
  it('lists the dev stack rows, with Garage and no Authentication row', async () => {
    respond({ '/api/_internal/services/status': statusBody(DEV_ROWS) });
    renderWithQuery(<ServicesStatus />);

    expect(await screen.findByText('4 of 4 services healthy')).toBeInTheDocument();
    for (const name of ['App', 'PostgreSQL', 'Storage (S3)', 'Traefik']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.queryByText('Authentication')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Restart (?!All)/ })).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Restart All Services' })).toBeInTheDocument();
  });

  it('offers no restart where the server marks nothing restartable (production)', async () => {
    respond({
      '/api/_internal/services/status': statusBody([
        { name: 'App', container: 'app', status: 'healthy', latencyMs: 1, restartable: false },
        { name: 'App Docker Proxy', container: 'app-docker-proxy', status: 'healthy', latencyMs: 1, restartable: false },
        { name: 'Docker Socket Proxy', container: 'docker-socket-proxy', status: 'healthy', latencyMs: 1, restartable: false },
        { name: 'PostgreSQL', container: 'db', status: 'healthy', latencyMs: 2, restartable: false },
        { name: 'Traefik', container: 'traefik', status: 'healthy', latencyMs: 3, restartable: false },
      ]),
    });
    renderWithQuery(<ServicesStatus />);

    expect(await screen.findByText('Docker Socket Proxy')).toBeInTheDocument();
    expect(screen.getByText('App Docker Proxy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart/ })).not.toBeInTheDocument();
  });
});

describe('PerformanceMetrics cards', () => {
  it('labels memory as the app process and latency as the service average', async () => {
    respond({
      '/api/v1/admin/performance': {
        server: {
          uptimeSeconds: 240,
          memoryMB: { rss: 180, heapUsed: 50, heapTotal: 80 },
          disk: null,
          nodeVersion: 'v24',
          platform: 'linux x64',
        },
        services: {
          healthy: 2,
          total: 2,
          avgLatencyMs: 3,
          items: [
            { name: 'PostgreSQL', latencyMs: 2, status: 'healthy' },
            { name: 'Traefik', latencyMs: 4, status: 'healthy' },
          ],
        },
      },
      '/api/v1/admin/stats': { users: { weeklySignups: [] } },
    });
    renderWithQuery(<PerformanceMetrics />);

    const memoryCard = (await screen.findByText('App memory')).closest('[data-slot="card"]');
    expect(memoryCard).not.toBeNull();
    expect(await within(memoryCard as HTMLElement).findByText('180 MB')).toBeInTheDocument();
    expect(within(memoryCard as HTMLElement).getByText('50 MB heap')).toBeInTheDocument();
    expect(screen.queryByText('Memory Used')).not.toBeInTheDocument();
    expect(screen.getByText('Avg service latency')).toBeInTheDocument();
    expect(screen.queryByText('Avg API Latency')).not.toBeInTheDocument();
  });
});
