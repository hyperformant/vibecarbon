import { describe, expect, it } from 'vitest';
import { escapeHtml } from '@server/lib/html';

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
  });

  it('escapes & first, so an entity in the input is shown, not decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
