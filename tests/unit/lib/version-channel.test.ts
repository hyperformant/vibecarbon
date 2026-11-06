/**
 * The version channel's client side (src/lib/version-channel.js). channel.json
 * chooses what runs on customer servers, so the validation here is a security
 * boundary: anything outside the exact shape rejects the whole file, and a
 * deploy goes on with the bundled copy. A read never blocks or fails a deploy.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateImageSet,
  bundledImageSet,
  K3S_VERSION,
  traefikImageRef,
} from '../../../src/lib/images.js';
import {
  CHANNEL_READ_TIMEOUT_MS,
  CHANNEL_SCHEMA,
  CHANNEL_URL,
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

afterEach(() => {
  activateImageSet(null);
  vi.unstubAllGlobals();
});

describe('parseChannelFile accepts only the exact shape', () => {
  it('takes the bundled set as a file, and returns a fresh object', () => {
    const input = file();
    const parsed = parseChannelFile(input, bundled);
    expect(parsed).toEqual(bundled);
    expect(parsed.images).not.toBe(input.images);
  });

  it('takes a newer patch and a newer minor of the same major', () => {
    const input = file();
    input.images.traefik = withTag(bundled.images.traefik, 'v3.99.1');
    input.kubernetes.k3s = 'v1.99.3+k3s2';
    const parsed = parseChannelFile(input, bundled);
    expect(parsed.images.traefik).toBe(input.images.traefik);
    expect(parsed.kubernetes.k3s).toBe('v1.99.3+k3s2');
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
    expect(() => parseChannelFile(input, bundled)).toThrow(/older than/);
    const k3s = file();
    k3s.kubernetes.k3s = 'v1.20.0+k3s1';
    expect(() => parseChannelFile(k3s, bundled)).toThrow(/older than/);
  });

  it('refuses another major: this CLI was written against the bundled one', () => {
    const input = file();
    input.images.traefik = withTag(bundled.images.traefik, 'v4.0.0');
    expect(() => parseChannelFile(input, bundled)).toThrow(/major/);
    const k3s = file();
    k3s.kubernetes.k3s = 'v2.0.0+k3s1';
    expect(() => parseChannelFile(k3s, bundled)).toThrow(/major/);
  });

  it('never repeats the rejected value in its reason', () => {
    const input = file();
    input.images.traefik = 'ghcr.io/evil/\u001b[2Jx';
    expect(() => parseChannelFile(input, bundled)).toThrow(/^(?!.*evil).*$/s);
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
    const { set, problem } = await readChannel({ fetchFn });
    expect(problem).toBeUndefined();
    expect(set).toEqual(bundled);
    expect(CHANNEL_URL).toBe(
      'https://raw.githubusercontent.com/hyperformant/vibecarbon/channel/channel.json',
    );
    expect(fetchFn).toHaveBeenCalledWith(
      CHANNEL_URL,
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
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
    f.images.traefik = withTag(bundled.images.traefik, 'v3.99.0');
    f.kubernetes.k3s = 'v1.99.0+k3s1';
    return f;
  };
  const channelRead = (f: unknown) => vi.fn(async () => ({ set: parseChannelFile(f, bundled) }));

  it('reads once, activates the result, and every ref then comes from it', async () => {
    const read = channelRead(moved());
    const set = await resolveDeployImageSet({ envConfig: undefined, k8s: true, read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(set.images.traefik).toContain(':v3.99.0@');
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
    expect(set.images.traefik).toContain(':v3.99.0@');
  });

  it('a live cluster from before the channel stays on the bundled Kubernetes set', async () => {
    const set = await resolveDeployImageSet({
      envConfig: { deployMode: 'kubernetes', deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
    });
    expect(set.kubernetes.k3s).toBe(K3S_VERSION);
    expect(set.images.traefik).toContain(':v3.99.0@');
  });

  it('a compose environment that becomes k8s starts on the channel, not its old record', async () => {
    const recorded = structuredClone(bundled);
    recorded.kubernetes.k3s = 'v1.36.1+k3s1';
    const set = await resolveDeployImageSet({
      envConfig: { deployMode: 'compose', imageSet: recorded, deployedAt: '2026-11-01' },
      k8s: true,
      read: channelRead(moved()),
    });
    expect(set.kubernetes.k3s).toBe('v1.99.0+k3s1');
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

describe('useRecordedImageSet', () => {
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
