import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { operatorSecretKeys } from '../../../src/lib/config-registry.js';
import { bootstrapOperatorEnv, getBootstrappedKeys } from '../../../src/lib/project.js';

const OPERATOR_KEYS = operatorSecretKeys();

describe('bootstrapOperatorEnv', () => {
  let tempBase: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempBase = join(
      tmpdir(),
      `vibecarbon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempBase, { recursive: true });
    // Snapshot + clear every key this suite could touch, so a run never
    // leaks into/out of the real shell environment or a sibling test.
    savedEnv = {};
    for (const key of [...OPERATOR_KEYS, 'STRIPE_SECRET_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function writeEnvLocal(content: string) {
    writeFileSync(join(tempBase, '.env.local'), content);
  }

  it('loads only allowlisted operator-secret keys, never app secrets', () => {
    writeEnvLocal(
      ["HETZNER_API_TOKEN='hetzner-token'", "STRIPE_SECRET_KEY='sk_live_should_not_load'"].join(
        '\n',
      ),
    );

    const populated = bootstrapOperatorEnv(tempBase);

    expect(process.env.HETZNER_API_TOKEN).toBe('hetzner-token');
    expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(populated.has('HETZNER_API_TOKEN')).toBe(true);
    expect(populated.has('STRIPE_SECRET_KEY')).toBe(false);
  });

  it('never overrides a real shell env value with the file value', () => {
    process.env.HETZNER_API_TOKEN = 'shell-token';
    writeEnvLocal("HETZNER_API_TOKEN='file-token'");

    const populated = bootstrapOperatorEnv(tempBase);

    expect(process.env.HETZNER_API_TOKEN).toBe('shell-token');
    expect(populated.has('HETZNER_API_TOKEN')).toBe(false);
  });

  it('returns exact provenance — only the keys it actually populated', () => {
    writeEnvLocal(
      ["HETZNER_API_TOKEN='a'", "HETZNER_ACCESS_KEY='b'", "CLOUDFLARE_API_TOKEN='c'"].join('\n'),
    );

    const populated = bootstrapOperatorEnv(tempBase);

    expect(populated).toEqual(
      new Set(['HETZNER_API_TOKEN', 'HETZNER_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN']),
    );
  });

  it('is a no-op when .env.local is missing', () => {
    expect(existsSync(join(tempBase, '.env.local'))).toBe(false);

    const populated = bootstrapOperatorEnv(tempBase);

    expect(populated.size).toBe(0);
    for (const key of OPERATOR_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it('tolerates a corrupt/unparseable .env.local instead of throwing', () => {
    writeEnvLocal("this is not\nvalid dotenv at all === !!!\nHETZNER_API_TOKEN='still-parses'");

    expect(() => bootstrapOperatorEnv(tempBase)).not.toThrow();
    expect(process.env.HETZNER_API_TOKEN).toBe('still-parses');
  });

  it('getBootstrappedKeys reflects only the most recent call', () => {
    writeEnvLocal("HETZNER_API_TOKEN='a'");
    bootstrapOperatorEnv(tempBase);
    expect(getBootstrappedKeys()).toEqual(new Set(['HETZNER_API_TOKEN']));

    const tempBase2 = join(
      tmpdir(),
      `vibecarbon-test-${Date.now()}-${Math.random().toString(36).slice(2)}-2`,
    );
    mkdirSync(tempBase2, { recursive: true });
    try {
      // HETZNER_API_TOKEN is now "real env" (set by the previous call), and
      // tempBase2 has no .env.local at all — the second call should populate
      // nothing, and provenance should reset to empty rather than sticking
      // to the first call's result.
      const populated2 = bootstrapOperatorEnv(tempBase2);
      expect(populated2.size).toBe(0);
      expect(getBootstrappedKeys()).toEqual(new Set());
    } finally {
      rmSync(tempBase2, { recursive: true, force: true });
    }
  });
});
