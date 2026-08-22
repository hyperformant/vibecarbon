import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanSpacesProvider } from '../../../src/lib/providers/digitalocean-spaces.js';

// Mock the AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  const MockS3Client = class {
    send = vi.fn();
  };
  return {
    S3Client: MockS3Client,
    CreateBucketCommand: class {},
    DeleteBucketCommand: class {},
    HeadBucketCommand: class {},
    ListBucketsCommand: class {},
    PutBucketCorsCommand: class {},
    ListObjectsV2Command: class {},
    ListObjectVersionsCommand: class {},
    DeleteObjectsCommand: class {},
    ListMultipartUploadsCommand: class {},
    AbortMultipartUploadCommand: class {},
  };
});

describe('DigitalOceanSpacesProvider', () => {
  describe('static properties', () => {
    it('has correct endpoints for all 10 regions', () => {
      expect(DigitalOceanSpacesProvider.ENDPOINTS.nyc3).toBe('https://nyc3.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.sfo3).toBe('https://sfo3.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.ams3).toBe('https://ams3.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.fra1).toBe('https://fra1.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.lon1).toBe('https://lon1.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.tor1).toBe('https://tor1.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.sgp1).toBe('https://sgp1.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.blr1).toBe('https://blr1.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.syd1).toBe('https://syd1.digitaloceanspaces.com');
      expect(DigitalOceanSpacesProvider.ENDPOINTS.atl1).toBe('https://atl1.digitaloceanspaces.com');
    });

    it('has all 10 regions in the REGIONS slug → description map', () => {
      const regions = DigitalOceanSpacesProvider.REGIONS;
      expect(Object.keys(regions)).toHaveLength(10);
      expect(regions.nyc3).toBe('New York, USA');
      expect(regions.sfo3).toBe('San Francisco, USA');
      expect(regions.ams3).toBe('Amsterdam, Netherlands');
      expect(regions.fra1).toBe('Frankfurt, Germany');
      expect(regions.lon1).toBe('London, United Kingdom');
      expect(regions.tor1).toBe('Toronto, Canada');
      expect(regions.sgp1).toBe('Singapore');
      expect(regions.blr1).toBe('Bangalore, India');
      expect(regions.syd1).toBe('Sydney, Australia');
      expect(regions.atl1).toBe('Atlanta, USA');
    });

    it('getRegions returns all regions', () => {
      const regions = DigitalOceanSpacesProvider.getRegions();
      expect(Object.keys(regions)).toHaveLength(10);
    });

    it('getEndpointForRegion returns correct endpoint for fra1', () => {
      expect(DigitalOceanSpacesProvider.getEndpointForRegion('fra1')).toBe(
        'https://fra1.digitaloceanspaces.com',
      );
    });

    it('getEndpointForRegion returns null for invalid region', () => {
      expect(DigitalOceanSpacesProvider.getEndpointForRegion('invalid')).toBeNull();
    });
  });

  describe('resolveS3Region', () => {
    it('returns the region itself for a valid S3 region (nyc3)', () => {
      expect(DigitalOceanSpacesProvider.resolveS3Region('nyc3')).toBe('nyc3');
    });

    it('returns the region itself for a valid S3 region (fra1)', () => {
      expect(DigitalOceanSpacesProvider.resolveS3Region('fra1')).toBe('fra1');
    });

    it('returns nyc3 fallback for an unknown region', () => {
      expect(DigitalOceanSpacesProvider.resolveS3Region('unknown')).toBe('nyc3');
    });
  });

  describe('constructor', () => {
    it('creates provider with valid credentials and valid region', () => {
      const provider = new DigitalOceanSpacesProvider('access-key', 'secret-key', 'fra1');
      expect(provider.accessKeyId).toBe('access-key');
      expect(provider.secretAccessKey).toBe('secret-key');
      expect(provider.region).toBe('fra1');
      expect(provider.endpoint).toBe('https://fra1.digitaloceanspaces.com');
    });

    it('throws for missing access key', () => {
      expect(() => new DigitalOceanSpacesProvider('', 'secret-key', 'nyc3')).toThrow(
        'S3 credentials are required',
      );
    });

    it('throws for missing secret key', () => {
      expect(() => new DigitalOceanSpacesProvider('access-key', '', 'nyc3')).toThrow(
        'S3 credentials are required',
      );
    });

    it('throws for invalid region', () => {
      expect(() => new DigitalOceanSpacesProvider('access-key', 'secret-key', 'invalid')).toThrow(
        'Invalid region',
      );
    });
  });

  describe('instance methods', () => {
    let provider: DigitalOceanSpacesProvider;

    beforeEach(() => {
      provider = new DigitalOceanSpacesProvider('test-access-key', 'test-secret-key', 'nyc3');
    });

    it('getEndpoint returns the endpoint URL', () => {
      expect(provider.getEndpoint()).toBe('https://nyc3.digitaloceanspaces.com');
    });

    it('getClient creates S3Client with correct config', () => {
      const client = provider.getClient();
      expect(client).toBeDefined();
    });

    it('getClient returns same instance on subsequent calls', () => {
      const client1 = provider.getClient();
      const client2 = provider.getClient();
      expect(client1).toBe(client2);
    });
  });
});

describe('factory dispatch for DigitalOcean Spaces', () => {
  it('resolveS3RegionFor("digitalocean", "fra1") returns "fra1"', async () => {
    const { resolveS3RegionFor } = await import('../../../src/lib/providers/index.js');
    const result = await resolveS3RegionFor('digitalocean', 'fra1');
    expect(result).toBe('fra1');
  });

  it('resolveS3RegionFor("digitalocean", "unknown") returns "nyc3"', async () => {
    const { resolveS3RegionFor } = await import('../../../src/lib/providers/index.js');
    const result = await resolveS3RegionFor('digitalocean', 'unknown');
    expect(result).toBe('nyc3');
  });
});
