/**
 * The k8s storage service must actually reach object storage.
 *
 * `supabase.values.yaml` shipped `STORAGE_BACKEND: s3` alongside a literal
 * `stub` region and bucket, NO endpoint and NO credentials. storage-api came
 * up pointed at S3 with nothing to reach it with, and every upload 500'd:
 *
 *   CredentialsProviderError: Could not load credentials from any providers
 *
 * Live DO k8s, 2026-08-21 — on a cluster that was otherwise green. It stayed
 * invisible for months because the e2e storage checks skipped on a bucket
 * nothing ever created, so the k8s tier shipped "green" with its
 * object-storage path non-functional on every provider.
 *
 * Compose has always set the full set; these pins hold k8s to the same
 * contract.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const values = readFileSync(
  fileURLToPath(new URL('../../../carbon/k8s/values/supabase.values.yaml', import.meta.url)),
  'utf8',
);
const k3s = readFileSync(
  fileURLToPath(new URL('../../../src/lib/deploy/k8s/k3s.js', import.meta.url)),
  'utf8',
);

/** The `storage:` env list only — the file also configures db, imgproxy, studio. */
const storageEnv = () => {
  const from = values.indexOf('\n  storage:\n');
  expect(from, 'storage env block not found').toBeGreaterThan(-1);
  const next = values.indexOf('\n  imgproxy:', from);
  return values.slice(from, next === -1 ? undefined : next);
};

describe('k8s storage S3 wiring', () => {
  it('sets every var compose sets — credentials included', () => {
    const env = storageEnv();
    for (const key of [
      'STORAGE_BACKEND',
      'REGION',
      'GLOBAL_S3_BUCKET',
      'GLOBAL_S3_ENDPOINT',
      'GLOBAL_S3_FORCE_PATH_STYLE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(env, `storage env is missing ${key}`).toMatch(new RegExp(`name: ${key}\\b`));
    }
  });

  it('no S3 setting is left as a literal stub', () => {
    // `stub` is what shipped, and it is indistinguishable from a real value
    // to anything that does not try to connect.
    const env = storageEnv();
    for (const key of ['REGION', 'GLOBAL_S3_BUCKET', 'GLOBAL_S3_ENDPOINT']) {
      const m = env.match(new RegExp(`name: ${key}\\n\\s+value: "?([^"\\n]*)"?`));
      expect(m, `${key} not found`).toBeTruthy();
      expect(m?.[1], `${key} is still a hardcoded stub`).not.toBe('stub');
    }
  });

  it('forces path-style addressing — no provider we ship is virtual-host', () => {
    // Hetzner / Spaces / Linode / Vultr / Scaleway all need path style;
    // virtual-host resolves to a bucket subdomain that does not exist.
    expect(storageEnv()).toMatch(/name: GLOBAL_S3_FORCE_PATH_STYLE\n\s+value: "true"/);
  });

  it('uses the STORAGE bucket, never the backup bucket', () => {
    // THE trap: rendering S3_BACKUP_BUCKET here would put customer uploads and
    // WAL segments in one bucket.
    const env = storageEnv();
    expect(env).toMatch(/name: GLOBAL_S3_BUCKET\n\s+value: "\{\{S3_STORAGE_BUCKET\}\}"/);
    expect(env).not.toMatch(/S3_BACKUP_BUCKET/);
  });

  it('every placeholder the storage block uses is actually substituted', () => {
    // An unrendered `{{...}}` reaches the pod verbatim and fails exactly like
    // `stub` did — silently, until something tries to connect.
    const used = [...storageEnv().matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(4);
    for (const ph of new Set(used)) {
      expect(k3s, `${ph} has no substitution in k3s.js`).toMatch(
        new RegExp(`\\\\\\{\\\\\\{${ph}\\\\\\}\\\\\\}`),
      );
    }
  });

  it('the rendered values file is written with secret permissions', () => {
    // It now carries S3 credentials as well as ADMIN_PASSWORD.
    expect(k3s).toMatch(/writeSecretFile\(tmpValues, rendered\)/);
  });
});
