/**
 * The version channel's client side (src/lib/version-channel.js). channel.json
 * chooses what runs on customer servers, so the validation here is a security
 * boundary: anything outside the exact shape rejects the whole file, and a
 * deploy goes on with the bundled copy. A read never blocks or fails a deploy.
 *
 * A CLI takes a channel version only on its own major and minor, at or above
 * the patch it bundles. An entry on a newer minor or major is a newer CLI's
 * version: that key stays bundled and the rest of the file still applies.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateImageSet,
  bundledImageSet,
  K3S_VERSION,
  k3sVersion,
  PRE_CHANNEL_KUBERNETES,
  traefikImageRef,
} from '../../../src/lib/images.js';
import {
  CHANNEL_READ_TIMEOUT_MS,
  CHANNEL_SCHEMA,
  CHANNEL_URL,
  channelStep,
  chooseImageSet,
  parseChannelFile,
  parseImageSet,
  readChannel,
  resolveDeployImageSet,
  useRecordedImageSet,
} from '../../../src/lib/version-channel.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const bundled = bundledImageSet();
const file = () => ({ schema: CHANNEL_SCHEMA, ...structuredClone(bundled) });
/** The bundled ref with its version part replaced: a same-package newer ref. */
const withTag = (ref: string, tag: string) => `${ref.slice(0, ref.indexOf(':'))}:${tag}@${DIGEST}`;
const tagOf = (ref: string) => ref.slice(ref.indexOf(':') + 1, ref.indexOf('@'));
/** `version` one up at part `at` (0 major, 1 minor, 2 patch), later parts zeroed. */
const bump = (version: string, at: number) => {
  let i = -1;
  return version.replace(/\d+/g, (d) => {
    i += 1;
    if (i < at) return d;
    return i === at ? String(Number(d) + 1) : '0';
  });
};
/** The bundled image ref one patch up: what the channel carries for a fix. */
const patched = (ref: string) => withTag(ref, bump(tagOf(ref), 2));
const [, K3S_MAJOR, K3S_MINOR, K3S_PATCH, K3S_REV] = K3S_VERSION.match(
  /^v(\d+)\.(\d+)\.(\d+)\+k3s(\d+)$/,
) as RegExpMatchArray;
/** The bundled k3s with its +k3sN revision one up: a patch. */
const k3sPatched = `v${K3S_MAJOR}.${K3S_MINOR}.${K3S_PATCH}+k3s${Number(K3S_REV) + 1}`;
/** The bundled k3s one minor up: a newer CLI's Kubernetes. */
const k3sNextMinor = `v${K3S_MAJOR}.${Number(K3S_MINOR) + 1}.0+k3s1`;

afterEach(() => {
  activateImageSet(null);
  vi.unstubAllGlobals();
});

