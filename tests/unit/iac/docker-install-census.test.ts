/**
 * One Docker, everywhere. Every compose server (all five providers) boots plain
 * Ubuntu 24.04 and installs the latest Docker through
 * src/lib/iac/docker-install.js, with no version pinned. Why one install: image
 * delivery runs `docker save --platform` on the server, which needs Docker 28+,
 * and Hetzner's prebuilt `docker-ce` app image shipped 27.5.1 (2026-11-04
 * Hetzner e2e: `unknown flag: --platform`). Why no pin: a Docker security fix
 * has to reach a new server without a CLI release.
 *
 * (a) no file spells its own Docker install; (b) each provider's rendered
 * compose user data installs every Docker package, unpinned, through the real
 * renderer; (c) no provider's COMPOSE_IMAGE is a prebuilt Docker image.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { DOCKER_PACKAGES } from '../../../src/lib/iac/docker-install.js';
import { loadDoComposeUserData } from '../../../src/lib/iac/programs/digitalocean-compose.js';
import { loadHetznerComposeUserData } from '../../../src/lib/iac/programs/hetzner-compose.js';
import { loadLinodeComposeUserData } from '../../../src/lib/iac/programs/linode-compose.js';
import { loadScalewayComposeUserData } from '../../../src/lib/iac/programs/scaleway-compose.js';
import { loadVultrComposeUserData } from '../../../src/lib/iac/programs/vultr-compose.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// The only file allowed to spell a Docker install.
const INSTALL_MODULE = 'src/lib/iac/docker-install.js';

// The k8s node scripts install Ubuntu's own `docker.io` package (the master
// builds and sideloads images with it), not Docker's apt repo: they never
// match the patterns below, and are listed so a future edit that moves them to
// Docker's repo is a conscious decision, not a drift.
const K8S_SCRIPTS_ALLOWED_TO_DIFFER =
  'carbon/cloud-init/k3s/*.sh install Ubuntu docker.io (k8s tier, out of scope)';

describe('(a) no compose program or provider spells its own Docker install', () => {
  const files = [
    ...walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js')),
    ...walk(join(ROOT, 'carbon', 'cloud-init')).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.sh'),
    ),
  ].map((f) => relative(ROOT, f));

  const spellsInstall = (text: string) =>
    /\bdownload\.docker\.com\b/.test(text) ||
    /apt-get\b[^\n]*\binstall\b[^\n]*\bdocker-ce\b/.test(text);

  it('only the shared module contains download.docker.com or `apt-get ... install ... docker-ce`', () => {
    const offenders = files.filter(
      (rel) => rel !== INSTALL_MODULE && spellsInstall(readFileSync(join(ROOT, rel), 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the shared module does spell it (the scan can find an install)', () => {
    expect(spellsInstall(readFileSync(join(ROOT, INSTALL_MODULE), 'utf-8'))).toBe(true);
  });

  it('the k8s scripts never install docker-ce (they run no docker install at all)', () => {
    const k3s = files.filter((f) => f.startsWith('carbon/cloud-init/k3s/') && f.endsWith('.sh'));
    expect(k3s.length, K8S_SCRIPTS_ALLOWED_TO_DIFFER).toBeGreaterThan(0);
    for (const rel of k3s) {
      expect(readFileSync(join(ROOT, rel), 'utf-8'), rel).not.toMatch(/\bdocker-ce\b(?!-setup)/);
    }
  });
});

const RENDERERS: Record<string, () => string> = {
  hetzner: loadHetznerComposeUserData,
  digitalocean: loadDoComposeUserData,
  linode: loadLinodeComposeUserData,
  vultr: loadVultrComposeUserData,
  scaleway: loadScalewayComposeUserData,
};

describe.each(Object.entries(RENDERERS))('(b) %s rendered compose user data', (_p, render) => {
  const text = render();
  const parsed = loadYaml(text.replace(/^#cloud-config\n/, '')) as { runcmd: unknown[] };
  const steps = parsed.runcmd.filter((s): s is string[] => Array.isArray(s));
  const installs = steps.filter((s) =>
    /apt-get\b.*\binstall\b.*\bdocker-ce/.test(String(s.at(-1))),
  );

  it('installs every Docker package once, with no version pinned', () => {
    expect(installs).toHaveLength(1);
    const words = String(installs[0].at(-1)).split(/\s+/);
    for (const name of DOCKER_PACKAGES) expect(words, name).toContain(name);
    // A version here is a pin: a security fix would wait on a CLI release.
    expect(words.filter((w) => /^(docker|containerd)\S*=/.test(w))).toEqual([]);
    expect(text).not.toMatch(/apt-mark\s+hold|Pin-Priority/);
  });

  it("refreshes only Docker's source, with no package_update and ASCII under the 32 KiB cap", () => {
    expect(text).not.toMatch(/^package_update:\s*true/m);
    const updates = steps.map((s) => String(s.at(-1))).filter((c) => /\bupdate -qq\b/.test(c));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list');
    expect(updates[0]).toContain('-o Dir::Etc::sourceparts=-');
    expect(updates[0]).toContain('#clear APT::Update::Post-Invoke-Success;');
    expect(updates[0]).toContain('apt-get -c /run/vibecarbon-boot.conf ');
    expect(updates[0]).not.toContain('apt.conf.d');
    expect(Buffer.byteLength(text)).toBeLessThan(32 * 1024);
    expect([...text].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
  });

  it('runs the install before the shared file enables docker', () => {
    const install = steps.indexOf(installs[0]);
    const enable = steps.findIndex((s) => s.join(',') === 'systemctl,enable,--now,docker');
    expect(enable).toBeGreaterThan(install);
  });
});

describe('wireguard-tools install refreshes with the quiet trimmed update', () => {
  it('uses aptQuietUpdate(APT_TRIMMED_INDEXES), not a plain update', () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/wireguard.js'), 'utf-8');
    expect(src).toContain('aptQuietUpdate(APT_TRIMMED_INDEXES)');
    expect(src).not.toContain("aptGet('update -qq')");
  });
});

describe('(c) no compose COMPOSE_IMAGE is a prebuilt Docker image', () => {
  const IMAGES: Record<string, string> = {
    hetzner: HetznerProvider.COMPOSE_IMAGE,
    digitalocean: DigitalOceanProvider.COMPOSE_IMAGE,
    linode: LinodeProvider.COMPOSE_IMAGE,
    vultr: VultrProvider.COMPOSE_IMAGE,
    scaleway: ScalewayProvider.COMPOSE_IMAGE,
  };

  it.each(Object.entries(IMAGES))('%s boots a plain OS image', (_p, image) => {
    expect(image).toBeTruthy();
    expect(image).not.toMatch(/docker/i);
  });

  it('no compose program names a Docker image either', () => {
    for (const p of ['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway']) {
      const src = readFileSync(join(ROOT, 'src/lib/iac/programs', `${p}-compose.js`), 'utf-8');
      for (const m of src.matchAll(/^\s*image(?:Id)?:\s*(['"`][^'"`\n]*['"`])/gm)) {
        expect(m[1], `${p}-compose.js`).not.toMatch(/docker/i);
      }
    }
  });
});
