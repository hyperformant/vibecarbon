import { describe, expect, it } from 'vitest';
import { certificateDnsNames } from '../../../src/lib/deploy/k8s/k3s.js';

describe('certificateDnsNames', () => {
  it('is the apex alone: k8s routes by path, and HTTP-01 cannot issue a wildcard', () => {
    expect(certificateDnsNames('a.example.com')).toEqual(['a.example.com']);
  });
});