describe('parseChannelFile accepts only the exact shape', () => {
  it('takes the bundled set as a file, and returns a fresh object', () => {
    const input = file();
    const { set, ahead } = parseChannelFile(input, bundled);
    expect(set).toEqual(bundled);
    expect(set.images).not.toBe(input.images);
    expect(ahead).toEqual([]);
  });

  it('takes a newer patch of every key', () => {
    const input = file();
    input.images.traefik = patched(bundled.images.traefik);
    input.kubernetes.k3s = k3sPatched;
    const { set, ahead } = parseChannelFile(input, bundled);
    expect(set.images.traefik).toBe(input.images.traefik);
    expect(set.kubernetes.k3s).toBe(k3sPatched);
    expect(ahead).toEqual([]);
  });

  const traefik = bundled.images.traefik;
  const name = traefik.slice(0, traefik.indexOf(':'));
  const tag = traefik.slice(traefik.indexOf(':') + 1, traefik.indexOf('@'));
  it.each([
    ['another registry', `docker.io/traefik:${tag}@${DIGEST}`],
    ['another org', `ghcr.io/evil/traefik:${tag}@${DIGEST}`],
    ['a host that starts like ghcr', `ghcr.io.evil.example/hyperformant/traefik:${tag}@${DIGEST}`],
    ['an org that starts like ours', `ghcr.io/hyperformant-evil/traefik:${tag}@${DIGEST}`],
    ['a path traversal', `ghcr.io/hyperformant/../evil/traefik:${tag}@${DIGEST}`],
    ['a nested path', `ghcr.io/hyperformant/evil/traefik:${tag}@${DIGEST}`],
    ['another of our packages', `ghcr.io/hyperformant/socat:${tag}@${DIGEST}`],
    ['no digest', `${name}:${tag}`],
    ['no tag', `${name}@${DIGEST}`],
    ['a short digest', `${name}:${tag}@sha256:abc`],
    ['an uppercase digest', `${name}:${tag}@sha256:${'A'.repeat(64)}`],
    ['another digest algorithm', `${name}:${tag}@sha512:${'a'.repeat(128)}`],
    ['two digests', `${name}:${tag}@${DIGEST}@${DIGEST}`],
    ['a floating tag', `${name}:latest@${DIGEST}`],
    ['a trailing newline', `${name}:${tag}@${DIGEST}\n`],
    ['a second line', `${name}:${tag}@${DIGEST}\n  command: [evil]`],
    ['a shell substitution', `${name}:$(reboot)@${DIGEST}`],
    ['a shell separator', `${name}:${tag}@${DIGEST};reboot`],
    ['a leading space', ` ${name}:${tag}@${DIGEST}`],
    ['a number', 7],
    ['an object', { ref: traefik }],
    ['null', null],
  ])('rejects the whole file for %s', (_what, ref) => {
    const input = file() as Record<string, unknown> & ReturnType<typeof file>;
    (input.images as Record<string, unknown>).traefik = ref;
    expect(() => parseChannelFile(input, bundled)).toThrow(/images\.traefik/);
  });

  it.each([
    ['a shell substitution', 'v1.37.2+k3s1$(reboot)'],
    ['a quote', 'v1.37.2+k3s1"; reboot; "'],
    ['a newline', 'v1.37.2+k3s1\n'],
    ['a channel name', 'stable'],
    ['no k3s suffix', 'v1.37.2'],
    ['a prerelease', 'v1.37.2-rc1+k3s1'],
  ])('rejects the whole file for a k3s version with %s', (_what, version) => {
    const input = file();
    input.kubernetes.k3s = version;
    expect(() => parseChannelFile(input, bundled)).toThrow(/kubernetes\.k3s/);
  });

  /** A channel file being broken on purpose. */
  type LooseFile = Record<string, unknown> & {
    images: Record<string, unknown>;
    kubernetes: Record<string, unknown>;
  };

  it.each([
    ['a missing image', (f: LooseFile) => delete f.images.traefik],
    ['an unknown image', (f: LooseFile) => (f.images.evil = f.images.traefik)],
    ['a missing Kubernetes key', (f: LooseFile) => delete f.kubernetes.k3s],
    ['an unknown Kubernetes key', (f: LooseFile) => (f.kubernetes.evil = 'x')],
    ['an unknown top-level key', (f: LooseFile) => (f.evil = true)],
    [
      'a __proto__ key',
      (f: LooseFile) =>
        Object.defineProperty(f.images, '__proto__', { value: 'x', enumerable: true }),
    ],
    ['another schema', (f: LooseFile) => (f.schema = CHANNEL_SCHEMA + 1)],
    ['images as a list', (f: LooseFile) => (f.images = [f.images])],
  ])('rejects the whole file for %s', (_what, mutate) => {
    const input = file();
    mutate(input);
    expect(() => parseChannelFile(input, bundled)).toThrow();
  });

  it('rejects a file that is not an object', () => {
    for (const value of [null, [], 'x', 1]) {
      expect(() => parseChannelFile(value, bundled)).toThrow();
    }
  });

  it('refuses a version below the bundled copy, so a list cannot roll a fix back', () => {
    const input = file();
    input.images.traefik = withTag(bundled.images.traefik, 'v3.0.0');
    expect(() => parseChannelFile(input, bundled)).toThrow(/images\.traefik is older than/);
    const k3s = file();
    k3s.kubernetes.k3s = 'v1.20.0+k3s1';
    expect(() => parseChannelFile(k3s, bundled)).toThrow(/kubernetes\.k3s is older than/);
  });

  it('never repeats the rejected value in its reason', () => {
    const input = file();
    input.images.traefik = 'ghcr.io/evil/\u001b[2Jx';
    expect(() => parseChannelFile(input, bundled)).toThrow(/^(?!.*evil).*$/s);
  });
});

