import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The dev-only local S3 (docker-compose.override.yml) is Garage, and it sets
 * itself up on every `up` with no init container and no output to scrape:
 * --single-node assigns the one-node layout when none is stored, and
 * --default-bucket imports a fixed key and creates the bucket, skipping what
 * already exists. These pin that shape so a later edit can't quietly drop
 * the idempotent setup or the fixed key the .env files rely on.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

type Service = {
  image?: string;
  command?: string[];
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
};
const services = (parse(read('docker-compose.override.yml')) as { services: Record<string, Service> })
  .services;
const s3 = services.s3;
const toml = read('volumes/s3/garage.toml');
const tomlValue = (key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]+)"?`, 'm'))?.[1];

describe('local S3 (Garage)', () => {
  it('runs Garage v2 pinned by tag and multi-arch digest', () => {
    expect(s3.image).toMatch(/^dxflrs\/garage:v2\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it('sets itself up idempotently at start, with no separate init service', () => {
    expect(s3.command).toEqual(['/garage', 'server', '--single-node', '--default-bucket']);
    const others = Object.entries(services).filter(
      ([name, svc]) => name !== 's3' && svc.image?.includes('garage'),
    );
    expect(others).toEqual([]);
  });

  it('imports a fixed key in the format Garage accepts, the one dev-init.js writes', () => {
    const env = s3.environment ?? {};
    expect(env.GARAGE_DEFAULT_ACCESS_KEY).toMatch(/^GK[0-9a-f]{24}$/);
    expect(env.GARAGE_DEFAULT_SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
    const devInit = read('scripts/dev-init.js');
    expect(devInit).toContain(`S3_ACCESS_KEY: '${env.GARAGE_DEFAULT_ACCESS_KEY}',`);
    expect(devInit).toContain(`S3_SECRET_KEY: '${env.GARAGE_DEFAULT_SECRET_KEY}',`);
    // dev-init.js and create.js both write S3_BUCKET as <PROJECT_NAME>-local.
    expect(env.GARAGE_DEFAULT_BUCKET).toBe('${PROJECT_NAME}-local');
    expect(devInit).toContain("formatDotenvLine('S3_BUCKET', `${DEV.PROJECT_NAME}-local`)");
  });

  it('is a single node with its data and metadata on the s3_data volume', () => {
    expect(tomlValue('replication_factor')).toBe('1');
    expect(tomlValue('rpc_secret')).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.volumes).toContain('./volumes/s3/garage.toml:/etc/garage.toml:ro');
    expect(s3.volumes).toContain('s3_data:/var/lib/garage');
    expect(tomlValue('metadata_dir')).toMatch(/^\/var\/lib\/garage\//);
    expect(tomlValue('data_dir')).toMatch(/^\/var\/lib\/garage\//);
  });

  it('publishes the S3 API on localhost only, at the port the .env files name', () => {
    const apiPort = tomlValue('api_bind_addr')?.split(':').at(-1);
    expect(s3.ports).toEqual([`127.0.0.1:\${DEV_S3_PORT:-8333}:${apiPort}`]);
    expect(read('scripts/dev-init.js')).toContain("formatDotenvLine('S3_ENDPOINT', 'http://localhost:8333')");
  });

  // A bucket made through the S3 API gets a key-local alias in Garage, whose
  // CORS rules preflights ignore (they get a wildcard origin instead). The
  // bucket must come from --default-bucket, so the CORS script never creates.
  it('ensure-dev-bucket.js only applies CORS, never creates the bucket', () => {
    expect(read('scripts/ensure-dev-bucket.js')).not.toMatch(/CreateBucket/);
  });
});
