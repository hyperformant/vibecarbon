/**
 * Docs visibility gating.
 *
 * Two super-admin toggles decide whether the user documentation site and the
 * API documentation surface exist for visitors. When one is off, its links
 * must disappear everywhere — not just from the nav — and the setting must
 * default to ON so a slow or failed settings fetch never hides documentation
 * that is actually enabled.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const docsVisibilityMock = vi.fn();

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/api', () => ({
  useAuthSettings: () => ({ data: undefined }),
  useDocsVisibility: () => docsVisibilityMock(),
  // GitHubStarsButton deps: unconfigured here, so it renders nothing —
  // the gate itself is exercised in nav-no-phone-home.test.tsx.
  getGitHubRepoUrl: () => '',
  useGitHubStars: () => ({ data: undefined }),
}));

import { Nav } from '@/components/Nav';
import Footer from '@/components/sections/footer';
import Hero from '@/components/sections/hero';

function setVisibility(userDocsEnabled: boolean, apiDocsEnabled: boolean) {
  docsVisibilityMock.mockReturnValue({ userDocsEnabled, apiDocsEnabled, isLoading: false });
}

/** Every href rendered in the tree, so assertions can be about links, not labels. */
function renderedHrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
}

beforeEach(() => {
  docsVisibilityMock.mockReset();
});

describe('Nav docs links', () => {
  it('renders both docs links when both surfaces are enabled', () => {
    setVisibility(true, true);
    const { container } = render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>
    );
    expect(renderedHrefs(container)).toEqual(expect.arrayContaining(['/docs', '/api/docs']));
  });

  it('drops the user docs link but keeps the API docs link', () => {
    setVisibility(false, true);
    const { container } = render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>
    );
    const hrefs = renderedHrefs(container);
    expect(hrefs).not.toContain('/docs');
    expect(hrefs).toContain('/api/docs');
  });

  it('drops the API docs link but keeps the user docs link', () => {
    setVisibility(true, false);
    const { container } = render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>
    );
    const hrefs = renderedHrefs(container);
    expect(hrefs).toContain('/docs');
    expect(hrefs).not.toContain('/api/docs');
  });

  it('drops both when both surfaces are disabled', () => {
    setVisibility(false, false);
    const { container } = render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>
    );
    const hrefs = renderedHrefs(container);
    expect(hrefs).not.toContain('/docs');
    expect(hrefs).not.toContain('/api/docs');
  });
});

describe('Footer docs column', () => {
  it('renders the Docs column when user docs are enabled', () => {
    setVisibility(true, true);
    render(<Footer />);
    expect(screen.getByRole('heading', { name: 'Docs' })).toBeInTheDocument();
  });

  it('drops the whole column — heading included — when user docs are off', () => {
    // Every link in the default Docs column points at /docs, so filtering the
    // links alone would leave a bare heading over empty space.
    setVisibility(false, true);
    const { container } = render(<Footer />);
    expect(screen.queryByRole('heading', { name: 'Docs' })).not.toBeInTheDocument();
    expect(renderedHrefs(container).filter((h) => h.startsWith('/docs'))).toHaveLength(0);
  });

  it('leaves non-docs columns untouched', () => {
    setVisibility(false, false);
    render(<Footer />);
    expect(screen.getByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Legal' })).toBeInTheDocument();
  });
});

describe('Hero docs CTA', () => {
  it('renders the docs CTA alongside the primary button when docs are on', () => {
    setVisibility(true, true);
    const { container } = render(<Hero />);
    const hrefs = renderedHrefs(container);
    expect(hrefs).toContain('/docs');
    expect(hrefs).toContain('/signup');
  });

  it('drops the docs CTA but keeps the primary button when docs are off', () => {
    setVisibility(false, true);
    const { container } = render(<Hero />);
    const hrefs = renderedHrefs(container);
    expect(hrefs).not.toContain('/docs');
    expect(hrefs).toContain('/signup');
  });
});