describe('a CLI takes only its own minor', () => {
  // A fixed floor, so each case reads as the versions it names.
  const floor = structuredClone(bundled);
  floor.images.traefik = withTag(bundled.images.traefik, 'v3.7.17');
  floor.images.alpine = withTag(bundled.images.alpine, '3.24.4');
  floor.kubernetes.k3s = 'v1.37.2+k3s1';
  floor.kubernetes.clusterAutoscaler = withTag(bundled.kubernetes.clusterAutoscaler, 'v1.37.0');
  floor.kubernetes.kubectl = withTag(bundled.kubernetes.kubectl, '1.37.2');
  const channel = () => ({ schema: CHANNEL_SCHEMA, ...structuredClone(floor) });

  it.each([
    ['a patch up', 'v3.7.18'],
    ['several patches up', 'v3.7.99'],
    ['the same version', 'v3.7.17'],
  ])('takes %s', (_what, tag) => {
    const input = channel();
    input.images.traefik = withTag(floor.images.traefik, tag);
    const { set, ahead } = parseChannelFile(input, floor);
    expect(set.images.traefik).toBe(input.images.traefik);
    expect(ahead).toEqual([]);
  });

  it.each([
    ['a patch below', 'v3.7.16'],
    ['a minor below', 'v3.6.99'],
    ['a major below', 'v2.99.0'],
  ])('rejects the whole file for %s the bundled copy', (_what, tag) => {
    const input = channel();
    input.images.traefik = withTag(floor.images.traefik, tag);
    expect(() => parseChannelFile(input, floor)).toThrow(/^images\.traefik is older than/);
  });

  it.each([
    ['a minor up', 'v3.8.0'],
    ['a major up', 'v4.0.0'],
    ['a major up with a lower minor', 'v4.0.1'],
  ])('keeps the bundled copy of a key the channel moved %s, and names it', (_what, tag) => {
    const input = channel();
    input.images.traefik = withTag(floor.images.traefik, tag);
    const { set, ahead } = parseChannelFile(input, floor);
    expect(set.images.traefik).toBe(floor.images.traefik);
    expect(ahead).toEqual(['images.traefik']);
  });

  it('a minor move of one key leaves the patches of the others standing', () => {
    const input = channel();
    input.images.traefik = withTag(floor.images.traefik, 'v3.8.0');
    input.images.alpine = withTag(floor.images.alpine, '3.24.5');
    input.kubernetes.k3s = 'v1.37.2+k3s2';
    const { set, ahead } = parseChannelFile(input, floor);
    expect(set.images.traefik).toBe(floor.images.traefik);
    expect(set.images.alpine).toBe(input.images.alpine);
    expect(set.kubernetes.k3s).toBe('v1.37.2+k3s2');
    expect(set.images.socat).toBe(floor.images.socat);
    expect(ahead).toEqual(['images.traefik']);
  });

  it.each([
    ['a +k3sN revision up is a patch', 'v1.37.2+k3s2', 'take'],
    ['a patch up with the revision reset is a patch', 'v1.37.3+k3s1', 'take'],
    ['the next minor is a minor move', 'v1.38.0+k3s1', 'ahead'],
    ['a major up is a move too', 'v2.0.0+k3s1', 'ahead'],
    ['a revision below is older', 'v1.37.2+k3s0', 'older'],
    ['a patch below is older, whatever its revision', 'v1.37.1+k3s9', 'older'],
  ])('k3s: %s', (_what, version, step) => {
    expect(channelStep(version, floor.kubernetes.k3s)).toBe(step);
    const input = channel();
    input.kubernetes.k3s = version;
    if (step === 'older') {
      expect(() => parseChannelFile(input, floor)).toThrow(/^kubernetes\.k3s is older than/);
      return;
    }
    const { set, ahead } = parseChannelFile(input, floor);
    expect(set.kubernetes.k3s).toBe(step === 'take' ? version : floor.kubernetes.k3s);
    expect(ahead).toEqual(step === 'take' ? [] : ['kubernetes.k3s']);
  });

  it('a Kubernetes minor names every key it moved, and the images still move', () => {
    const input = channel();
    input.kubernetes.k3s = 'v1.38.0+k3s1';
    input.kubernetes.clusterAutoscaler = withTag(floor.kubernetes.clusterAutoscaler, 'v1.38.0');
    input.kubernetes.kubectl = withTag(floor.kubernetes.kubectl, '1.38.1');
    input.images.traefik = withTag(floor.images.traefik, 'v3.7.20');
    const { set, ahead } = parseChannelFile(input, floor);
    expect(set.kubernetes).toEqual(floor.kubernetes);
    expect(set.images.traefik).toBe(input.images.traefik);
    expect(ahead).toEqual(['kubernetes.k3s', 'kubernetes.clusterAutoscaler', 'kubernetes.kubectl']);
  });

  it.each([
    ['1.8.1.4', '1.8.1.3', 'take'],
    ['1.8.2.0', '1.8.1.3', 'take'],
    ['1.9.0.0', '1.8.1.3', 'ahead'],
    ['1.8.1.2', '1.8.1.3', 'older'],
    ['v0.5.1', 'v0.5.0', 'take'],
    ['v0.6.0', 'v0.5.0', 'ahead'],
    ['3.25.0', '3.24.4', 'ahead'],
  ])('channelStep(%s) over %s is %s', (version, floorVersion, step) => {
    expect(channelStep(version, floorVersion)).toBe(step);
  });

  it('a shape fault still rejects the whole file, even beside a minor move', () => {
    const input = channel();
    input.images.traefik = withTag(floor.images.traefik, 'v3.8.0');
    input.images.alpine = 'docker.io/alpine:3.24.5';
    expect(() => parseChannelFile(input, floor)).toThrow(/images\.alpine/);
  });

  it('with no floor, holds the file to its shape only', () => {
    const input = channel();
    input.images.traefik = withTag(floor.images.traefik, 'v1.0.0');
    const { set, ahead } = parseChannelFile(input);
    expect(set.images.traefik).toBe(input.images.traefik);
    expect(ahead).toEqual([]);
  });
});

