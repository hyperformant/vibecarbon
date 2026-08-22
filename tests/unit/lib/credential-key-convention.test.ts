/**
 * Census/guard for the object-storage credential env-var convention.
 *
 * ONE clean, minimal naming convention for the operator-facing cloud
 * object-storage credentials, tied to the (already customer-visible, CI-pinned)
 * compute/DNS token env:
 *
 *   compute/DNS token   <PROVIDER>_API_TOKEN        (pre-existing, unchanged)
 *   object storage      <PROVIDER>_ACCESS_KEY
 *                       <PROVIDER>_SECRET_KEY
 *                       <PROVIDER>_STORAGE_REGION
 *
 * where `<PROVIDER>` is the provider's registry id, uppercased (`hetzner` ->
 * `HETZNER`), so the storage keys can never drift away from the id the
 * provider is selected by.
 *
 * SCOPE — operator keys only, NOT the deployed stack's S3_* namespace.
 * `S3_ACCESS_KEY`/`S3_SECRET_KEY` (and `S3_REGION`/`S3_ENDPOINT`/`S3_BUCKET`/…)
 * ALSO exist as a PROVIDER-AGNOSTIC, server-side namespace: `renderBundle`
 * (deploy/bundle.js) and `applyVibecarbonSecrets` (deploy/k8s/k3s.js) write
 * those names from the resolved `s3Config` for EVERY provider, and
 * carbon/docker-compose.yml maps `${S3_ACCESS_KEY}` -> `AWS_ACCESS_KEY_ID` for
 * wal-g. That namespace is the s3Config/AWS_* plumbing and MUST survive — it is
 * not a Hetzner operator key, so this guard deliberately does NOT ban
 * `S3_ACCESS_KEY` blanket-wide across `src/`. It bans it only on the OPERATOR
 * surface (provider-class storage statics, the config-registry operator-secret
 * class, the guided-setup + menu modules). The `*_SPACES_*` / `*_OBJECT_STORAGE_*`
 * spellings have no server-side use at all, so those ARE banned everywhere in
 * `src/`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { operatorSecretKeys } from '../../../src/lib/config-registry.js';
import { parseDotenv } from '../../../src/lib/project.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

/**
 * Canonical prefix for a provider: its registry id, uppercased.
 *
 * This used to strip `_API_TOKEN` off TOKEN_ENV, which silently assumed every
 * provider's token env is spelled `<PREFIX>_API_TOKEN`. Scaleway is the first
 * one where that is false — its API credential IS the secret key
 * (TOKEN_ENV = 'SCALEWAY_SECRET_KEY'), so the strip was a no-op and the
 * convention demanded `SCALEWAY_SECRET_KEY_ACCESS_KEY`. The registry id is
 * what `<PROVIDER>` has always meant; derive it from that instead.
 */
function providerPrefix(id: string): string {
  return id.toUpperCase();
}

// Legacy spellings the standardization retired. Any of these appearing on the
// operator surface is a regression.
const LEGACY_OPERATOR_KEY = /^(S3_ACCESS_KEY|S3_SECRET_KEY|HETZNER_S3_REGION)$/;
// Sub-patterns that only ever named an operator storage key (never a
// server-side var) — safe to ban anywhere in src/.
const LEGACY_OPERATOR_ONLY_PATTERN =
  /_SPACES_(KEY|SECRET|REGION)|_OBJECT_STORAGE_(KEY|SECRET|REGION)/;

