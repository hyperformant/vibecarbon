import { describe, expect, it } from 'vitest';
import { printable } from '../../../src/lib/printable.js';

describe('printable', () => {
  it('replaces C0 controls but newline and tab, DEL and C1 with U+FFFD', () => {
    expect(printable('\u001b]52;c;ZXZpbA==\u0007')).toBe('�]52;c;ZXZpbA==�');
    expect(printable('a\rb\u0000c\u007fd\u0080e\u009bf')).toBe('a�b�c�d�e�f');
    for (let code = 0; code < 0xa0; code++) {
      const ch = String.fromCharCode(code);
      const keep = code === 0x09 || code === 0x0a || (code >= 0x20 && code < 0x7f);
      expect(printable(ch), `U+${code.toString(16)}`).toBe(keep ? ch : '�');
    }
  });

  it('keeps ordinary text, newlines, tabs and other Unicode as it is', () => {
    const text = 'linux-image-6.8.0-90-generic\n\tdocker-ce 5:29.9.3-1~ubuntu.26.04~resolute é ✓';
    expect(printable(text)).toBe(text);
  });

  it('prints any value as a string', () => {
    expect(printable(null)).toBe('null');
    expect(printable(503)).toBe('503');
  });
});
