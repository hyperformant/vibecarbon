import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/client/hooks/useOrganizations.tsx: the selected organization's role
 * (isOrgAdmin, isOrgOwner) and the slug createOrganization sends, read
 * through the real provider over a stubbed fetch.
 */

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'jane@example.com' } }),
}));

import {
  type Membership,
  type Organization,
  type OrganizationRole,
  OrganizationsProvider,
  useOrganizations,
} from '@/hooks/useOrganizations';

function org(id: string, plan: Organization['plan'] = 'FREE'): Organization {
  return {
    id,
    name: `Org ${id}`,
    slug: id,
    plan,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function membership(role: OrganizationRole, organization: Organization): Membership {
  return { id: `mem-${organization.id}`, role, organization };
}

let memberships: Membership[] = [];
const posts: Array<{ name: string; slug: string }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  memberships = [];
  posts.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/me') return json({ memberships });
      if (path === '/api/v1/organizations' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; slug: string };
        posts.push(body);
        return json({ organization: org('org-new') }, 201);
      }
      return json({ error: 'unexpected' }, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderOrganizations() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <OrganizationsProvider>{children}</OrganizationsProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useOrganizations(), { wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

/** The role and permission flags with `id` selected. */
async function selectAndRead(hook: Awaited<ReturnType<typeof renderOrganizations>>, id: string) {
  const target = hook.result.current.organizations.find((o) => o.id === id);
  if (!target) throw new Error(`no organization ${id}`);
  act(() => hook.result.current.selectOrganization(target));
  await waitFor(() => expect(hook.result.current.selectedOrganization?.id).toBe(id));
  const { selectedOrganizationRole, isOrgAdmin, isOrgOwner } = hook.result.current;
  return { role: selectedOrganizationRole, isOrgAdmin, isOrgOwner };
}

describe('useOrganizations: the selected organization’s role', () => {
  it.each([
    ['OWNER', true, true],
    ['ADMIN', true, false],
    ['MEMBER', false, false],
  ] as const)('%s: isOrgAdmin %s, isOrgOwner %s', async (role, admin, owner) => {
    memberships = [membership(role, org('org-1'))];
    const hook = await renderOrganizations();
    await waitFor(() => expect(hook.result.current.selectedOrganizationRole).toBe(role));
    expect(hook.result.current.isOrgAdmin).toBe(admin);
    expect(hook.result.current.isOrgOwner).toBe(owner);
  });

  it('has no role, and neither flag, with no memberships', async () => {
    const hook = await renderOrganizations();
    expect(hook.result.current.selectedOrganization).toBeNull();
    expect(hook.result.current.selectedOrganizationRole).toBeNull();
    expect(hook.result.current.isOrgAdmin).toBe(false);
    expect(hook.result.current.isOrgOwner).toBe(false);
  });

  it('has no role for a selected organization the user is not a member of', async () => {
    memberships = [membership('OWNER', org('org-1'))];
    const hook = await renderOrganizations();
    act(() => hook.result.current.selectOrganization(org('org-999')));
    await waitFor(() => expect(hook.result.current.selectedOrganization?.id).toBe('org-999'));
    expect(hook.result.current.selectedOrganizationRole).toBeNull();
    expect(hook.result.current.isOrgAdmin).toBe(false);
    expect(hook.result.current.isOrgOwner).toBe(false);
  });

  it('follows the selection: OWNER in one organization, MEMBER in another', async () => {
    memberships = [membership('OWNER', org('org-1')), membership('MEMBER', org('org-2', 'PRO'))];
    const hook = await renderOrganizations();
    expect(await selectAndRead(hook, 'org-1')).toEqual({
      role: 'OWNER',
      isOrgAdmin: true,
      isOrgOwner: true,
    });
    expect(await selectAndRead(hook, 'org-2')).toEqual({
      role: 'MEMBER',
      isOrgAdmin: false,
      isOrgOwner: false,
    });
  });

  it('can be OWNER of several organizations', async () => {
    memberships = [membership('OWNER', org('org-1')), membership('OWNER', org('org-2', 'PRO'))];
    const hook = await renderOrganizations();
    expect((await selectAndRead(hook, 'org-1')).role).toBe('OWNER');
    expect((await selectAndRead(hook, 'org-2')).role).toBe('OWNER');
  });

  it('keeps a different role per organization', async () => {
    memberships = [
      membership('OWNER', org('org-1')),
      membership('ADMIN', org('org-2', 'PRO')),
      membership('MEMBER', org('org-3', 'ENTERPRISE')),
    ];
    const hook = await renderOrganizations();
    expect(await selectAndRead(hook, 'org-1')).toEqual({
      role: 'OWNER',
      isOrgAdmin: true,
      isOrgOwner: true,
    });
    expect(await selectAndRead(hook, 'org-2')).toEqual({
      role: 'ADMIN',
      isOrgAdmin: true,
      isOrgOwner: false,
    });
    expect(await selectAndRead(hook, 'org-3')).toEqual({
      role: 'MEMBER',
      isOrgAdmin: false,
      isOrgOwner: false,
    });
  });

  it('takes permissions from the role, not the plan: a MEMBER of an ENTERPRISE organization', async () => {
    memberships = [membership('MEMBER', org('org-1', 'ENTERPRISE'))];
    const hook = await renderOrganizations();
    await waitFor(() => expect(hook.result.current.selectedOrganization?.plan).toBe('ENTERPRISE'));
    expect(hook.result.current.isOrgAdmin).toBe(false);
  });
});

describe('useOrganizations: createOrganization sends a slug made from the name', () => {
  async function slugFor(name: string): Promise<string> {
    const hook = await renderOrganizations();
    await act(async () => {
      await hook.result.current.createOrganization(name);
    });
    const sent = posts.at(-1);
    if (!sent) throw new Error('createOrganization sent nothing');
    expect(sent.name).toBe(name);
    return sent.slug;
  }

  it.each([
    ['lowercases', 'My Company', 'my-company'],
    ['lowercases a single word', 'UPPERCASE', 'uppercase'],
    ['turns spaces into hyphens', 'my company name', 'my-company-name'],
    ['drops special characters', "My Company's Name!", 'my-companys-name'],
    ['drops punctuation around words', 'Company #1 (test)', 'company-1-test'],
    ['collapses runs of spaces', 'my   company', 'my-company'],
    ['collapses runs of hyphens', 'my---company', 'my-company'],
    ['trims surrounding whitespace', '  my company  ', 'my-company'],
    ['handles a mixed name', '  My GREAT Company!!!  ', 'my-great-company'],
    ['keeps numbers', 'Company 123', 'company-123'],
    ['keeps existing hyphens', 'my-company', 'my-company'],
  ])('%s: "%s" becomes "%s"', async (_what, name, slug) => {
    expect(await slugFor(name)).toBe(slug);
  });

  it('truncates to 50 characters', async () => {
    expect(await slugFor('a'.repeat(100))).toBe('a'.repeat(50));
  });
});