describe('credential key convention — provider storage statics', () => {
  it('every provider OBJECT_STORAGE_ENV matches <PROVIDER>_ACCESS_KEY/<PROVIDER>_SECRET_KEY', () => {
    for (const [id, ProviderClass] of Object.entries(PROVIDERS)) {
      const P = ProviderClass as unknown as {
        TOKEN_ENV: string;
        OBJECT_STORAGE_ENV: string[];
      };
      const pair = P.OBJECT_STORAGE_ENV;
      if (!pair || pair.length === 0) continue; // provider with no object storage
      const prefix = providerPrefix(id);
      expect(pair, `${id}.OBJECT_STORAGE_ENV must be a [access, secret] pair`).toHaveLength(2);
      expect(pair[0], `${id} access-key env`).toBe(`${prefix}_ACCESS_KEY`);
      expect(pair[1], `${id} secret-key env`).toBe(`${prefix}_SECRET_KEY`);
    }
  });

  it('every provider S3_REGION_ENV (when set) matches <PROVIDER>_STORAGE_REGION', () => {
    for (const [id, ProviderClass] of Object.entries(PROVIDERS)) {
      const P = ProviderClass as unknown as { TOKEN_ENV: string; S3_REGION_ENV: string };
      if (!P.S3_REGION_ENV) continue;
      const prefix = providerPrefix(id);
      expect(P.S3_REGION_ENV, `${id} storage-region env`).toBe(`${prefix}_STORAGE_REGION`);
    }
  });

  it('no provider storage static carries a legacy spelling', () => {
    for (const [id, ProviderClass] of Object.entries(PROVIDERS)) {
      const P = ProviderClass as unknown as { OBJECT_STORAGE_ENV: string[]; S3_REGION_ENV: string };
      for (const key of [...(P.OBJECT_STORAGE_ENV ?? []), P.S3_REGION_ENV].filter(Boolean)) {
        expect(LEGACY_OPERATOR_KEY.test(key), `${id}: ${key} is a legacy operator key`).toBe(false);
        expect(
          LEGACY_OPERATOR_ONLY_PATTERN.test(key),
          `${id}: ${key} is a legacy operator key`,
        ).toBe(false);
      }
    }
  });
});

describe('credential key convention — config-registry operator secrets', () => {
  it('no operator-secret key uses a legacy spelling', () => {
    for (const key of operatorSecretKeys()) {
      expect(LEGACY_OPERATOR_KEY.test(key), `${key} is a legacy operator key`).toBe(false);
      expect(LEGACY_OPERATOR_ONLY_PATTERN.test(key), `${key} is a legacy operator key`).toBe(false);
    }
  });

  it('every provider storage static is registry-backed for a configure-managed provider', () => {
    // Hetzner + DigitalOcean are configure-managed; their access/secret pairs
    // must appear in the operator-secret registry under the new names.
    const registry = new Set(operatorSecretKeys());
    for (const id of ['hetzner', 'digitalocean']) {
      const P = PROVIDERS[id] as unknown as { OBJECT_STORAGE_ENV: string[] };
      for (const key of P.OBJECT_STORAGE_ENV ?? []) {
        expect(registry.has(key), `${id}: ${key} must be an operator-secret registry key`).toBe(
          true,
        );
      }
    }
  });
});

describe('credential key convention — config-registry <-> .env.e2e.example parity', () => {
  const examplePath = join(process.cwd(), 'tests', '.env.e2e.example');
  const exampleKeys = Object.keys(parseDotenv(readFileSync(examplePath, 'utf-8')));

  // DOCKER_HUB_* are operator-shell-level (deliberately NOT in the registry —
  // see config-registry.js's providers block). VIBECARBON_TEST_LICENSE_KEY is
  // test-harness-only: it is consumed by tests/integration/_harness/run-cli.ts
  // and activated for e2e, never read by the product, so registering it would
  // add a credential to the CLI's config surface that no command uses. Every
  // OTHER key in the example is an operator-secret and must be registry-backed,
  // and vice-versa.
  const NON_REGISTRY_EXAMPLE_KEYS = new Set([
    'DOCKER_HUB_USERNAME',
    'DOCKER_HUB_TOKEN',
    'VIBECARBON_TEST_LICENSE_KEY',
  ]);

  it('.env.e2e.example carries no legacy spelling', () => {
    for (const key of exampleKeys) {
      expect(LEGACY_OPERATOR_KEY.test(key), `${key} is a legacy operator key`).toBe(false);
      expect(LEGACY_OPERATOR_ONLY_PATTERN.test(key), `${key} is a legacy operator key`).toBe(false);
    }
  });

  it('operator-secret registry keys == .env.e2e.example keys (minus non-registry keys)', () => {
    const exampleOperatorKeys = exampleKeys.filter((k) => !NON_REGISTRY_EXAMPLE_KEYS.has(k)).sort();
    expect(exampleOperatorKeys).toEqual([...operatorSecretKeys()].sort());
  });
});

describe('credential key convention — no legacy operator-only spellings survive in src/', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(js|ts|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('no *_SPACES_* / *_OBJECT_STORAGE_* credential spelling remains under src/', () => {
    const srcRoot = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const text = readFileSync(file, 'utf-8');
      for (const line of text.split('\n')) {
        if (LEGACY_OPERATOR_ONLY_PATTERN.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `legacy operator-only spellings still present:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
