/**
 * Unit tests for collectComposeBuildArgs + buildArgFlags.
 *
 * Verifies that VITE_* values flow through from .env.local into docker
 * --build-arg flags, with VITE_SUPABASE_URL + VITE_PROJECT_NAME rewritten
 * for production. Regression for vibecarbon.com 2026-05-19 where the
 * browser bundle shipped with empty VITE_* values.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildArgFlags,
  collectComposeBuildArgs,
} from '../../../src/lib/deploy/compose/build-args.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vc-build-args-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnvLocal(content: string) {
  writeFileSync(join(tmpDir, '.env.local'), content);
}

describe('collectComposeBuildArgs', () => {
  it('returns an empty object when no .env.local exists', () => {
    expect(collectComposeBuildArgs(tmpDir)).toEqual({});
  });

  it('picks up only VITE_* keys from .env.local', () => {
    writeEnvLocal(
      [
        'VITE_PROJECT_NAME="my-app"',
        'VITE_SUPABASE_URL="http://localhost:8000"',
        'VITE_SUPABASE_ANON_KEY="anon-jwt"',
        'VITE_N8N_ENABLED="true"',
        'SUPABASE_URL="http://localhost:8000"', // not VITE_, must be excluded
        'DB_PASSWORD="secret"', // not VITE_, must be excluded
      ].join('\n'),
    );
    const args = collectComposeBuildArgs(tmpDir);
    expect(args).toEqual({
      VITE_PROJECT_NAME: 'my-app',
      VITE_SUPABASE_URL: 'http://localhost:8000',
      VITE_SUPABASE_ANON_KEY: 'anon-jwt',
      VITE_N8N_ENABLED: 'true',
    });
    expect(args).not.toHaveProperty('SUPABASE_URL');
    expect(args).not.toHaveProperty('DB_PASSWORD');
  });

  it('rewrites VITE_SUPABASE_URL to the apex https://<domain> when domain is given', () => {
    writeEnvLocal('VITE_SUPABASE_URL="http://localhost:8000"\nVITE_SUPABASE_ANON_KEY="k"');
    const args = collectComposeBuildArgs(tmpDir, { domain: 'example.com' });
    expect(args.VITE_SUPABASE_URL).toBe('https://example.com');
    expect(args.VITE_SUPABASE_URL).not.toContain('api.');
    expect(args.VITE_SUPABASE_ANON_KEY).toBe('k'); // unchanged
  });

  it('single-origin invariant: VITE_SUPABASE_URL equals VITE_PUBLIC_URL', () => {
    writeEnvLocal('VITE_PROJECT_NAME="x"');
    const args = collectComposeBuildArgs(tmpDir, { domain: 'example.com' });
    expect(args.VITE_SUPABASE_URL).toBe(args.VITE_PUBLIC_URL);
  });

  it('emits VITE_PUBLIC_URL as the apex domain (og: tags + sitemap) when domain is given', () => {
    writeEnvLocal('VITE_PROJECT_NAME="x"');
    expect(collectComposeBuildArgs(tmpDir, { domain: 'example.com' }).VITE_PUBLIC_URL).toBe(
      'https://example.com',
    );
    // No domain (e.g. IP-only deploy) → not emitted, client falls back locally.
    expect(collectComposeBuildArgs(tmpDir, {}).VITE_PUBLIC_URL).toBeUndefined();
  });

  it('overrides VITE_PROJECT_NAME with the deploy projectName', () => {
    writeEnvLocal('VITE_PROJECT_NAME="dev-local"');
    const args = collectComposeBuildArgs(tmpDir, { projectName: 'my-real-project' });
    expect(args.VITE_PROJECT_NAME).toBe('my-real-project');
  });

  it('synthesizes VITE_SUPABASE_URL even when .env.local has no such key', () => {
    writeEnvLocal('VITE_PROJECT_NAME="x"');
    const args = collectComposeBuildArgs(tmpDir, { domain: 'foo.com' });
    expect(args.VITE_SUPABASE_URL).toBe('https://foo.com');
  });

  it('passes other VITE_* feature flags through unchanged in prod context', () => {
    writeEnvLocal(
      [
        'VITE_N8N_ENABLED="true"',
        'VITE_OBSERVABILITY_ENABLED="false"',
        'VITE_REDIS_ENABLED="true"',
        'VITE_PLAUSIBLE_DOMAIN="myapp.com"',
      ].join('\n'),
    );
    const args = collectComposeBuildArgs(tmpDir, {
      projectName: 'proj',
      domain: 'example.com',
    });
    expect(args.VITE_N8N_ENABLED).toBe('true');
    expect(args.VITE_OBSERVABILITY_ENABLED).toBe('false');
    expect(args.VITE_REDIS_ENABLED).toBe('true');
    expect(args.VITE_PLAUSIBLE_DOMAIN).toBe('myapp.com');
  });
});

describe('buildArgFlags', () => {
  it('flattens a dict into alternating --build-arg / K=V tokens', () => {
    const flags = buildArgFlags({
      VITE_SUPABASE_URL: 'https://example.com',
      VITE_PROJECT_NAME: 'proj',
    });
    expect(flags).toEqual([
      '--build-arg',
      'VITE_SUPABASE_URL=https://example.com',
      '--build-arg',
      'VITE_PROJECT_NAME=proj',
    ]);
  });

  it('skips empty/undefined/null values (avoids passing literal empty ARGs)', () => {
    const flags = buildArgFlags({
      VITE_GOOD: 'present',
      VITE_EMPTY: '',
      // @ts-expect-error - testing defensive runtime behavior on bad inputs
      VITE_NULL: null,
      // @ts-expect-error - same
      VITE_UNDEF: undefined,
    });
    expect(flags).toEqual(['--build-arg', 'VITE_GOOD=present']);
  });

  it('returns an empty array for an empty dict', () => {
    expect(buildArgFlags({})).toEqual([]);
  });
});
