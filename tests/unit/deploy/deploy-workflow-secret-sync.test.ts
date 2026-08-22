import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards that the deploy workflow's apply-secrets step stays self-syncing —
// i.e. it materializes the Secret from toJSON(secrets) rather than re-listing
// keys. A regression to an enumerated --from-literal list would silently drop
// any new `vibecarbon configure` secret the CLI begins seeding.
describe('deploy.yml apply-secrets is self-syncing', () => {
  const wf = readFileSync(join(process.cwd(), 'carbon/.github/workflows/deploy.yml'), 'utf-8');

  it('builds the Secret from toJSON(secrets)', () => {
    expect(wf).toContain('toJSON(secrets)');
  });

  it('drops infra/CI secrets that must not reach the app pod', () => {
    // The exclude list is the only maintained piece; these must stay excluded.
    for (const key of ['KUBECONFIG_B64', 'HETZNER_API_TOKEN', 'CLOUDFLARE_API_TOKEN']) {
      expect(wf).toMatch(new RegExp(`del\\([\\s\\S]*${key}[\\s\\S]*\\)`));
    }
  });

  it('no longer enumerates feature secrets as per-key env mappings', () => {
    // The old shape mapped each key explicitly, e.g.
    //   SMTP_PASSWORD: ${{ secrets.SMTP_PASSWORD }}
    expect(wf).not.toMatch(/SMTP_PASSWORD:\s*\$\{\{\s*secrets\.SMTP_PASSWORD/);
    expect(wf).not.toMatch(/DB_PASSWORD:\s*\$\{\{\s*secrets\.DB_PASSWORD/);
  });
});
