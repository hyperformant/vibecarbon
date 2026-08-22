/**
 * M3 Task 3 — shape assertions on the raw
 * carbon/cloud-init/k3s/do-{master,worker}-init.sh templates: install
 * ordering, k3s flag contract, and absent-flag guards. These check the
 * TEMPLATE SOURCE directly (not a rendered instance) since ordering/flag
 * presence doesn't depend on vars.
 *
 * See tests/unit/providers/digitalocean-k8s-user-data.test.ts for the
 * render-level (vars-substitution) contract, and
 * tests/unit/providers/hetzner-k8s-user-data.test.ts for the Hetzner
 * byte-identical pin.
 */
import { describe, expect, it } from 'vitest';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';

describe('M3 Task 3 — do-master-init.sh shape', () => {
  const master = loadCloudInit('do-master-init.sh');

  it('installs the digitalocean secret before the CCM, the CCM before the CSI crds, the crds before the driver, and the ready marker last', () => {
    const secretIdx = master.indexOf('create secret generic digitalocean');
    const ccmIdx = master.indexOf(
      'digitalocean-cloud-controller-manager/master/releases/digitalocean-cloud-controller-manager/v0.1.68.yml',
    );
    const crdsIdx = master.indexOf('csi-digitalocean-v4.17.0/crds.yaml');
    const driverIdx = master.indexOf('csi-digitalocean-v4.17.0/driver.yaml');
    const markerIdx = master.indexOf('touch /tmp/k3s-ready');

    for (const idx of [secretIdx, ccmIdx, crdsIdx, driverIdx, markerIdx]) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(secretIdx).toBeLessThan(ccmIdx);
    expect(ccmIdx).toBeLessThan(crdsIdx);
    expect(crdsIdx).toBeLessThan(driverIdx);
    expect(driverIdx).toBeLessThan(markerIdx);
  });

  it('pins the CCM to v0.1.68 and the CSI driver to v4.17.0 (never `master`/`latest`)', () => {
    expect(master).toContain(
      'https://raw.githubusercontent.com/digitalocean/digitalocean-cloud-controller-manager/master/releases/digitalocean-cloud-controller-manager/v0.1.68.yml',
    );
    expect(master).toContain(
      'https://raw.githubusercontent.com/digitalocean/csi-digitalocean/master/deploy/kubernetes/releases/csi-digitalocean-v4.17.0/crds.yaml',
    );
    expect(master).toContain(
      'https://raw.githubusercontent.com/digitalocean/csi-digitalocean/master/deploy/kubernetes/releases/csi-digitalocean-v4.17.0/driver.yaml',
    );
  });

  it('pre-seeds the provider-id kubelet arg from the metadata-derived droplet id', () => {
    expect(master).toContain('--kubelet-arg="provider-id=digitalocean://$DROPLET_ID"');
    expect(master).toContain('--kubelet-arg="cloud-provider=external"');
  });

  it('disables the k3s built-in cloud controller and bundled servicelb', () => {
    expect(master).toContain('--disable-cloud-controller');
    expect(master).toContain('--disable=servicelb');
  });

  it('does NOT set --flannel-backend=wireguard-native (vxlan default on DO — see M3 Task 3 report)', () => {
    expect(master).not.toContain('wireguard-native');
    // The k3s install argv itself must never pass --flannel-backend (a bare
    // comment explaining ITS ABSENCE is fine and expected) — check the
    // install command line specifically, not the whole file.
    const installLines = master
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(installLines).not.toMatch(/--flannel-backend/);
  });

  it('does NOT install snapshot-controller.yaml (VolumeSnapshots unwired, matching the equivalent provider path)', () => {
    expect(master).not.toMatch(/kubectl apply -f.*snapshot-controller\.yaml/);
  });

  it('M3 Task 9d: patches csi-do-node with a universal toleration, AFTER the driver install and BEFORE the ready marker', () => {
    // csi-do-node ships from upstream with NO tolerations at all, so it
    // never schedules onto the tainted dedicated=supabase node -- the
    // node's CSINode object then never gets the driver's `region`
    // topologyKey and any PV bound there hits a permanent volume node
    // affinity conflict (RCA: DO d3 rig, battery kept-rig deploy
    // iteration 2). This pin exists so a future CSI version bump can't
    // silently drop the patch and reintroduce the wedge.
    const driverIdx = master.indexOf('csi-digitalocean-v4.17.0/driver.yaml');
    const patchIdx = master.indexOf('kubectl patch daemonset csi-do-node');
    const markerIdx = master.indexOf('touch /tmp/k3s-ready');
    expect(driverIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(-1);
    expect(driverIdx).toBeLessThan(patchIdx);
    expect(patchIdx).toBeLessThan(markerIdx);
  });

  it('M3 Task 9d: pins the exact universal-toleration patch (a strict superset of the equivalent provider CSI release toleration set)', () => {
    expect(master).toContain('kubectl patch daemonset csi-do-node -n kube-system --type=merge -p');
    expect(master).toContain(
      '{"spec":{"template":{"spec":{"tolerations":[{"operator":"Exists"}]}}}}',
    );
  });

  it('does NOT bind a floating/reserved IP at the OS level (no ip-addr-add / systemd unit for it)', () => {
    expect(master).not.toMatch(/ip addr add/);
    expect(master).not.toMatch(/\.service/);
  });

  it('does NOT grep for a private-NIC interface name (DO VPC IP is metadata-derived, not discovered)', () => {
    expect(master).not.toContain('inet 10');
    expect(master).not.toContain('dhcpcd');
  });

  it('carries zero hetzner|hcloud|floating|10.0.1. tokens (case-insensitive)', () => {
    expect(master).not.toMatch(/hetzner|hcloud|floating|10\.0\.1\./i);
  });

  it('uses the DigitalOcean metadata path root, not the Hetzner-shaped one', () => {
    expect(master).toContain('169.254.169.254/metadata/v1/');
    expect(master).not.toContain('/hetzner/v1/metadata/');
  });
});

describe('M3 Task 3 — do-worker-init.sh shape', () => {
  const worker = loadCloudInit('do-worker-init.sh');

  it('pre-seeds the provider-id kubelet arg and cloud-provider=external', () => {
    expect(worker).toContain('--kubelet-arg="provider-id=digitalocean://$DROPLET_ID"');
    expect(worker).toContain('--kubelet-arg="cloud-provider=external"');
  });

  it('does NOT install any CCM/CSI/secret (master-only)', () => {
    expect(worker).not.toContain('create secret generic digitalocean');
    expect(worker).not.toMatch(/digitalocean-cloud-controller-manager/);
    expect(worker).not.toMatch(/csi-digitalocean/);
  });

  it('does NOT grep for a private-NIC interface name', () => {
    expect(worker).not.toContain('inet 10');
    expect(worker).not.toContain('dhcpcd');
  });

  it('carries zero hetzner|hcloud|floating|10.0.1. tokens (case-insensitive)', () => {
    expect(worker).not.toMatch(/hetzner|hcloud|floating|10\.0\.1\./i);
  });

  it('uses the DigitalOcean metadata path root, not the Hetzner-shaped one', () => {
    expect(worker).toContain('169.254.169.254/metadata/v1/');
    expect(worker).not.toContain('/hetzner/v1/metadata/');
  });
});

describe('M3 Task 5 — do-supabase-init.sh shape', () => {
  const supabase = loadCloudInit('do-supabase-init.sh');

  it('pre-seeds the provider-id kubelet arg and cloud-provider=external', () => {
    expect(supabase).toContain('--kubelet-arg="provider-id=digitalocean://$DROPLET_ID"');
    expect(supabase).toContain('--kubelet-arg="cloud-provider=external"');
  });

  it('pins the supabase node-pool via BOOT-TIME k3s agent flags (label + taint), not a post-join kubectl step', () => {
    expect(supabase).toContain('--node-label="dedicated=supabase"');
    expect(supabase).toContain('--node-label="node-pool=supabase-pool"');
    expect(supabase).toContain('--node-taint="dedicated=supabase:NoSchedule"');
    expect(supabase).not.toMatch(/kubectl (label|taint) node/);
  });

  it('does NOT install any CCM/CSI/secret (master-only)', () => {
    expect(supabase).not.toContain('create secret generic digitalocean');
    expect(supabase).not.toMatch(/digitalocean-cloud-controller-manager/);
    expect(supabase).not.toMatch(/csi-digitalocean/);
  });

  it('does NOT grep for a private-NIC interface name', () => {
    expect(supabase).not.toContain('inet 10');
    expect(supabase).not.toContain('dhcpcd');
  });

  it('pre-warms the heavy Supabase images asynchronously (does not block node readiness)', () => {
    const prewarmIdx = supabase.indexOf('supabase-image-prewarm.log');
    expect(prewarmIdx).toBeGreaterThan(-1);
    // The prewarm block backgrounds itself (`&` at the end of the nohup
    // pipeline) rather than blocking the script's exit.
    const prewarmBlock = supabase.slice(supabase.indexOf('nohup bash -c'));
    expect(prewarmBlock.trimEnd().endsWith('&')).toBe(true);
    expect(supabase).toContain('docker.io/supabase/postgres:15.1.1.78');
    expect(supabase).toContain('docker.io/library/kong:2.8.1');
  });

  it('carries zero hetzner|hcloud|floating|10.0.1. tokens (case-insensitive)', () => {
    expect(supabase).not.toMatch(/hetzner|hcloud|floating|10\.0\.1\./i);
  });

  it('uses the DigitalOcean metadata path root, not the Hetzner-shaped one', () => {
    expect(supabase).toContain('169.254.169.254/metadata/v1/');
    expect(supabase).not.toContain('/hetzner/v1/metadata/');
  });
});
