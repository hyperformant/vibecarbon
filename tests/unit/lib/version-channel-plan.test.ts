/**
 * The job's planning step, on fake upstreams: what moves, what stays, and what
 * it asks the mirror job to copy. Nothing here reaches a registry.
 * `scripts/version-channel.mjs` is exercised through its exported functions,
 * and through its own `write` command for the last check before a publish.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  driverPinsIn,
  k3sCandidates,
  k8sMinorOfGoMod,
  parseK3sImages,
  pickImage,
  planChannel,
  systemImagesProblem,
} from '../../../scripts/version-channel.mjs';
import {
  bundledImageSet,
  CHANNEL_IMAGES,
  K3S_SYSTEM_IMAGE_MIRRORS,
  K3S_VERSION,
} from '../../../src/lib/images.js';
import { CHANNEL_SCHEMA, parseChannelFile, versionOf } from '../../../src/lib/version-channel.js';

const bundled = bundledImageSet();
const published = () => ({ schema: CHANNEL_SCHEMA, ...bundled });
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const [, K3S_MINOR] = K3S_VERSION.match(/^v1\.(\d+)\./) as RegExpMatchArray;
const MINOR = Number(K3S_MINOR);

const IMAGES_TXT = K3S_SYSTEM_IMAGE_MIRRORS.map((i) => `docker.io/${i.repo}:${i.tag}`)
  .concat(['docker.io/rancher/klipper-lb:v0.4.13', 'docker.io/rancher/klipper-helm:v0.9.1'])
  .join('\n');

type Image = { repo: string; tag?: string };

/** An upstream with nothing new, for a test to override one lookup of. */
function upstream(overrides: Record<string, unknown> = {}) {
  return {
    tags: async (image: Image) => [image.tag as string, 'latest', '9.9.9-rc1'],
    manifest: async (_image: Image, tag: string) => ({
      digest: digest('a'),
      index: digest(tag.replace(/\D/g, '').slice(-1) || 'b'),
    }),
    k3sChannels: async () => ({ stable: K3S_VERSION, [`v1.${MINOR}`]: K3S_VERSION }),
    k3sImages: async () => IMAGES_TXT,
    ...overrides,
  };
}

const drivers = (minor = MINOR) => [{ repo: 'x/ccm', tag: 'v1', minor }];

/** Tags of `tags` for one repo, the rest as bundled. */
const tagsFor = (repo: string, ...more: string[]) =>
  async function tags(image: Image) {
    return image.repo === repo ? [image.tag as string, ...more] : [image.tag as string];
  };

describe('pickImage', () => {
  it('takes the newest patch or minor', () => {
    expect(pickImage('v3.7.17', ['v3.7.17', 'v3.7.18', 'v3.8.0'])).toEqual({
      next: 'v3.8.0',
      major: null,
    });
  });

  it('leaves a new major and names it', () => {
    expect(pickImage('v3.7.17', ['v3.7.17', 'v4.0.0', 'v4.1.0'])).toEqual({
      next: null,
      major: 'v4.1.0',
    });
  });

  it('moves the patch and still names the major', () => {
    expect(pickImage('1.8.1.3', ['1.8.1.4', '2.0.0.0'])).toEqual({
      next: '1.8.1.4',
      major: '2.0.0.0',
    });
  });

  it.each([
    ['a prerelease', 'v3.8.0-rc1'],
    ['a suffix', 'v3.8.0-alpine'],
    ['another shape', 'v3.8'],
    ['no prefix', '3.8.0'],
    ['a name', 'latest'],
    ['shell text', 'v3.8.0;reboot'],
  ])('ignores %s', (_what, tag) => {
    expect(pickImage('v3.7.17', [tag])).toEqual({ next: null, major: null });
  });

  it('never goes back', () => {
    expect(pickImage('v3.7.17', ['v3.7.16', 'v2.0.0'])).toEqual({ next: null, major: null });
  });
});

