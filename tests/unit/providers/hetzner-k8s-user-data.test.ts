/**
 * M3 Task 3 — HetznerProvider.getK8sMasterUserData/getK8sWorkerUserData
 * byte-identical pin.
 *
 * These two statics are an ADDITIVE wrap around the existing
 * `carbon/cloud-init/k3s/{master,worker}-init.sh` templates — hetzner-k8s.js
 * and deploy/k8s/k3s.js's own loadCloudInit/renderScript call sites are left
 * untouched this task (see Task 3 dossier). The wrap must therefore produce
 * BYTE-IDENTICAL output to what those call sites already render.
 *
 * `tests/fixtures/k3s-hetzner-{master,worker,supabase}-init-rendered.txt`
 * were captured by calling loadCloudInit/renderScript directly (the
 * pre-existing render path) with the vars below — see task-3-report.md for
 * the original capture command.
 *
 * RE-CAPTURED 2026-08-05 (private-NIC guard): the fixtures now include the
 * `# @include _private-net-guard.sh` body. They no longer pin the M3-era
 * bytes — what they pin is that the wrap still adds nothing of its own,
 * which the "algebraically identical" cases below assert independently of
 * any stored bytes. Re-capture the fixtures deliberately when a template
 * changes; never to make a red test go green.
 *
 * RE-CAPTURED 2026-08-20 (apt dpkg-lock timeout): all three init scripts
 * traded their `fuser` lock-poll loop for `apt-get -o
 * DPkg::Lock::Timeout=300` (see src/lib/deploy/apt.js). Same standing
 * reasoning — the "algebraically identical" cases below are what prove the
 * wrap adds nothing, and they hold regardless of the stored bytes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCloudInit, renderScript } from '../../../src/lib/iac/cloud-init.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const masterVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  cluster_name: 'acme-prod',
  disable_traefik: 'true',
  hcloud_token: 'htk_test_token_1234',
  network_id: 12345,
  floating_ip: '203.0.113.10',
  project_name: 'acme',
};

const workerVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.1',
  cluster_name: 'acme-prod',
};

const supabaseVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.1',
};

describe('M3 Task 3 — HetznerProvider k8s user-data statics (byte-identical wrap)', () => {
  it('getK8sMasterUserData matches the stored fixture (pre-existing render, byte-for-byte)', async () => {
    const fixture = readFileSync(
      join(__dirname, '../../fixtures/k3s-hetzner-master-init-rendered.txt'),
      'utf-8',
    );
    const rendered = await HetznerProvider.getK8sMasterUserData(masterVars);
    expect(rendered).toBe(fixture);
  });

  it('getK8sWorkerUserData matches the stored fixture (pre-existing render, byte-for-byte)', async () => {
    const fixture = readFileSync(
      join(__dirname, '../../fixtures/k3s-hetzner-worker-init-rendered.txt'),
      'utf-8',
    );
    const rendered = await HetznerProvider.getK8sWorkerUserData(workerVars);
    expect(rendered).toBe(fixture);
  });

  it('getK8sMasterUserData is algebraically identical to calling loadCloudInit/renderScript directly (proves the wrap adds nothing)', async () => {
    const direct = renderScript(loadCloudInit('master-init.sh'), masterVars);
    const wrapped = await HetznerProvider.getK8sMasterUserData(masterVars);
    expect(wrapped).toBe(direct);
  });

  it('getK8sWorkerUserData is algebraically identical to calling loadCloudInit/renderScript directly (proves the wrap adds nothing)', async () => {
    const direct = renderScript(loadCloudInit('worker-init.sh'), workerVars);
    const wrapped = await HetznerProvider.getK8sWorkerUserData(workerVars);
    expect(wrapped).toBe(direct);
  });

  it('both renders leave no unrendered template placeholders with a full vars object', async () => {
    const master = await HetznerProvider.getK8sMasterUserData(masterVars);
    const worker = await HetznerProvider.getK8sWorkerUserData(workerVars);
    expect(master).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    expect(worker).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });

  it('getK8sSupabaseUserData matches the stored fixture (pre-existing render, byte-for-byte)', async () => {
    const fixture = readFileSync(
      join(__dirname, '../../fixtures/k3s-hetzner-supabase-init-rendered.txt'),
      'utf-8',
    );
    const rendered = await HetznerProvider.getK8sSupabaseUserData(supabaseVars);
    expect(rendered).toBe(fixture);
  });

  it('getK8sSupabaseUserData is algebraically identical to calling loadCloudInit/renderScript directly (proves the wrap adds nothing)', async () => {
    const direct = renderScript(loadCloudInit('supabase-init.sh'), supabaseVars);
    const wrapped = await HetznerProvider.getK8sSupabaseUserData(supabaseVars);
    expect(wrapped).toBe(direct);
  });

  it('getK8sSupabaseUserData leaves no unrendered template placeholders with a full vars object', async () => {
    const supabase = await HetznerProvider.getK8sSupabaseUserData(supabaseVars);
    expect(supabase).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });
});
