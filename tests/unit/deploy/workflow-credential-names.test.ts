/**
 * Workflow credential names must BE the names src/ reads — not a translation
 * of them.
 *
 * `src/` reads one uniform convention for object-storage credentials:
 * `<PROVIDER>_ACCESS_KEY`, `<PROVIDER>_SECRET_KEY`, `<PROVIDER>_STORAGE_REGION`
 * (plus `DOCKER_HUB_USERNAME` / `DOCKER_HUB_TOKEN`). GitHub's stored names had
 * drifted into three separate legacy styles — `HETZNER_S3_ACCESS_KEY`,
 * `DIGITALOCEAN_SPACES_KEY`, `LINODE_/VULTR_OBJECT_STORAGE_KEY` — and
 * e2e-us-perf.yml quietly translated between them in ~32 places.
 *
 * That translation layer is the defect this guards. A rename map that exists
 * in exactly one file is a map somebody eventually gets wrong in one row, and
 * the failure is a credential that is present-but-wrong: the job runs, the SDK
 * authenticates as nobody, and the error surfaces far from the cause.
 *
 * So the rule is pass-through: for any credential env var a workflow sets from
 * a secret or variable, the two names must be identical.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');

/** Credential env vars this rule covers — the object-storage + registry families. */
const COVERED =
  /^(HETZNER|DIGITALOCEAN|LINODE|VULTR|SCALEWAY)_(ACCESS_KEY|SECRET_KEY|STORAGE_REGION)$|^DOCKER_HUB_(USERNAME|TOKEN)$/;

/** Legacy spellings that must never reappear on the GitHub side. */
const LEGACY =
  /(?:secrets|vars)\.[A-Z_]*(?:S3_ACCESS_KEY|S3_SECRET_KEY|SPACES_KEY|SPACES_SECRET|OBJECT_STORAGE_[A-Z]+|DOCKERHUB_[A-Z]+)/;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

describe('workflow credential names', () => {
  it('every covered credential env var is set pass-through (env name === secret/var name)', () => {
    const violations: string[] = [];
    for (const file of workflowFiles()) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf-8');
      for (const line of text.split('\n')) {
        const m = line.match(
          /^\s*([A-Z0-9_]+):\s*\$\{\{\s*(secrets|vars)\.([A-Z0-9_]+)\s*\}\}\s*$/,
        );
        if (!m) continue;
        const [, envName, , refName] = m;
        if (!COVERED.test(envName)) continue;
        if (envName !== refName) violations.push(`${file}: ${envName} <- ${refName}`);
      }
    }
    expect(violations, 'credential names must not be translated in a workflow').toEqual([]);
  });

  it('no workflow references a legacy credential spelling', () => {
    const violations: string[] = [];
    for (const file of workflowFiles()) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf-8');
      for (const line of text.split('\n')) {
        // Comments may legitimately name a stale spelling to explain it.
        if (line.trim().startsWith('#')) continue;
        if (LEGACY.test(line)) violations.push(`${file}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the census actually looks at workflows (never vacuously green)', () => {
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(0);
    const anyCredential = files.some((f) =>
      /\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/.test(readFileSync(join(WORKFLOWS, f), 'utf-8')),
    );
    expect(anyCredential, 'no workflow reads any secret — the sweep is inert').toBe(true);
  });
});