describe('the driver support oracle', () => {
  it.each([
    ['a require', 'require (\n\tk8s.io/client-go v0.37.1\n)', 37],
    ['a single require', 'require k8s.io/api v0.36.2\n', 36],
    ['a replace over an old require', 'k8s.io/api v0.34.1\nk8s.io/api => k8s.io/api v0.37.0\n', 37],
    ['the kubernetes module', 'k8s.io/kubernetes v1.37.0\n', 37],
    ['mount-utils alone', 'k8s.io/mount-utils v0.37.1\n', 37],
  ])('reads %s', (_what, goMod, minor) => {
    expect(k8sMinorOfGoMod(goMod)).toBe(minor);
  });

  it('ignores modules that do not follow Kubernetes', () => {
    const goMod = 'k8s.io/utils v0.99.0\nk8s.io/klog/v2 v2.130.1\nk8s.io/api v0.36.0\n';
    expect(k8sMinorOfGoMod(goMod)).toBe(36);
  });

  it('refuses a go.mod that says nothing', () => {
    expect(() => k8sMinorOfGoMod('module x\n')).toThrow(/no Kubernetes module/);
  });

  it('finds every driver the cloud-init scripts install, with the tag they install', () => {
    const scripts = ['master-init.sh', 'do-master-init.sh', 'linode-master-init.sh'].map((f) =>
      readFileSync(join('carbon/cloud-init/k3s', f), 'utf8'),
    );
    expect(
      driverPinsIn(scripts)
        .map((d: { repo: string }) => d.repo)
        .sort(),
    ).toEqual([
      'digitalocean/csi-digitalocean',
      'digitalocean/digitalocean-cloud-controller-manager',
      'hetznercloud/csi-driver',
      'hetznercloud/hcloud-cloud-controller-manager',
      'linode/linode-blockstorage-csi-driver',
    ]);
    expect(driverPinsIn(scripts).every((d: { tag: string }) => /^v\d/.test(d.tag))).toBe(true);
  });
});

describe('k3s-images.txt', () => {
  it('parses a repo and tag per line', () => {
    expect(parseK3sImages('docker.io/rancher/mirrored-pause:3.10.2\n\n')).toEqual([
      { repo: 'rancher/mirrored-pause', tag: '3.10.2' },
    ]);
  });

  it('a set whose system images we mirror has no problem', () => {
    expect(systemImagesProblem(parseK3sImages(IMAGES_TXT))).toBeNull();
  });

  it('a new system image stops the set: nothing would serve it', () => {
    const images = parseK3sImages(`${IMAGES_TXT}\ndocker.io/rancher/mirrored-new:1.0.0`);
    expect(systemImagesProblem(images)).toContain('rancher/mirrored-new');
  });

  it('losing one we rely on stops the set too', () => {
    const images = parseK3sImages(IMAGES_TXT).filter(
      (i: { repo: string }) => i.repo !== 'rancher/mirrored-pause',
    );
    expect(systemImagesProblem(images)).toContain('rancher/mirrored-pause');
  });
});

describe('k3sCandidates', () => {
  it('stable first, then each minor down to the current one, then the current', () => {
    expect(
      k3sCandidates('v1.36.1+k3s1', {
        stable: 'v1.38.2+k3s1',
        'v1.38': 'v1.38.2+k3s1',
        'v1.37': 'v1.37.9+k3s2',
        'v1.36': 'v1.36.5+k3s1',
        'v1.35': 'v1.35.9+k3s1',
      }),
    ).toEqual(['v1.38.2+k3s1', 'v1.37.9+k3s2', 'v1.36.5+k3s1', 'v1.36.1+k3s1']);
  });

  it("does not run ahead of stable on stable's own minor", () => {
    expect(
      k3sCandidates('v1.37.2+k3s1', { stable: 'v1.37.2+k3s1', 'v1.37': 'v1.37.3+k3s1' }),
    ).toEqual(['v1.37.2+k3s1']);
  });

  it('skips anything older than the current, or on another major', () => {
    expect(k3sCandidates('v1.37.2+k3s1', { stable: 'v1.37.1+k3s1' })).toEqual(['v1.37.2+k3s1']);
    expect(k3sCandidates('v1.37.2+k3s1', { stable: 'v2.0.0+k3s1' })).toEqual(['v1.37.2+k3s1']);
  });

  it('skips a prerelease and a name that is not a release', () => {
    expect(
      k3sCandidates('v1.37.2+k3s1', { stable: 'v1.38.0-rc1+k3s1', 'v1.37': 'nonsense' }),
    ).toEqual(['v1.37.2+k3s1']);
  });
});