describe('parseImageSet on a recorded set', () => {
  it('holds a recorded set to the grammar but not to the floor', () => {
    const recorded = structuredClone(bundled);
    recorded.kubernetes.k3s = 'v1.20.0+k3s1';
    expect(parseImageSet(recorded).kubernetes.k3s).toBe('v1.20.0+k3s1');
  });

  it('still rejects a foreign ref', () => {
    const recorded = structuredClone(bundled);
    recorded.images.traefik = `docker.io/traefik:v3.7.17@${DIGEST}`;
    expect(() => parseImageSet(recorded)).toThrow(/images\.traefik/);
  });
});

describe('readChannel', () => {
  const answer = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      s.close();
    }
  });
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/channel.json`;
  };

  it('reads the channel branch of this repo, with redirects refused', async () => {
    const fetchFn = answer(JSON.stringify(file()));
    const { set, ahead, problem } = await readChannel({ fetchFn });
    expect(problem).toBeUndefined();
    expect(set).toEqual(bundled);
    expect(ahead).toEqual([]);
    expect(CHANNEL_URL).toBe(
      'https://raw.githubusercontent.com/hyperformant/vibecarbon/channel/channel.json',
    );
    expect(fetchFn).toHaveBeenCalledWith(
      CHANNEL_URL,
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  });

  it("hands back a newer CLI's minor as the bundled copy, named, and the rest as listed", async () => {
    const f = file();
    f.images.traefik = withTag(bundled.images.traefik, bump(tagOf(bundled.images.traefik), 1));
    f.images.socat = patched(bundled.images.socat);
    const { set, ahead, problem } = await readChannel({ fetchFn: answer(JSON.stringify(f)) });
    expect(problem).toBeUndefined();
    expect(set?.images.traefik).toBe(bundled.images.traefik);
    expect(set?.images.socat).toBe(f.images.socat);
    expect(ahead).toEqual(['images.traefik']);
  });

  it('stops reading an answer that never ends, at the cap and not at the timeout', async () => {
    const pull = (c: ReadableStreamDefaultController) =>
      c.enqueue(new Uint8Array(32 * 1024).fill(32));
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({ pull })));
    const { set, problem } = await readChannel({ fetchFn });
    expect(set).toBeUndefined();
    expect(problem).toBe('the file is too large');
  });

  it.each([
    ['a network failure', vi.fn(async () => Promise.reject(new TypeError('fetch failed')))],
    ['a 404', answer('nope', 404)],
    ['bad JSON', answer('{not json')],
    ['the wrong shape', answer('{"schema":1}')],
    ['a foreign ref', answer(JSON.stringify({ ...file(), images: { traefik: 'docker.io/x' } }))],
    ['an oversized file', answer(' '.repeat(70_000))],
  ])('gives a problem and no set on %s', async (_what, fetchFn) => {
    const { set, problem } = await readChannel({ fetchFn });
    expect(set).toBeUndefined();
    expect(problem).toEqual(expect.any(String));
  });

  it('holds a 3 s bound', () => {
    expect(CHANNEL_READ_TIMEOUT_MS).toBe(3_000);
  });

  it('gives up on a server that never answers', async () => {
    const url = await listen(() => {});
    const started = Date.now();
    const { set, problem } = await readChannel({ url, timeoutMs: 200 });
    expect(set).toBeUndefined();
    expect(problem).toEqual(expect.any(String));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up on a server that stalls in the middle of the body', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      res.write('{"schema":');
    });
    const started = Date.now();
    const { set, problem } = await readChannel({ url, timeoutMs: 200 });
    expect(set).toBeUndefined();
    expect(problem).toEqual(expect.any(String));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never prints what the file said', async () => {
    const secret = 'ghcr.io/evil/payload';
    const { problem } = await readChannel({
      fetchFn: answer(JSON.stringify({ ...file(), evilKey: secret })),
    });
    expect(problem).not.toContain('evil');
  });
});

describe('chooseImageSet', () => {
  const channel = structuredClone(bundled);
  channel.images.traefik = withTag(bundled.images.traefik, 'v3.99.0');
  channel.kubernetes.k3s = 'v1.99.0+k3s1';
  const recorded = structuredClone(bundled);
  recorded.images.traefik = withTag(bundled.images.traefik, 'v3.50.0');
  recorded.kubernetes.k3s = 'v1.40.0+k3s1';

  it('a new environment takes the whole channel', () => {
    expect(chooseImageSet({ channel, bundled, keepKubernetes: null })).toEqual(channel);
  });

  it('an existing cluster keeps its Kubernetes set and moves everything else', () => {
    const set = chooseImageSet({
      channel,
      bundled,
      keepKubernetes: recorded.kubernetes,
    });
    expect(set.kubernetes).toEqual(recorded.kubernetes);
    expect(set.images).toEqual(channel.images);
  });

  it('a bad channel means the bundled copy', () => {
    expect(chooseImageSet({ channel: null, bundled, keepKubernetes: null })).toEqual(bundled);
  });

  it('an existing cluster behind a bad channel still keeps its Kubernetes set', () => {
    const set = chooseImageSet({
      channel: null,
      bundled,
      keepKubernetes: recorded.kubernetes,
    });
    expect(set.kubernetes).toEqual(recorded.kubernetes);
    expect(set.images).toEqual(bundled.images);
  });
});

describe('resolveDeployImageSet', () => {
  const moved = () => {
    const f = file();
    f.images.traefik = patched(bundled.images.traefik);
    f.kubernetes.k3s = k3sPatched;
    return f;
  };
  const channelRead = (f: unknown) => vi.fn(async () => parseChannelFile(f, bundled));

  it('reads once, activates the result, and every ref then comes from it', async () => {
    const read = channelRead(moved());
    const set = await resolveDeployImageSet({ envConfig: undefined, k8s: true, read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(set.images.traefik).toBe(patched(bundled.images.traefik));
    expect(traefikImageRef()).toBe(set.images.traefik);
  });

  it('a bad channel leaves one quiet note and the bundled copy, and never throws', async () => {
    const note = vi.fn();
    const set = await resolveDeployImageSet({
      envConfig: undefined,
      k8s: true,
      read: async () => ({ problem: 'unreachable' }),
      note,
    });
    expect(set).toEqual(bundled);
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0][0]).toContain('bundled');
  });

  it('a read that throws is the same as a bad channel', async () => {
    const note = vi.fn();
    const set = await resolveDeployImageSet({
      envConfig: undefined,
      k8s: true,
      read: async () => {
        throw new Error('boom');
      },
      note,
    });
    expect(set).toEqual(bundled);
    expect(note).toHaveBeenCalledTimes(1);
  });

  it('an existing k8s environment keeps the recorded Kubernetes set', async () => {
    const recorded = structuredClone(bundled);
    recorded.kubernetes.k3s = 'v1.36.1+k3s1';
    const set = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', imageSet: recorded, deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
    });
    expect(set.kubernetes.k3s).toBe('v1.36.1+k3s1');
    expect(set.images.traefik).toBe(patched(bundled.images.traefik));
  });

  it('a live cluster from before the channel keeps the Kubernetes set it was built with', async () => {
    const set = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
    });
    expect(set.kubernetes).toEqual(PRE_CHANNEL_KUBERNETES);
    expect(set.kubernetes.k3s).not.toBe(K3S_VERSION);
    expect(set.images.traefik).toBe(patched(bundled.images.traefik));
  });

  it('the pre-channel set survives being recorded and read back', async () => {
    const first = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
    });
    const next = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', deployedAt: '2026-11-01', imageSet: first },
      k8s: true,
      read: channelRead(moved()),
    });
    expect(next.kubernetes).toEqual(PRE_CHANNEL_KUBERNETES);
  });

  it('a compose environment or a first deploy with no record takes no pre-channel set', async () => {
    for (const envConfig of [{ deployMode: 'compose', deployedAt: '2026-11-01' }, {}]) {
      const set = await resolveDeployImageSet({
        envConfig,
        k8s: true,
        read: channelRead(moved()),
      });
      expect(set.kubernetes).not.toEqual(PRE_CHANNEL_KUBERNETES);
    }
  });

  it('a compose environment that becomes k8s starts on the channel, not its old record', async () => {
    const recorded = structuredClone(bundled);
    recorded.kubernetes.k3s = 'v1.36.1+k3s1';
    const set = await resolveDeployImageSet({
      envConfig: { deployMode: 'compose', imageSet: recorded, deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
    });
    expect(set.kubernetes.k3s).toBe(k3sPatched);
  });

  it('a record that fails validation is not trusted, and the cluster stays on bundled', async () => {
    const note = vi.fn();
    const bad = structuredClone(bundled);
    bad.kubernetes.k3s = 'v1.37.2+k3s1"; reboot; "';
    const set = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', imageSet: bad, deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
      note,
    });
    expect(set.kubernetes.k3s).toBe(K3S_VERSION);
    expect(note).toHaveBeenCalledTimes(1);
  });

  it('an unchanged channel resolves to an equal set, so nothing downstream moves', async () => {
    const f = moved();
    const first = await resolveDeployImageSet({
      envConfig: undefined,
      k8s: true,
      read: channelRead(f),
    });
    const second = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', imageSet: first, deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(f),
    });
    expect(second).toEqual(first);
  });
});

describe("a channel ahead of this CLI's minor", () => {
  /** A list a newer CLI release moved: traefik a minor up, socat a patch up. */
  const newerTraefik = () => {
    const f = file();
    f.images.traefik = withTag(bundled.images.traefik, bump(tagOf(bundled.images.traefik), 1));
    f.images.socat = patched(bundled.images.socat);
    return f;
  };
  /** A list a newer CLI release moved to the next Kubernetes minor. */
  const newerKubernetes = (f = file()) => {
    f.kubernetes.k3s = k3sNextMinor;
    for (const key of ['clusterAutoscaler', 'kubectl'] as const) {
      f.kubernetes[key] = withTag(bundled.kubernetes[key], bump(tagOf(bundled.kubernetes[key]), 1));
    }
    return f;
  };
  const resolve = (f: unknown, envConfig: unknown = undefined, k8s = true) => {
    const note = vi.fn();
    const read = async () => parseChannelFile(f, bundled);
    return resolveDeployImageSet({ envConfig, k8s, read, note }).then((set) => ({ set, note }));
  };

  it('deploys the bundled copy of that key and the patches of the rest', async () => {
    const f = newerTraefik();
    const { set } = await resolve(f);
    expect(set.images.traefik).toBe(bundled.images.traefik);
    expect(set.images.socat).toBe(f.images.socat);
    expect(traefikImageRef()).toBe(bundled.images.traefik);
  });

  it('says so once, plainly, naming what a newer vibecarbon brings', async () => {
    const { note } = await resolve(newerTraefik());
    expect(note).toHaveBeenCalledTimes(1);
    const line = note.mock.calls[0][0] as string;
    expect(line).toBe(
      'a newer traefik needs a newer vibecarbon, so this deploy keeps the one this CLI was ' +
        'tested with. update with npm i -g vibecarbon to get it',
    );
    expect(line).not.toMatch(/—/);
    expect(line).not.toContain(DIGEST);
  });

  it('names a whole Kubernetes move once, beside an image, on a new cluster', async () => {
    const { set, note } = await resolve(newerKubernetes(newerTraefik()));
    expect(set.kubernetes).toEqual(bundled.kubernetes);
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0][0]).toBe(
      'newer traefik and Kubernetes versions need a newer vibecarbon, so this deploy keeps the ' +
        'ones this CLI was tested with. update with npm i -g vibecarbon to get them',
    );
  });

  it.each([
    [
      'an existing cluster, which keeps its own Kubernetes anyway',
      { deployMode: 'kubernetes', imageSet: bundled, deployedAt: '2026-11-01' },
      true,
    ],
    ['a compose deploy, which runs no Kubernetes', undefined, false],
  ])('says nothing about Kubernetes on %s', async (_what, envConfig, k8s) => {
    const { note } = await resolve(newerKubernetes(), envConfig, k8s);
    expect(note).not.toHaveBeenCalled();
  });

  it('says nothing when the channel is on this CLI’s minor', async () => {
    const f = file();
    f.images.traefik = patched(bundled.images.traefik);
    f.kubernetes.k3s = k3sPatched;
    const { note } = await resolve(f);
    expect(note).not.toHaveBeenCalled();
  });
});

describe('useRecordedImageSet', () => {
  it('a cluster from before the channel scales and fails over on its own Kubernetes', () => {
    useRecordedImageSet({ deployMode: 'kubernetes', deployedAt: '2026-11-01' });
    expect(k3sVersion()).toBe(PRE_CHANNEL_KUBERNETES.k3s);
  });

  it('an environment that was never deployed stays on the bundled set', () => {
    useRecordedImageSet({ deployMode: 'kubernetes' });
    expect(k3sVersion()).toBe(K3S_VERSION);
  });

  it('activates the recorded set and never reads the channel', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const recorded = structuredClone(bundled);
    recorded.images.traefik = withTag(bundled.images.traefik, 'v3.50.0');
    useRecordedImageSet({ imageSet: recorded });
    expect(traefikImageRef()).toBe(recorded.images.traefik);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an environment with no record runs the bundled copy, silently', () => {
    const note = vi.fn();
    useRecordedImageSet({}, { note });
    expect(traefikImageRef()).toBe(bundled.images.traefik);
    expect(note).not.toHaveBeenCalled();
  });

  it('a record that fails validation runs the bundled copy, with a note', () => {
    const note = vi.fn();
    const bad = structuredClone(bundled);
    bad.images.traefik = 'docker.io/traefik:latest';
    useRecordedImageSet({ imageSet: bad }, { note });
    expect(traefikImageRef()).toBe(bundled.images.traefik);
    expect(note).toHaveBeenCalledTimes(1);
  });
});
