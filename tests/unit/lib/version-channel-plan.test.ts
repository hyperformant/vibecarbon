/**
 * The job's planning step, on fake upstreams: what moves, what stays, and what
 * it asks the mirror job to copy. Nothing here reaches a registry.
 * `scripts/version-channel.mjs` is exercised through its exported functions,
 * and through its own `write` command for the last check before a publish.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  driverPinsIn,
  k3sAhead,
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
  TRAEFIK_MIRROR,
} from '../../../src/lib/images.js';
import { CHANNEL_SCHEMA, parseChannelFile, versionOf } from '../../../src/lib/version-channel.js';
import { createTempDir } from '../../_shared/temp-dir.js';

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

/** `version` one up at part `at` (0 major, 1 minor, 2 patch), later parts zeroed. */
const bump = (version: string, at: number) => {
  let i = -1;
  return version.replace(/\d+/g, (d) => {
    i += 1;
    if (i < at) return d;
    return i === at ? String(Number(d) + 1) : '0';
  });
};
const TRAEFIK_PATCH = bump(TRAEFIK_MIRROR.tag, 2);
const TRAEFIK_MINOR = bump(TRAEFIK_MIRROR.tag, 1);

/** Tags of `tags` for one repo, the rest as bundled. */
const tagsFor = (repo: string, ...more: string[]) =>
  async function tags(image: Image) {
    return image.repo === repo ? [image.tag as string, ...more] : [image.tag as string];
  };

