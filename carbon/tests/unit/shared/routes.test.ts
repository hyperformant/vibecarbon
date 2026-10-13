import { describe, expect, it } from 'vitest';
import { matchesRoute, PRIVATE_ROUTES } from '@shared/routes';

describe('matchesRoute', () => {
  const patterns = ['/dashboard', '/settings/*'];

  it('matches exact paths only for plain patterns', () => {
    expect(matchesRoute('/dashboard', patterns)).toBe(true);
    expect(matchesRoute('/dashboard/extra', patterns)).toBe(false);
    expect(matchesRoute('/dashboards', patterns)).toBe(false);
  });

  it('matches a /* prefix and everything below it', () => {
    expect(matchesRoute('/settings', patterns)).toBe(true);
    expect(matchesRoute('/settings/profile', patterns)).toBe(true);
    expect(matchesRoute('/settings/a/b', patterns)).toBe(true);
  });

  it('does not let a /* prefix match a sibling that shares its letters', () => {
    expect(matchesRoute('/settingsx', patterns)).toBe(false);
  });

  it('keeps indexable landing pages out of the private list', () => {
    for (const path of ['/', '/login', '/signup', '/pricing', '/blog', '/docs']) {
      expect(matchesRoute(path, PRIVATE_ROUTES), path).toBe(false);
    }
  });
});
