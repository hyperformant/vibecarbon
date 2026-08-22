import { describe, expect, it } from 'vitest';
import { resolveDisplayName, titleizeSlug } from '../../../src/lib/display-name.js';
import { validateDisplayName } from '../../../src/lib/validators.js';

describe('titleizeSlug', () => {
  it.each([
    ['my-saas', 'My Saas'],
    ['my-cool-app', 'My Cool App'],
    ['a', 'A'],
    ['app1', 'App1'],
    ['foo-2-bar', 'Foo 2 Bar'],
    ['web3-app', 'Web3 App'],
  ])('titleizes %s to %s', (slug, expected) => {
    expect(titleizeSlug(slug)).toBe(expected);
  });

  it('collapses consecutive hyphens', () => {
    expect(titleizeSlug('a--b')).toBe('A B');
  });

  it('returns empty string for empty input', () => {
    expect(titleizeSlug('')).toBe('');
  });
});

describe('resolveDisplayName', () => {
  it('prefers an explicit PROJECT_DISPLAY_NAME', () => {
    expect(
      resolveDisplayName({
        PROJECT_DISPLAY_NAME: 'Acme',
        VITE_PROJECT_DISPLAY_NAME: 'Other',
        PROJECT_NAME: 'acme-app',
      }),
    ).toBe('Acme');
  });

  it('falls back to VITE_PROJECT_DISPLAY_NAME', () => {
    expect(
      resolveDisplayName({ VITE_PROJECT_DISPLAY_NAME: 'Acme', PROJECT_NAME: 'acme-app' }),
    ).toBe('Acme');
  });

  it('titleizes PROJECT_NAME when no display name is recorded', () => {
    expect(resolveDisplayName({ PROJECT_NAME: 'my-cool-app' })).toBe('My Cool App');
  });

  it('titleizes VITE_PROJECT_NAME as a last resort', () => {
    expect(resolveDisplayName({ VITE_PROJECT_NAME: 'my-app' })).toBe('My App');
  });

  it('returns empty string when nothing is available', () => {
    expect(resolveDisplayName({})).toBe('');
  });
});

describe('resolveDisplayName sanitization (MED-1: upgrade path must not trust .env.local)', () => {
  it.each([
    ["Bad'Quote breaks JS literals", "Bad'Quote"],
    ['HTML injection', '<img src=x onerror=alert(1)>'],
    ['replaceAll $-pattern', 'a$&b'],
    ['newline', 'line1\nline2'],
  ])('falls back to the titleized slug when the recorded value is unsafe (%s)', (_name, bad) => {
    expect(resolveDisplayName({ PROJECT_DISPLAY_NAME: bad, PROJECT_NAME: 'my-cool-app' })).toBe(
      'My Cool App',
    );
  });

  it('keeps a recorded value that passes validation', () => {
    expect(resolveDisplayName({ PROJECT_DISPLAY_NAME: 'Acme 2.0', PROJECT_NAME: 'acme' })).toBe(
      'Acme 2.0',
    );
  });
});

describe('LOW-2: titleized fallback is always a valid display name', () => {
  it.each([['a'], ['my-saas'], ['a1-2b-c3'], ['x'.repeat(63)], ['web3-app']])(
    'validateDisplayName(titleizeSlug(%j)) passes',
    (slug) => {
      expect(validateDisplayName(titleizeSlug(slug))).toBeUndefined();
    },
  );
});
