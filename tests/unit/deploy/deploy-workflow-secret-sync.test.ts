import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_RUNTIME_EXTRA_KEYS,
  APP_RUNTIME_KEYS,
} from '../../../src/lib/deploy/app-runtime-env.js';
import { INFRA_SECRET_KEYS } from '../../../src/lib/deploy/k8s/k3s.js';
import { DNS_PROVIDERS, DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

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

// The app pod envFrom's vibecarbon-app-secrets whole, so the workflow's two
// lists decide what it can see: the del() list (every cloud and DNS token the
// CLI can seed, per the registries) and INFRA_KEYS (k3s.js INFRA_SECRET_KEYS,
// routed only to vibecarbon-infra-secrets).
describe('deploy.yml splits the app Secret from the infra Secret', () => {
  const wf = readFileSync(join(process.cwd(), 'carbon/.github/workflows/deploy.yml'), 'utf-8');
  // The jq del( … ) block, not the comment that names it.
  const delList = wf.match(/del\(\n([\s\S]*?)\n\s*\)/)?.[1] ?? '';

  it('creates both Secrets and no longer the single vibecarbon-secrets', () => {
    expect(wf).toContain('kubectl create secret generic vibecarbon-app-secrets');
    expect(wf).toContain('kubectl create secret generic vibecarbon-infra-secrets');
    expect(wf).not.toContain('generic vibecarbon-secrets');
  });

  it('drops every cloud and DNS token the CLI knows about', () => {
    const names = new Set<string>();
    for (const row of Object.values(DNS01_PROVIDERS)) names.add(row.tokenEnvVar);
    for (const row of Object.values(DNS_PROVIDERS)) names.add(row.tokenEnv);
    for (const P of Object.values(PROVIDERS)) {
      if (P.TOKEN_ENV) names.add(P.TOKEN_ENV);
      if (P.CLI_TOKEN_ENV) names.add(P.CLI_TOKEN_ENV);
    }
    expect(names.size).toBeGreaterThan(10);
    const kept = [...names].filter((n) => !new RegExp(`\\.${n}\\b`).test(delList));
    expect(kept, 'tokens the app Secret would carry').toEqual([]);
  });

  it('selects exactly APP_RUNTIME_KEYS and the extras for the app Secret', () => {
    const app = wf.match(/APP_KEYS='(\[[^']*\])'/)?.[1];
    expect(app, 'APP_KEYS not found').toBeTruthy();
    expect([...JSON.parse(app as string)].sort()).toEqual(
      [...APP_RUNTIME_KEYS, ...APP_RUNTIME_EXTRA_KEYS].sort(),
    );
    // Positive selection: the app branch keeps only APP_KEYS members.
    expect(wf).toMatch(/else \(\$app \| index\(\$k\)\) != null/);
  });

  it('routes exactly INFRA_SECRET_KEYS to the infra Secret', () => {
    const infra = wf.match(/INFRA_KEYS='(\[[^']*\])'/)?.[1];
    expect(infra, 'INFRA_KEYS not found').toBeTruthy();
    expect(JSON.parse(infra as string)).toEqual(INFRA_SECRET_KEYS);
  });
});
