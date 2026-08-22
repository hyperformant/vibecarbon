import { describe, expect, it } from 'vitest';
import { cn, getUserInitials } from '@/lib/utils';

describe('cn (className merger)', () => {
  it('joins truthy class names', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('lets later Tailwind utilities override earlier ones (tw-merge)', () => {
    // The whole reason we use tw-merge instead of plain clsx: conflicting
    // utility classes resolve to the last one in.
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm text-red-500', 'text-blue-500')).toBe('text-sm text-blue-500');
  });
});

describe('getUserInitials', () => {
  it('returns "?" when user is null', () => {
    expect(getUserInitials(null)).toBe('?');
  });

  it('uses the first two name parts when full_name is present', () => {
    expect(
      getUserInitials({ email: 'a@b.c', user_metadata: { full_name: 'Ada Lovelace' } }),
    ).toBe('AL');
  });

  it('caps initials at two characters even for long names', () => {
    expect(
      getUserInitials({
        email: 'm@a.c',
        user_metadata: { full_name: 'Mary Anne Evans George Eliot' },
      }),
    ).toBe('MA');
  });

  it('falls back to the email first character when no full_name', () => {
    expect(getUserInitials({ email: 'ada@example.com' })).toBe('A');
  });

  it('returns "?" when neither name nor email is usable', () => {
    expect(getUserInitials({ email: '' })).toBe('?');
    expect(getUserInitials({})).toBe('?');
  });
});