describe('pickImage', () => {
  it('takes the newest patch, and leaves a new minor for a CLI release, named', () => {
    expect(pickImage('v3.7.17', ['v3.7.17', 'v3.7.18', 'v3.8.0', 'v3.9.1'])).toEqual({
      next: 'v3.7.18',
      minor: 'v3.9.1',
      major: null,
    });
  });

  it('leaves a new major and names it', () => {
    expect(pickImage('v3.7.17', ['v3.7.17', 'v4.0.0', 'v4.1.0'])).toEqual({
      next: null,
      minor: null,
      major: 'v4.1.0',
    });
  });

  it('moves the patch and still names the major', () => {
    expect(pickImage('1.8.1.3', ['1.8.1.4', '2.0.0.0'])).toEqual({
      next: '1.8.1.4',
      minor: null,
      major: '2.0.0.0',
    });
  });

  it('counts every part past the minor as patch', () => {
    expect(pickImage('1.8.1.3', ['1.8.1.4', '1.8.2.0', '1.9.0.0'])).toEqual({
      next: '1.8.2.0',
      minor: '1.9.0.0',
      major: null,
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
    expect(pickImage('v3.7.17', [tag])).toEqual({ next: null, minor: null, major: null });
  });

  it('never goes back', () => {
    expect(pickImage('v3.7.17', ['v3.7.16', 'v3.6.99', 'v2.0.0'])).toEqual({
      next: null,
      minor: null,
      major: null,
    });
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
  const channels = {
    stable: 'v1.38.2+k3s1',
    'v1.38': 'v1.38.2+k3s1',
    'v1.37': 'v1.37.9+k3s2',
    'v1.36': 'v1.36.5+k3s1',
    'v1.35': 'v1.35.9+k3s1',
  };

  it('only the current minor: its own channel when stable is past it, then the current', () => {
    expect(k3sCandidates('v1.36.1+k3s1', channels)).toEqual(['v1.36.5+k3s1', 'v1.36.1+k3s1']);
  });

  it('stable when stable is on the current minor', () => {
    expect(
      k3sCandidates('v1.37.2+k3s1', { stable: 'v1.37.4+k3s2', 'v1.37': 'v1.37.4+k3s2' }),
    ).toEqual(['v1.37.4+k3s2', 'v1.37.2+k3s1']);
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

describe('k3sAhead', () => {
  it.each([
    ['a newer minor in stable', { stable: 'v1.38.2+k3s1' }, 'v1.38.2+k3s1'],
    ['a new major in stable', { stable: 'v2.0.0+k3s1' }, 'v2.0.0+k3s1'],
    ['a patch of this minor', { stable: 'v1.37.9+k3s1' }, null],
    ['an older stable', { stable: 'v1.36.9+k3s1' }, null],
    ['a prerelease', { stable: 'v1.38.0-rc1+k3s1' }, null],
    ['no stable', {}, null],
  ])('%s', (_what, channels, ahead) => {
    expect(k3sAhead('v1.37.2+k3s1', channels)).toBe(ahead);
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
    expect(out.waiting).toEqual([]);
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
    expect(parseChannelFile(out.file, bundled).ahead).toEqual([]);
    expect(out.refs).toContain(out.file.images.traefik);
  });

  it('a new major leaves the list alone and is reported', async () => {
    const out = await plan({ tags: tagsFor('library/traefik', 'v4.0.0') });
    expect(out.changed).toBe(false);
    expect(out.waiting).toEqual([
      { name: 'library/traefik', current: TRAEFIK_MIRROR.tag, newest: 'v4.0.0' },
    ]);
  });

  it('a new minor leaves the list alone too: it waits for a CLI release, reported', async () => {
    const out = await plan({ tags: tagsFor('library/traefik', TRAEFIK_MINOR) });
    expect(out.changed).toBe(false);
    expect(out.file.images.traefik).toBe(bundled.images.traefik);
    expect(out.waiting).toEqual([
      { name: 'library/traefik', current: TRAEFIK_MIRROR.tag, newest: TRAEFIK_MINOR },
    ]);
  });

  it('a patch and a minor upstream: the patch moves, the minor waits', async () => {
    const out = await plan({ tags: tagsFor('library/traefik', TRAEFIK_PATCH, TRAEFIK_MINOR) });
    expect(versionOf(out.file.images.traefik)).toBe(TRAEFIK_PATCH);
    expect(out.waiting.map((w: { newest: string }) => w.newest)).toEqual([TRAEFIK_MINOR]);
  });

  /** Upstream with a Kubernetes patch: k3s, cluster-autoscaler and kubectl. */
  const kubernetesPatch = (extra: Record<string, string[]> = {}) => {
    const k3s = `v1.${MINOR}.99+k3s1`;
    const autoscaler = bump(versionOf(bundled.kubernetes.clusterAutoscaler), 2);
    const kubectl = bump(versionOf(bundled.kubernetes.kubectl), 2);
    const lists: Record<string, string[]> = {
      'autoscaling/cluster-autoscaler': [autoscaler],
      'alpine/k8s': [kubectl],
    };
    return {
      k3s,
      autoscaler,
      kubectl,
      over: {
        k3sChannels: async () => ({ stable: k3s }),
        tags: async (image: Image) => [
          image.tag as string,
          ...(lists[image.repo] ?? []),
          ...(extra[image.repo] ?? []),
        ],
      },
    };
  };

  it('a whole Kubernetes patch moves when every part of it is there', async () => {
    const { k3s, autoscaler, kubectl, over } = kubernetesPatch();
    const out = await plan(over);
    expect(out.file.kubernetes.k3s).toBe(k3s);
    expect(versionOf(out.file.kubernetes.clusterAutoscaler)).toBe(autoscaler);
    expect(versionOf(out.file.kubernetes.kubectl)).toBe(kubectl);
    expect(parseChannelFile(out.file, bundled).ahead).toEqual([]);
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

  it('a Kubernetes image takes the patch of its own minor, never the next minor', async () => {
    const { autoscaler, kubectl, over } = kubernetesPatch({
      'autoscaling/cluster-autoscaler': [`v1.${MINOR + 1}.2`],
      'alpine/k8s': [`1.${MINOR + 1}.0`],
    });
    const out = await plan(over);
    expect(versionOf(out.file.kubernetes.clusterAutoscaler)).toBe(autoscaler);
    expect(versionOf(out.file.kubernetes.kubectl)).toBe(kubectl);
  });

  it('a new Kubernetes minor waits for a CLI release, even when every part of it is there', async () => {
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
    expect(out.file.kubernetes).toEqual(bundled.kubernetes);
    expect(out.changed).toBe(false);
    expect(out.waiting).toEqual([{ name: 'k3s', current: K3S_VERSION, newest: next }]);
  });

  it.each([
    ['a driver is behind', [...drivers(), { repo: 'x/csi', tag: 'v2', minor: MINOR - 1 }], 'new'],
    [
      'k3s needs a system image we do not mirror',
      drivers(),
      `${IMAGES_TXT}\ndocker.io/rancher/mirrored-new:1.0.0`,
    ],
  ])('k3s stays when %s', async (_what, driverList, imagesTxt) => {
    const { k3s, over } = kubernetesPatch();
    const out = await plan(
      {
        ...over,
        k3sImages: async (version: string) =>
          version === k3s && imagesTxt !== 'new' ? imagesTxt : IMAGES_TXT,
      },
      driverList,
    );
    expect(out.file.kubernetes.k3s).toBe(K3S_VERSION);
    expect(out.notes.join('\n')).toContain(k3s);
  });

  it('nothing in the Kubernetes set moves when no k3s release is complete', async () => {
    const { over } = kubernetesPatch();
    const out = await plan(over, [...drivers(), { repo: 'x/csi', tag: 'v2', minor: MINOR - 1 }]);
    expect(out.file.kubernetes).toEqual(bundled.kubernetes);
    expect(out.changed).toBe(false);
  });

  it("a newer stable leaves this minor's patch to its own channel", async () => {
    const stable = `v1.${MINOR + 1}.0+k3s1`;
    const patch = `v1.${MINOR}.99+k3s1`;
    const out = await plan({
      k3sChannels: async () => ({ stable, [`v1.${MINOR}`]: patch }),
    });
    expect(out.file.kubernetes.k3s).toBe(patch);
    expect(out.changed).toBe(true);
    expect(out.include.length).toBeGreaterThan(0);
    expect(out.waiting).toEqual([{ name: 'k3s', current: K3S_VERSION, newest: stable }]);
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

  it('keeps a list that is a patch ahead of the bundled copy', async () => {
    const ahead = published();
    ahead.images = {
      ...ahead.images,
      traefik: `ghcr.io/hyperformant/traefik:${TRAEFIK_PATCH}@${digest('c')}`,
    };
    const out = await plan({}, drivers(), ahead);
    expect(out.file.images.traefik).toBe(ahead.images.traefik);
    expect(out.changed).toBe(false);
  });

  it('puts a list that is off the bundled minor back on it, since no CLI built here takes it', async () => {
    const ahead = published();
    ahead.images = {
      ...ahead.images,
      traefik: `ghcr.io/hyperformant/traefik:${TRAEFIK_MINOR}@${digest('c')}`,
    };
    ahead.kubernetes = { ...ahead.kubernetes, k3s: `v1.${MINOR + 1}.0+k3s1` };
    const out = await plan({}, drivers(), ahead);
    expect(out.file.images.traefik).toBe(bundled.images.traefik);
    expect(out.file.kubernetes.k3s).toBe(K3S_VERSION);
    expect(out.changed).toBe(true);
    expect(parseChannelFile(out.file, bundled).ahead).toEqual([]);
    expect(out.include.map((e: { dst: string }) => e.dst)).toContain(
      `ghcr.io/hyperformant/traefik:${CHANNEL_IMAGES.traefik.tag}`,
    );
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
  const dir = createTempDir('vc-channel-write-');
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
    expect(parseChannelFile(JSON.parse(text), bundled)).toEqual({ set: bundled, ahead: [] });
    expect(text.endsWith('}\n')).toBe(true);
    write(JSON.stringify(published()));
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  const offMinor = () => {
    const file = structuredClone(published());
    file.images.traefik = `ghcr.io/hyperformant/traefik:${TRAEFIK_MINOR}@${digest('c')}`;
    return JSON.stringify(file);
  };

  it.each([
    ['not JSON', 'nonsense'],
    ['a foreign ref', JSON.stringify({ ...published(), images: { traefik: 'evil' } })],
    ['a list a CLI built here would not take whole', offMinor()],
  ])('refuses %s and leaves the file alone', (_what, channel) => {
    const before = readFileSync(join(dir, 'channel.json'), 'utf8');
    const { path, run } = write(channel);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('names the key that is off the bundled minor, and nothing from the file', () => {
    const { run } = write(offMinor());
    expect(run.stderr).toContain(
      'images.traefik is on a newer minor or major than this CLI bundles',
    );
    expect(run.stderr).not.toContain(TRAEFIK_MINOR);
  });
});
