import { describe, expect, it } from 'vitest';
import { hasExplicitLayout, layoutVariantForPath } from '@/lib/route-layout';

describe('layoutVariantForPath', () => {
  it('maps full-width pages', () => {
    expect(layoutVariantForPath('/dashboard')).toBe('full');
    expect(layoutVariantForPath('/charts')).toBe('full');
    expect(layoutVariantForPath('/admin/users')).toBe('full');
    expect(layoutVariantForPath('/admin/organizations')).toBe('full');
  });

  it('maps narrow settings pages (including nested)', () => {
    expect(layoutVariantForPath('/settings')).toBe('narrow');
    expect(layoutVariantForPath('/settings/profile')).toBe('narrow');
    expect(layoutVariantForPath('/settings/billing')).toBe('narrow');
    expect(layoutVariantForPath('/settings/security')).toBe('narrow');
  });

  it('maps wide and default pages, including param routes', () => {
    expect(layoutVariantForPath('/admin/theme')).toBe('wide');
    expect(layoutVariantForPath('/admin/jobs')).toBe('default');
    expect(layoutVariantForPath('/organizations/abc-123/details')).toBe('default');
    expect(layoutVariantForPath('/organizations/abc-123/members')).toBe('default');
  });

  it('does not let /settings shadow /admin/settings', () => {
    expect(layoutVariantForPath('/admin/settings')).toBe('default');
  });

  it('falls back to default for unmapped paths', () => {
    expect(layoutVariantForPath('/nope')).toBe('default');
    expect(hasExplicitLayout('/nope')).toBe(false);
  });

  it('reports explicit coverage for mapped routes', () => {
    expect(hasExplicitLayout('/dashboard')).toBe(true);
    expect(hasExplicitLayout('/settings/profile')).toBe(true);
    expect(hasExplicitLayout('/organizations/abc/details')).toBe(true);
  });
});
