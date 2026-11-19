/**
 * Organization settings: "Save Changes" saves the name. It once only closed
 * edit mode, so the typed name was dropped without a request. The page runs
 * here inside the real OrganizationsProvider over a stubbed fetch, so a save
 * is seen the way a user sees it: the new name on the page after the
 * organizations are read again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// t returns the key path verbatim so we can query by stable strings.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('@/components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'jane@example.com' } }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';
import { OrganizationsProvider } from '@/hooks/useOrganizations';
import OrgDetails from '@/pages/organizations/Details';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** What the stubbed server holds, and the requests it saw as `METHOD path`. */
const server = {
  name: 'Acme',
  role: 'OWNER',
  /** The answer to a rename; unset, the rename succeeds. */
  refuse: undefined as undefined | (() => Response),
  requests: [] as Array<{ request: string; body?: unknown }>,
};

const organization = () => ({
  id: 'o1',
  name: server.name,
  slug: 'acme',
  plan: 'FREE',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  server.requests.push({ request: `${method} ${String(input)}`, body });
  if (method === 'PATCH' && String(input) === '/api/v1/organizations/o1') {
    if (server.refuse) return server.refuse();
    server.name = body.name;
    return json({ organization: organization() });
  }
  return json({ memberships: [{ id: 'm1', role: server.role, organization: organization() }] });
});

const renames = () => server.requests.filter((r) => r.request.startsWith('PATCH'));

beforeEach(() => {
  server.name = 'Acme';
  server.role = 'OWNER';
  server.refuse = undefined;
  server.requests = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderDetails() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationsProvider>
        <MemoryRouter initialEntries={['/organizations/o1']}>
          <Routes>
            <Route path="/organizations/:orgId" element={<OrgDetails />} />
          </Routes>
        </MemoryRouter>
      </OrganizationsProvider>
    </QueryClientProvider>
  );
  await screen.findByRole('heading', { name: 'Acme' });
}

const nameInput = () => screen.getByLabelText('orgSettings.name') as HTMLInputElement;

/** Open edit mode and type a name. */
function typeName(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'orgSettings.editName' }));
  fireEvent.change(nameInput(), { target: { value: name } });
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

describe('organization settings: the name', () => {
  it('Save Changes sends the new name, and the page shows it once saved', async () => {
    await renderDetails();
    typeName('Acme Labs');
    save();

    expect(await screen.findByRole('heading', { name: 'Acme Labs' })).toBeInTheDocument();
    expect(renames()).toEqual([
      { request: 'PATCH /api/v1/organizations/o1', body: { name: 'Acme Labs' } },
    ]);
    // The organizations were read again after the save, not patched locally.
    expect(server.requests.at(-1)?.request).toBe('GET /api/v1/me');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('orgSettings.renamed');
    // Edit mode is closed, with the saved name in the field.
    expect(screen.queryByRole('button', { name: 'common.save' })).not.toBeInTheDocument();
    expect(nameInput()).toBeDisabled();
    expect(nameInput().value).toBe('Acme Labs');
  });

  it('sends the name without the spaces around it', async () => {
    await renderDetails();
    typeName('  Acme Labs  ');
    save();

    await screen.findByRole('heading', { name: 'Acme Labs' });
    expect(renames()[0].body).toEqual({ name: 'Acme Labs' });
  });

  it('a refused save shows the reason and keeps the typed name in edit mode', async () => {
    server.refuse = () => json({ error: 'You must be an admin to rename the organization' }, 403);
    await renderDetails();
    typeName('Acme Labs');
    save();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'You must be an admin to rename the organization'
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('Acme Labs');
    expect(screen.getByRole('button', { name: 'common.save' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeInTheDocument();
  });

  it('a save that fails without a reason says so', async () => {
    server.refuse = () => new Response('bad gateway', { status: 502 });
    await renderDetails();
    typeName('Acme Labs');
    save();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith('orgSettings.renameError')
    );
  });

  it('Save Changes with the name unchanged closes edit mode without a request', async () => {
    await renderDetails();
    typeName('Acme');
    save();

    expect(screen.queryByRole('button', { name: 'common.save' })).not.toBeInTheDocument();
    expect(renames()).toEqual([]);
  });

  it('cannot save an empty name', async () => {
    await renderDetails();
    typeName('   ');

    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    save();
    expect(renames()).toEqual([]);
  });

  it('Cancel drops the typed name without a request', async () => {
    await renderDetails();
    typeName('Acme Labs');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(nameInput().value).toBe('Acme');
    expect(nameInput()).toBeDisabled();
    expect(renames()).toEqual([]);
    // Opening edit mode again starts from the saved name, not the dropped one.
    fireEvent.click(screen.getByRole('button', { name: 'orgSettings.editName' }));
    expect(nameInput().value).toBe('Acme');
  });

  it('a member who is not an admin gets no edit button', async () => {
    server.role = 'MEMBER';
    await renderDetails();

    expect(screen.queryByRole('button', { name: 'orgSettings.editName' })).not.toBeInTheDocument();
    expect(nameInput()).toBeDisabled();
  });
});

/**
 * Every word the page shows goes through t() (carbon/AGENTS.md, Localization),
 * so enabling a language translates all of it. With t returning the key path,
 * any text that is neither a key nor the organization's own data is a
 * hardcoded string.
 */
describe('organization settings: every string goes through t()', () => {
  const KEY = /^[a-z][A-Za-z]*(\.[A-Za-z]+)+$/;
  /** The organization's own data, which is shown as it is. */
  const DATA = new Set(['Acme', 'acme', 'o1', 'FREE']);

  /** Text nodes and labelling attributes under `root` that are not a key or data. */
  function hardcoded(root: HTMLElement): string[] {
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (text) found.push(text);
    }
    for (const el of root.querySelectorAll('[aria-label],[placeholder],[title]')) {
      for (const attr of ['aria-label', 'placeholder', 'title']) {
        const value = el.getAttribute(attr)?.trim();
        if (value) found.push(value);
      }
    }
    return found.filter((text) => !KEY.test(text) && !DATA.has(text));
  }

  it('the page, in edit mode, shows no hardcoded text', async () => {
    await renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'orgSettings.editName' }));
    expect(hardcoded(document.body)).toEqual([]);
  });

  it.each([
    ['the last organization', 1],
    ['one of several organizations', 2],
  ])('the delete dialog for %s shows no hardcoded text', async (_name, count) => {
    const memberships = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      role: 'OWNER',
      organization: { ...organization(), id: `o${i + 1}`, slug: `acme-${i}` },
    }));
    fetchMock.mockImplementationOnce(async () => json({ memberships }));
    await renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(hardcoded(dialog)).toEqual([]);
  });

  it('the loading state shows no hardcoded text', () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OrganizationsProvider>
          <MemoryRouter initialEntries={['/organizations/o1']}>
            <Routes>
              <Route path="/organizations/:orgId" element={<OrgDetails />} />
            </Routes>
          </MemoryRouter>
        </OrganizationsProvider>
      </QueryClientProvider>
    );
    expect(hardcoded(document.body)).toEqual([]);
  });
});
