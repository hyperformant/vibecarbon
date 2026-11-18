import { describe, expect, it } from 'vitest';
import { errorFirstLine } from '../../../src/lib/cli/error-line.js';

describe('errorFirstLine', () => {
  it("is the first line of an error's message, untrimmed", () => {
    expect(errorFirstLine(new Error('ssh failed: exit 255\n  stderr: refused'))).toBe(
      'ssh failed: exit 255',
    );
    expect(errorFirstLine(new Error(' leading space kept'))).toBe(' leading space kept');
  });

  it('reads any value with a message, and stringifies one without', () => {
    expect(errorFirstLine({ message: 'from an object\nsecond' })).toBe('from an object');
    expect(errorFirstLine('a thrown string\nsecond')).toBe('a thrown string');
    expect(errorFirstLine(undefined)).toBe('undefined');
    expect(errorFirstLine(null)).toBe('null');
  });
});
