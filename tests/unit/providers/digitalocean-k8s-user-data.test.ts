/**
 * M3 Task 3 (master/worker) + Task 5 (supabase) —
 * DigitalOceanProvider.getK8s{Master,Worker,Supabase}UserData.
 *
 * Covers the render-level contract for the
 * carbon/cloud-init/k3s/do-{master,worker,supabase}-init.sh templates: zero
 * `${...}` residue with the documented (complete) vars set, DO metadata
 * paths present, provider-id kubelet arg present, and zero cross-provider
 * token leakage. Template-shape assertions that don't depend on rendering
 * (line ordering, absent flags) live in
 * tests/unit/deploy/do-cloud-init-k3s-shape.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';

const masterVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  do_token: 'dop_v1_test_token_1234',
};

const workerVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.10.0.2',
};

const supabaseVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.10.0.2',
};

// Complete `${...}` placeholder sets scraped straight from the raw
// templates — the "parse both" half of the template-var contract test:
// this MUST equal the documented vars keys (masterVars/workerVars above)
// exactly, or either the JSDoc or the template has drifted.
function templatePlaceholders(source: string): Set<string> {
  const matches = source.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g);
  return new Set([...matches].map((m) => m[1]));
}

describe('M3 Task 3 — DigitalOceanProvider k8s user-data statics', () => {
  describe('getK8sMasterUserData', () => {
    it('renders carbon/cloud-init/k3s/do-master-init.sh with no unrendered placeholders given the full vars set', async () => {
      const rendered = await DigitalOceanProvider.getK8sMasterUserData(masterVars);
      expect(rendered).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    });

    it('template var contract: do-master-init.sh placeholder set is EXACTLY {k3s_version, k3s_token, do_token}', () => {
      const raw = loadCloudInit('do-master-init.sh');
      expect(templatePlaceholders(raw)).toEqual(new Set(Object.keys(masterVars)));
    });

    it('includes the DigitalOcean metadata paths (id, public, private)', async () => {
      // Paths are passed as fetch_metadata() call arguments, not
      // concatenated at template-source level — the base URL
      // (169.254.169.254/metadata/v1/) is fixed in fetch_metadata's own
      // curl line, and each caller supplies its own path suffix.
      const rendered = await DigitalOceanProvider.getK8sMasterUserData(masterVars);
      expect(rendered).toContain('http://169.254.169.254/metadata/v1/');
      expect(rendered).toContain('fetch_metadata "id"');
      expect(rendered).toContain('fetch_metadata "interfaces/public/0/ipv4/address"');
      expect(rendered).toContain('fetch_metadata "interfaces/private/0/ipv4/address"');
    });

    it('includes the do_token value in the digitalocean secret create, not a placeholder', async () => {
      const rendered = await DigitalOceanProvider.getK8sMasterUserData(masterVars);
      expect(rendered).toContain('--from-literal=access-token="dop_v1_test_token_1234"');
    });

    it('substitutes k3s_version/k3s_token verbatim', async () => {
      const rendered = await DigitalOceanProvider.getK8sMasterUserData(masterVars);
      expect(rendered).toContain('INSTALL_K3S_VERSION="v1.31.5+k3s1"');
      expect(rendered).toContain('--token "deadbeefcafe1234567890abcdef"');
    });

    it('carries zero hetzner|hcloud|floating|10.0.1. tokens (case-insensitive)', async () => {
      const rendered = await DigitalOceanProvider.getK8sMasterUserData(masterVars);
      expect(rendered).not.toMatch(/hetzner|hcloud|floating|10\.0\.1\./i);
    });

    it('M3 Task 9d: the rendered output patches csi-do-node with a universal toleration (survives full var substitution)', async () => {
      const rendered = await DigitalOceanProvider.getK8sMasterUserData(masterVars);
      expect(rendered).toContain(
        'kubectl patch daemonset csi-do-node -n kube-system --type=merge -p',
      );
      expect(rendered).toContain(
        '{"spec":{"template":{"spec":{"tolerations":[{"operator":"Exists"}]}}}}',
      );
    });
  });

  describe('getK8sWorkerUserData', () => {
    it('renders carbon/cloud-init/k3s/do-worker-init.sh with no unrendered placeholders given the full vars set', async () => {
      const rendered = await DigitalOceanProvider.getK8sWorkerUserData(workerVars);
      expect(rendered).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    });

    it('template var contract: do-worker-init.sh placeholder set is EXACTLY {k3s_version, k3s_token, master_ip}', () => {
      const raw = loadCloudInit('do-worker-init.sh');
      expect(templatePlaceholders(raw)).toEqual(new Set(Object.keys(workerVars)));
    });

    it('includes the DigitalOcean metadata paths (id, public, private)', async () => {
      const rendered = await DigitalOceanProvider.getK8sWorkerUserData(workerVars);
      expect(rendered).toContain('http://169.254.169.254/metadata/v1/');
      expect(rendered).toContain('fetch_metadata "id"');
      expect(rendered).toContain('fetch_metadata "interfaces/public/0/ipv4/address"');
      expect(rendered).toContain('fetch_metadata "interfaces/private/0/ipv4/address"');
    });

    it('joins the master via the rendered master_ip on :6443', async () => {
      const rendered = await DigitalOceanProvider.getK8sWorkerUserData(workerVars);
      expect(rendered).toContain('K3S_URL="https://10.10.0.2:6443"');
      expect(rendered).toContain('"https://10.10.0.2:6443/readyz"');
    });

    it('carries zero hetzner|hcloud|floating|10.0.1. tokens (case-insensitive)', async () => {
      const rendered = await DigitalOceanProvider.getK8sWorkerUserData(workerVars);
      expect(rendered).not.toMatch(/hetzner|hcloud|floating|10\.0\.1\./i);
    });
  });

  describe('getK8sSupabaseUserData', () => {
    it('renders carbon/cloud-init/k3s/do-supabase-init.sh with no unrendered placeholders given the full vars set', async () => {
      const rendered = await DigitalOceanProvider.getK8sSupabaseUserData(supabaseVars);
      expect(rendered).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    });

    it('template var contract: do-supabase-init.sh placeholder set is EXACTLY {k3s_version, k3s_token, master_ip}', () => {
      const raw = loadCloudInit('do-supabase-init.sh');
      expect(templatePlaceholders(raw)).toEqual(new Set(Object.keys(supabaseVars)));
    });

    it('includes the DigitalOcean metadata paths (id, public, private)', async () => {
      const rendered = await DigitalOceanProvider.getK8sSupabaseUserData(supabaseVars);
      expect(rendered).toContain('http://169.254.169.254/metadata/v1/');
      expect(rendered).toContain('fetch_metadata "id"');
      expect(rendered).toContain('fetch_metadata "interfaces/public/0/ipv4/address"');
      expect(rendered).toContain('fetch_metadata "interfaces/private/0/ipv4/address"');
    });

    it('joins the master via the rendered master_ip on :6443', async () => {
      const rendered = await DigitalOceanProvider.getK8sSupabaseUserData(supabaseVars);
      expect(rendered).toContain('K3S_URL="https://10.10.0.2:6443"');
      expect(rendered).toContain('"https://10.10.0.2:6443/readyz"');
    });

    it('pre-seeds the provider-id kubelet arg and pins the supabase node-pool label/taint', async () => {
      const rendered = await DigitalOceanProvider.getK8sSupabaseUserData(supabaseVars);
      expect(rendered).toContain('--kubelet-arg="provider-id=digitalocean://$DROPLET_ID"');
      expect(rendered).toContain('--node-label="dedicated=supabase"');
      expect(rendered).toContain('--node-label="node-pool=supabase-pool"');
      expect(rendered).toContain('--node-taint="dedicated=supabase:NoSchedule"');
    });

    it('carries zero hetzner|hcloud|floating|10.0.1. tokens (case-insensitive)', async () => {
      const rendered = await DigitalOceanProvider.getK8sSupabaseUserData(supabaseVars);
      expect(rendered).not.toMatch(/hetzner|hcloud|floating|10\.0\.1\./i);
    });
  });

  it('do-{master,worker,supabase}-init.sh ship in carbon/cloud-init/k3s/', () => {
    expect(() => loadCloudInit('do-master-init.sh')).not.toThrow();
    expect(() => loadCloudInit('do-worker-init.sh')).not.toThrow();
    expect(() => loadCloudInit('do-supabase-init.sh')).not.toThrow();
  });

  // Mirrors transliterateToAscii's own codePoint check (digitalocean-compose.js)
  // rather than a control-character regex range, which static analysis flags.
  function isPureAscii(text: string): boolean {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0x7f) return false;
    }
    return true;
  }

  it('all three templates are pure ASCII (DO user-data wire contract — see digitalocean-compose.js ASCII_TRANSLITERATION_MAP RCA)', () => {
    const masterPath = join(__dirname, '../../../carbon/cloud-init/k3s/do-master-init.sh');
    const workerPath = join(__dirname, '../../../carbon/cloud-init/k3s/do-worker-init.sh');
    const supabasePath = join(__dirname, '../../../carbon/cloud-init/k3s/do-supabase-init.sh');
    expect(isPureAscii(readFileSync(masterPath, 'utf-8'))).toBe(true);
    expect(isPureAscii(readFileSync(workerPath, 'utf-8'))).toBe(true);
    expect(isPureAscii(readFileSync(supabasePath, 'utf-8'))).toBe(true);
  });
});