describe('planChannel', () => {
  const plan = (over = {}, driverList = drivers(), file: unknown = published()) =>
    planChannel({ published: file, upstream: upstream(over), drivers: driverList });

  it('nothing new is no change', async () => {
    const out = await plan();
    expect(out.changed).toBe(false);
    expect(out.file).toEqual(published());
    expect(out.include).toEqual([]);
    expect(out.majors).toEqual([]);
  });

  it('a patch moves that one ref and mirrors it, and the result passes the CLI validator', async () => {
    const out = await plan({ tags: tagsFor('library/traefik', 'v3.7.99') });
    expect(out.changed).toBe(true);
    expect(out.file.images.traefik).toBe(`ghcr.io/hyperformant/traefik:v3.7.99@${digest('a')}`);
    expect(out.file.images.socat).toBe(bundled.images.socat);
    expect(out.include).toEqual([
      {
        src: 'docker.io/library/traefik:v3.7.99',
        dst: 'ghcr.io/hyperformant/traefik:v3.7.99',
        digest: digest('a'),
        index: expect.stringMatching(/^sha256:/),
      },
    ]);
    expect(() => parseChannelFile(out.file, bundled)).not.toThrow();
    expect(out.refs).toContain(out.file.images.traefik);
  });

  it('a new major leaves the list alone and is reported', async () => {
    const out = await plan({ tags: tagsFor('library/traefik', 'v4.0.0') });
    expect(out.changed).toBe(false);
    expect(out.majors).toEqual([{ name: 'library/traefik', current: 'v3.7.17', newest: 'v4.0.0' }]);
  });

  it('a whole Kubernetes set moves when every part of it is there', async () => {
    const next = `v1.${MINOR + 1}.0+k3s1`;
    const out = await plan(
      {
        k3sChannels: async () => ({ stable: next }),
        tags: async (image: Image) =>
          ({
            'autoscaling/cluster-autoscaler': [`v1.${MINOR + 1}.2`],
            'alpine/k8s': [`1.${MINOR + 1}.0`],
          })[image.repo] ?? [image.tag as string],
      },
      drivers(MINOR + 1),
    );
    expect(out.file.kubernetes.k3s).toBe(next);
    expect(versionOf(out.file.kubernetes.clusterAutoscaler)).toBe(`v1.${MINOR + 1}.2`);
    expect(versionOf(out.file.kubernetes.kubectl)).toBe(`1.${MINOR + 1}.0`);
    // System images are copied before the list names that k3s, and pulled by
    // tag, the way k3s asks for them.
    for (const image of K3S_SYSTEM_IMAGE_MIRRORS) {
      const name = image.repo.split('/').pop();
      expect(out.include.map((e: { dst: string }) => e.dst)).toContain(
        `ghcr.io/hyperformant/${name}:${image.tag}`,
      );
      expect(out.refs).toContain(`ghcr.io/hyperformant/${name}:${image.tag}`);
    }
  });

  it.each([
    [
      'cluster-autoscaler has no matching minor',
      { 'alpine/k8s': [`1.${MINOR + 1}.0`] },
      drivers(MINOR + 1),
      IMAGES_TXT,
    ],
    ['kubectl has no matching minor', {}, drivers(MINOR + 1), IMAGES_TXT],
    [
      'a driver is behind',
      {
        'autoscaling/cluster-autoscaler': [`v1.${MINOR + 1}.0`],
        'alpine/k8s': [`1.${MINOR + 1}.0`],
      },
      [...drivers(MINOR + 1), { repo: 'x/csi', tag: 'v2', minor: MINOR }],
      IMAGES_TXT,
    ],
    [
      'k3s needs a system image we do not mirror',
      {
        'autoscaling/cluster-autoscaler': [`v1.${MINOR + 1}.0`],
        'alpine/k8s': [`1.${MINOR + 1}.0`],
      },
      drivers(MINOR + 1),
      `${IMAGES_TXT}\ndocker.io/rancher/mirrored-new:1.0.0`,
    ],
  ])('the set stays when %s', async (_what, tags, driverList, imagesTxt) => {
    const next = `v1.${MINOR + 1}.0+k3s1`;
    const out = await plan(
      {
        k3sChannels: async () => ({ stable: next }),
        k3sImages: async (version: string) => (version === next ? imagesTxt : IMAGES_TXT),
        tags: async (image: Image) =>
          (tags as Record<string, string[]>)[image.repo] ?? [image.tag as string],
      },
      driverList,
    );
    expect(out.file.kubernetes).toEqual(bundled.kubernetes);
    expect(out.changed).toBe(false);
    expect(out.notes.join('\n')).toContain(next);
  });

  it('the newest complete set wins when stable is not complete', async () => {
    const stable = `v1.${MINOR + 1}.0+k3s1`;
    const patch = `v1.${MINOR}.99+k3s1`;
    const out = await plan({
      k3sChannels: async () => ({ stable, [`v1.${MINOR}`]: patch }),
    });
    expect(out.file.kubernetes.k3s).toBe(patch);
    expect(out.changed).toBe(true);
    expect(out.include.length).toBeGreaterThan(0);
  });

  it('a k3s patch with nothing else new still gives the mirror job work', async () => {
    const out = await plan({
      k3sChannels: async () => ({ stable: `v1.${MINOR}.99+k3s1` }),
    });
    expect(out.include.length).toBe(K3S_SYSTEM_IMAGE_MIRRORS.length);
  });

  it('a CLI that bundles newer than the list moves the list up to it', async () => {
    const stale = published();
    stale.images = {
      ...stale.images,
      traefik: `ghcr.io/hyperformant/traefik:v3.0.0@${digest('c')}`,
    };
    const out = await plan({}, drivers(), stale);
    expect(out.file.images.traefik).toBe(bundled.images.traefik);
    expect(out.changed).toBe(true);
    expect(out.include.map((e: { dst: string }) => e.dst)).toContain(
      `ghcr.io/hyperformant/traefik:${CHANNEL_IMAGES.traefik.tag}`,
    );
  });

  it('keeps a list that is ahead of the bundled copy', async () => {
    const ahead = published();
    ahead.images = {
      ...ahead.images,
      traefik: `ghcr.io/hyperformant/traefik:v3.8.0@${digest('c')}`,
    };
    const out = await plan({}, drivers(), ahead);
    expect(out.file.images.traefik).toBe(ahead.images.traefik);
    expect(out.changed).toBe(false);
  });

  it('a published list that fails validation stops the job, loudly', async () => {
    const tampered = published();
    tampered.images = { ...tampered.images, traefik: 'ghcr.io/evil/traefik:v9@sha256:x' };
    await expect(plan({}, drivers(), tampered)).rejects.toThrow(/images\.traefik/);
  });

  it.each([
    ['a short digest', { digest: 'sha256:abc', index: digest('b') }],
    ['text in the digest', { digest: `sha256:${'a'.repeat(63)}\nx`, index: digest('b') }],
  ])('%s from upstream fails the validator before it can reach a list', async (_what, answer) => {
    await expect(
      plan({ tags: tagsFor('library/traefik', 'v3.7.99'), manifest: async () => answer }),
    ).rejects.toThrow(/images\.traefik/);
  });

  it('an upstream that answers with no amd64 stops the job, naming the image', async () => {
    await expect(
      plan({
        tags: tagsFor('library/traefik', 'v3.7.99'),
        manifest: async () => {
          throw new Error('no linux/amd64 in library/traefik:v3.7.99');
        },
      }),
    ).rejects.toThrow(/library\/traefik:v3\.7\.99/);
  });
});

describe('the write command, the last check before a publish', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-channel-write-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (channel: string) => {
    const path = join(dir, 'channel.json');
    return {
      path,
      run: spawnSync('node', ['scripts/version-channel.mjs', 'write', path], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', CHANNEL: channel },
      }),
    };
  };

  it('writes a file the CLI accepts, stable across runs', () => {
    const { path, run } = write(JSON.stringify(published()));
    expect(run.status, run.stderr).toBe(0);
    const text = readFileSync(path, 'utf8');
    expect(parseChannelFile(JSON.parse(text), bundled)).toEqual(bundled);
    expect(text.endsWith('}\n')).toBe(true);
    write(JSON.stringify(published()));
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it.each([
    ['not JSON', 'nonsense'],
    ['a foreign ref', JSON.stringify({ ...published(), images: { traefik: 'evil' } })],
  ])('refuses %s and leaves the file alone', (_what, channel) => {
    const before = readFileSync(join(dir, 'channel.json'), 'utf8');
    const { path, run } = write(channel);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
