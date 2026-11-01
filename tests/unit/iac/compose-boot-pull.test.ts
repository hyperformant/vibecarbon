import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_PULL_PLACEHOLDER,
  bootPullImages,
  loadComposeCloudInit,
} from '../../../src/lib/iac/compose-cloud-init.js';
import { loadDoComposeUserData } from '../../../src/lib/iac/programs/digitalocean-compose.js';
import { loadLinodeComposeUserData } from '../../../src/lib/iac/programs/linode-compose.js';
import { loadScalewayComposeUserData } from '../../../src/lib/iac/programs/scaleway-compose.js';
import { loadVultrComposeUserData } from '../../../src/lib/iac/programs/vultr-compose.js';
import { dbImageRef } from '../../../src/lib/images.js';

/**
 * The boot image pull: every compose server (all five providers) starts
 * pulling the pinned core images while the rest of boot runs, so the deploy's
 * own `compose pull --policy missing` finds them present. It must start only
 * after cloud-init's Docker restart (a pull in flight dies with the daemon),
 * never hold the ready marker, and pull exactly the refs the compose files use.
 */
const REPO = join(import.meta.dirname, '..', '..', '..');

const RENDERED: Record<string, string> = {
  hetzner: loadComposeCloudInit(),
  digitalocean: loadDoComposeUserData(),
  linode: loadLinodeComposeUserData(),
  vultr: loadVultrComposeUserData(),
  scaleway: loadScalewayComposeUserData(),
};

describe('boot pull refs', () => {
  it('are the db image and the traefik and docker-socket-proxy mirrors the compose files run', () => {
    const prod = readFileSync(join(REPO, 'carbon', 'docker-compose.prod.yml'), 'utf8');
    const [db, traefik, proxy] = bootPullImages();
    expect(db).toBe(dbImageRef());
    expect(prod).toContain(`image: ${traefik}`);
    expect(prod).toContain(`image: ${proxy}`);
    expect(traefik).toMatch(/^ghcr\.io\/hyperformant\/traefik:.*@sha256:/);
    expect(proxy).toMatch(/^ghcr\.io\/hyperformant\/docker-socket-proxy:.*@sha256:/);
  });
});

describe.each(Object.entries(RENDERED))('%s compose cloud-init', (_provider, text) => {
  const runcmd = text.slice(text.indexOf('\nruncmd:\n'));
  const at = (needle: string) => {
    const i = runcmd.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('fills the image list (no placeholder left)', () => {
    expect(text).not.toContain(BOOT_PULL_PLACEHOLDER);
    for (const ref of bootPullImages()) expect(text).toContain(ref);
  });

  it('starts the pull after the Docker restart and before the slow steps, detached', () => {
    const restart = at('[systemctl, restart, docker]');
    const pull = at('boot-pull.sh > /dev/null 2>&1 < /dev/null &');
    expect(runcmd).toMatch(/setsid nohup \/usr\/local\/lib\/vibecarbon\/boot-pull\.sh/);
    expect(restart).toBeLessThan(pull);
    expect(pull).toBeLessThan(at('install -y ufw unattended-upgrades'));
    expect(pull).toBeLessThan(at('/var/lib/vibecarbon/ready'));
    // Nothing restarts or stops Docker once the pull is going.
    expect(runcmd.slice(pull)).not.toMatch(/restart,? docker|docker restart|stop,? docker/);
  });

  it('a provider-installed Docker comes before the restart', () => {
    const install = runcmd.indexOf('install -y docker-ce');
    if (install > -1) expect(install).toBeLessThan(at('[systemctl, restart, docker]'));
  });
});

/** The boot-pull.sh body as written to disk, from the write_files block. */
function bootPullScript(): string {
  const text = RENDERED.hetzner;
  const start = text.indexOf('    content: |\n', text.indexOf('boot-pull.sh'));
  const body = text.slice(start + '    content: |\n'.length);
  const lines = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('      ') && line.trim() !== '') break;
    lines.push(line.slice(6));
  }
  return lines.join('\n');
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runBootPull(failRef = '') {
  const dir = mkdtempSync(join(tmpdir(), 'vc-boot-pull-'));
  dirs.push(dir);
  const script = bootPullScript().replace('out=/var/lib/vibecarbon/boot-pull', `out=${dir}/out`);
  writeFileSync(join(dir, 'boot-pull.sh'), script);
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\n[ "$3" = "${failRef}" ] && { echo "denied: $3"; exit 1; }\nexit 0\n`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const r = spawnSync('sh', [join(dir, 'boot-pull.sh')], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  return {
    r,
    status: readFileSync(join(dir, 'out', 'status'), 'utf8').trim(),
    calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').sort(),
  };
}

describe('boot-pull.sh', () => {
  it('pulls each core image once and records ok', () => {
    const { r, status, calls } = runBootPull();
    expect(r.status).toBe(0);
    expect(status).toBe('ok');
    expect(calls).toEqual(
      bootPullImages()
        .map((ref) => `pull -q ${ref}`)
        .sort(),
    );
  });

  it('a failed pull is recorded, not retried (the deploy pull does the work)', () => {
    const [, traefik] = bootPullImages();
    const { status, calls } = runBootPull(traefik);
    expect(status).toMatch(/^failed: 1 image\(s\), /);
    expect(calls.filter((c) => c.includes(traefik))).toHaveLength(1);
  });
});
