/**
 * csi_fetch_mirrored (carbon/cloud-init/k3s/_csi-image-mirror.sh): how a
 * master's CSI install rewrites its manifest's images, and when it refuses.
 *
 * The census that the rewrite puts the deploy re-pin's refs on the re-pin's
 * containers is in k8s-image-mirrors.test.ts. This file pins the rewrite's
 * own behaviour, run under bash from a rendered master the way the install
 * runs it: a manifest change upstream must stop the install loudly rather
 * than leave a node pulling from registry.k8s.io, and a failed download must
 * return to the install's retry loop rather than end the script.
 */
import { describe, expect, it } from 'vitest';
import {
  csiImageRewriteVars,
  loadCloudInit,
  renderScript,
} from '../../../src/lib/iac/cloud-init.js';
import { csiInstallImageRewrites } from '../../../src/lib/images.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import {
  csiManifest,
  imagesByContainer,
  runCsiInstallRewrite,
  UPSTREAM_CSI_MANIFESTS,
} from '../../_shared/csi-install-rewrite.js';

const VARS = { k3s_version: 'v1.37.2+k3s1', k3s_token: 'deadbeefcafe1234567890abcdef' };
// DigitalOcean's carries both kinds of ref: registry.k8s.io sidecars and a
// bare Docker Hub `alpine:3`.
const UPSTREAM = UPSTREAM_CSI_MANIFESTS.digitalocean.workloads as Record<
  string,
  Record<string, string>
>;
const CONTROLLER = 'statefulset/csi-do-controller';
const NODE = 'daemonset/csi-do-node';
const master = () => DigitalOceanProvider.getK8sMasterUserData(VARS);
const mirrorOf = (from: string) =>
  csiInstallImageRewrites('digitalocean').find((r) => r.from === from)?.to;

/** UPSTREAM with `edit` applied to a copy of one workload's containers. */
const withWorkload = (
  workload: string,
  edit: (containers: Record<string, string>) => void,
): Record<string, Record<string, string>> => {
  const containers = { ...UPSTREAM[workload] };
  edit(containers);
  return { ...UPSTREAM, [workload]: containers };
};

describe('csi_fetch_mirrored, the master CSI install’s image rewrite', () => {
  it('stops the install when the manifest lacks a ref it rewrites, naming the ref', async () => {
    const missing = UPSTREAM[CONTROLLER]['csi-snapshotter'];
    const manifest = csiManifest(
      withWorkload(CONTROLLER, (c) => {
        delete c['csi-snapshotter'];
      }),
    );
    const { status, stdout, stderr, installed } = runCsiInstallRewrite(await master(), manifest);
    expect(status).toBe(1);
    expect(stderr).toContain(
      `FATAL: the CSI manifest has no image ${missing} to move onto its mirror`,
    );
    expect(stderr).toContain('re-derive CSI_SIDECAR_MIRRORS');
    // exit, not return: the install does not go on to apply anything.
    expect(stdout).not.toContain('returned');
    expect(stdout).not.toContain('continued');
    expect(installed).toBeNull();
  });

  it('stops the install when the manifest still names an image on a registry it rewrites away from', async () => {
    const extra = 'registry.k8s.io/sig-storage/csi-health-monitor:v1.0.0';
    const manifest = csiManifest(
      withWorkload(NODE, (c) => {
        c['csi-health-monitor'] = extra;
      }),
    );
    const { status, stderr, installed } = runCsiInstallRewrite(await master(), manifest);
    expect(status).toBe(1);
    expect(stderr).toContain(`FATAL: the CSI manifest still pulls ${extra} from registry.k8s.io`);
    expect(installed).toBeNull();
  });

  it('rewrites only a whole value: a longer ref that starts with one is left alone', async () => {
    // alpine:3 is rewritten; alpine:3.20 is another image, on no registry we
    // move away from, so it passes through as upstream wrote it.
    const manifest = csiManifest(
      withWorkload(NODE, (c) => {
        c['other-init'] = 'alpine:3.20';
      }),
    );
    const { status, stderr, installed } = runCsiInstallRewrite(await master(), manifest);
    expect(status, stderr).toBe(0);
    const images = imagesByContainer(installed as string);
    expect(images[`${NODE} other-init`]).toBe('alpine:3.20');
    expect(images[`${NODE} automount-udev-deleter`]).toBe(mirrorOf('alpine:3'));
  });

  it('keeps a double-quoted value quoted and a trailing comment in place', async () => {
    const from = UPSTREAM[CONTROLLER]['csi-provisioner'];
    const manifest = csiManifest(UPSTREAM).replace(
      `image: ${from}\n`,
      `image: "${from}" # pinned upstream\n`,
    );
    expect(manifest).toContain(`"${from}" # pinned upstream`);
    const { status, stderr, installed } = runCsiInstallRewrite(await master(), manifest);
    expect(status, stderr).toBe(0);
    expect(installed).toContain(`image: "${mirrorOf(from)}" # pinned upstream\n`);
    expect(installed).not.toContain(from);
  });

  it('returns 1 to the retry loop when the download fails, and writes nothing', async () => {
    const { status, stdout, installed } = runCsiInstallRewrite(
      await master(),
      csiManifest(UPSTREAM),
      { downloadFails: true },
    );
    expect(status).toBe(0);
    expect(stdout).toContain('CSI manifest download failed: https://example.invalid/csi.yaml');
    expect(stdout).toContain('returned 1');
    expect(stdout).toContain('continued');
    expect(installed).toBeNull();
  });

  it('refuses an empty rewrite list rather than apply upstream’s images', () => {
    // Every static renders a list (csiImageRewriteVars throws for none), so
    // this is the node's own guard against a render that lost it.
    const rendered = renderScript(loadCloudInit('do-master-init.sh'), {
      ...VARS,
      csi_image_rewrites: '',
    });
    const { status, stderr, installed } = runCsiInstallRewrite(rendered, csiManifest(UPSTREAM));
    expect(status).toBe(1);
    expect(stderr).toContain('FATAL: no CSI image rewrites were rendered into this script');
    expect(installed).toBeNull();
  });

  it('csiImageRewriteVars refuses a provider with no CSI rewrites', () => {
    expect(() => csiImageRewriteVars('some-future-provider')).toThrow(
      /provider "some-future-provider" has no CSI image rewrites/,
    );
  });
});
