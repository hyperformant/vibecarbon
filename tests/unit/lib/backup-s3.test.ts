import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../../src/lib/backup-s3.js';

describe('formatBytes', () => {
  it('formats 0 as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats 1024 as "1.0 KB"', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('formats 1048576 as "1.0 MB"', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('formats 1073741824 as "1.0 GB"', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  it('formats intermediate values with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats small byte values', () => {
    expect(formatBytes(512)).toBe('512.0 B');
  });
});
