/**
 * A private app image at ghcr.io is pulled with a GitHub classic token that
 * has only read:packages, kept as the cluster's `ghcr-pull-secret` and
 * nowhere else (ghcr-pull-secret.js). The CLI asks for it once; a public
 * package needs none, and a token already in a cluster that ghcr still
 * accepts is reused. GitHub, ghcr.io and kubectl are fakes here: the fetcher
 * is keyed by URL, kubectl answers from a Secret per kubeconfig.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../_shared/source-files.js';

type KubectlCall = { argv: string[]; input?: string; env?: NodeJS.ProcessEnv };
const h = vi.hoisted(() => ({
  kubectl: [] as KubectlCall[],
  /** The stored .dockerconfigjson per kubeconfig, as kubectl returns it (base64). */
  secrets: {} as Record<string, string>,
  kubectlFails: null as Error | null,
}));

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({
    log: ['info', 'warn'],
    with: { isCancel: (v: unknown) => typeof v === 'symbol' },
  });
});
vi.mock('@clack/prompts', () => clackMock);

vi.mock('../../../src/lib/cli/exit-guard.js', () => ({
  exitCancelled: vi.fn(() => {
    throw new Error('exitCancelled');
  }),
}));

vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runKubectlWithRetry: async (
    argv: string[],
    { env, input }: { env?: NodeJS.ProcessEnv; input?: string } = {},
  ) => {
    h.kubectl.push({ argv, input, env });
    if (h.kubectlFails) throw h.kubectlFails;
    const stored = h.secrets[env?.KUBECONFIG ?? ''];
    if (argv.at(-1) === 'jsonpath={.data.\\.dockerconfigjson}') return stored ?? '';
    if (argv.at(-1) === 'name') return stored === undefined ? '' : 'secret/ghcr-pull-secret\n';
    if (argv[1] === '-f' && argv[2] === '-') return '';
    if (argv[0] === 'delete') return '';
    throw new Error(`unexpected kubectl ${argv.join(' ')}`);
  },
}));

const {
  FLUX_APP_TAG,
  GHCR_PULL_SECRET,
  assertAppImageBuilt,
  ensureGhcrPullSecretOn,
  clusterStores,
  ghcrPullSecretManifest,
  readGhcrPullSecret,
} = await import('../../../src/lib/deploy/k8s/ghcr-pull-secret.js');
const {
  ghcrAcceptsToken,
  ghcrPullsAnonymously,
  githubTokenScopes,
  newPullTokenUrl,
  pullTokenProblem,
  resolveGhcrPull,
} = await import('../../../src/lib/deploy/ghcr-pull.js');
const { exitCancelled } = await import('../../../src/lib/cli/exit-guard.js');

const MODULES = ['src/lib/deploy/ghcr-pull.js', 'src/lib/deploy/k8s/ghcr-pull-secret.js'].map(
  (file) => join(REPO_ROOT, file),
);

/** A classic token's shape: ghp_ and 36 more. Distinct enough to grep for. */
const TOKEN = `ghp_${'vcpullsentinel'.padEnd(36, 'Q')}`;
const OLD_TOKEN = `ghp_${'vcpullold'.padEnd(36, 'Z')}`;

const TOKEN_URL = 'https://ghcr.io/token?scope=repository:acme/shop:pull&service=ghcr.io';
const TAGS_URL = 'https://ghcr.io/v2/acme/shop/tags/list';
const MANIFEST_URL = 'https://ghcr.io/v2/acme/shop/manifests/main';
const USER_URL = 'https://api.github.com/user';

const basic = (user: string, token: string) =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

/** What kubectl's jsonpath prints for a Secret holding this pair. */
const storedSecret = (username: string, token: string) =>
  Buffer.from(
    JSON.stringify({ auths: { 'ghcr.io': { username, password: token, auth: 'x' } } }),
  ).toString('base64');

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };
type Fetched = { url: string; headers: Record<string, string> };

/** One answer for every token, or one per token (keyed by the token). */
type PerToken<T> = T | Record<string, T>;
const forToken = <T>(value: PerToken<T>, token: string): T =>
  value !== null && typeof value === 'object' ? (value as Record<string, T>)[token] : (value as T);

/**
 * GitHub and ghcr.io as one fetcher. `anonymous` is ghcr's answer to the
 * anonymous probe (token, then tags); `tokens` is what ghcr says for each
 * Basic token (exchange, then tags); `user` is api.github.com's status for
 * the token's /user call, and `scopes` the x-oauth-scopes header it sends
 * (null: no header, a fine-grained token). `user` and `scopes` may be keyed
 * by token. `manifest` is ghcr's answer to the HEAD of the app image's
 * `:main` manifest, for the anonymous pull token and for a token's.
 */
function registry({
  anonymous = { token: 200, tags: 401 },
  manifest = { anonymous: 200, token: 200 },
  tokens = { [TOKEN]: { exchange: 200, tags: 200 } } as Record<
    string,
    { exchange: number; tags: number }
  >,
  user = 200 as PerToken<number>,
  scopes = 'read:packages' as PerToken<string | null>,
  login = 'octo',
} = {}) {
  const fetched: Fetched[] = [];
  const fetcher = vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
    const headers = init.headers ?? {};
    fetched.push({ url, headers });
    const auth = headers.Authorization ?? '';
    const reply = ((): Reply => {
      if (url === USER_URL) {
        const token = auth.replace(/^Bearer /, '');
        const status = forToken(user, token) ?? 401;
        const header = forToken(scopes, token) ?? null;
        return {
          status,
          headers: header === null ? {} : { 'x-oauth-scopes': header },
          body: status === 200 ? { login } : { message: 'Bad credentials' },
        };
      }
      if (url === TOKEN_URL) {
        if (!auth) return { status: anonymous.token, body: { token: 'anon-bearer' } };
        const known = Object.entries(tokens).find(([t]) => auth === basic(login, t));
        if (!known) return { status: 401, body: {} };
        return { status: known[1].exchange, body: { token: `bearer-for-${known[1].tags}` } };
      }
      if (url === TAGS_URL) {
        if (auth === 'Bearer anon-bearer') return { status: anonymous.tags };
        const m = auth.match(/^Bearer bearer-for-(\d+)$/);
        if (m) return { status: Number(m[1]) };
        return { status: 401 };
      }
      if (url === MANIFEST_URL) {
        if (auth === 'Bearer anon-bearer') return { status: manifest.anonymous };
        if (/^Bearer bearer-for-\d+$/.test(auth)) return { status: manifest.token };
        return { status: 401 };
      }
      throw new Error(`unexpected fetch ${url}`);
    })();
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  });
  return { fetcher, fetched };
}

const PRIMARY = '/project/.vibecarbon/kubeconfig-prod-primary';
const STANDBY = '/project/.vibecarbon/kubeconfig-prod-standby';
const clusters = clusterStores([
  { envName: 'prod-primary', kubeconfigPath: PRIMARY },
  { envName: 'prod-standby', kubeconfigPath: STANDBY },
]);
const resolveArgs = {
  owner: 'acme',
  repo: 'shop',
  projectName: 'shop',
  envName: 'prod',
  keptAs: 'in the cluster as ghcr-pull-secret',
};

/** A prompt that answers `answer` and records what it was asked. */
const promptAnswering = (answer: unknown) => vi.fn(async (_opts: { message: string }) => answer);

const writes = () => h.kubectl.filter((c) => c.argv[0] === 'create' || c.argv[0] === 'replace');

beforeEach(() => {
  h.kubectl.length = 0;
  h.secrets = {};
  h.kubectlFails = null;
  vi.clearAllMocks();
  // The operator's own shell may have one; these tests set it when they mean to.
  vi.stubEnv('GHCR_PULL_TOKEN', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('the token scope check', () => {
  it('only read:packages passes', () => {
    expect(pullTokenProblem(['read:packages'])).toBeNull();
    expect(pullTokenProblem([])).not.toBeNull();
    expect(pullTokenProblem(['repo'])).not.toBeNull();
  });

  it('a broader token is refused, saying why', () => {
    const problem = pullTokenProblem(['read:packages', 'repo']);
    expect(problem).toMatch(/can also repo/);
    expect(problem).toMatch(/lives in your cluster/);
  });

  it('the k8s refusals are worded as ever', () => {
    const page = 'https://github.com/settings/tokens/new?scopes=read:packages';
    expect(pullTokenProblem(['read:packages', 'repo'])).toBe(
      'that token can also repo, and it lives in your cluster as ghcr-pull-secret, where anyone ' +
        `who can read Secrets can use it. make a classic token with only read:packages here: ${page}`,
    );
    expect(pullTokenProblem(['workflow'])).toBe(
      'that token can also workflow, and it lives in your cluster as ghcr-pull-secret, where ' +
        `anyone who can read Secrets can use it. make a classic token with only read:packages here: ${page}`,
    );
    expect(pullTokenProblem([])).toBe(
      `that token cannot read packages, so the cluster could not pull with it. make a classic token with only read:packages here: ${page}`,
    );
  });

  it('a refusal for a store that is not a cluster names none of the cluster words', async () => {
    const where = {
      lives: "on the server in docker's login file",
      readers: 'anyone with root on the server',
      puller: 'the server',
    };
    const wide = pullTokenProblem(['read:packages', 'repo'], where) as string;
    const none = pullTokenProblem([], where) as string;
    expect(wide).toContain("it lives on the server in docker's login file, where anyone with root");
    expect(none).toContain('so the server could not pull with it');
    // The same wording reaches the operator through the resolver.
    const err = await resolveGhcrPull({
      ...resolveArgs,
      stores: [],
      where,
      isTTY: true,
      prompt: promptAnswering(TOKEN),
      fetcher: registry({ scopes: 'read:packages, repo' }).fetcher,
    }).catch((e) => e);
    for (const text of [wide, none, err.message]) {
      expect(text).not.toMatch(/cluster|Secret|ghcr-pull-secret/i);
    }
    expect(err.message).toContain('anyone with root on the server');
  });

  it('write:packages is refused too: read only', () => {
    expect(pullTokenProblem(['write:packages', 'read:packages'])).toMatch(
      /can also write:packages/,
    );
  });

  it('a token with no scope list is not classic', () => {
    const problem = pullTokenProblem(null);
    expect(problem).toMatch(/classic token/);
    const scopePart = newPullTokenUrl({ projectName: 'shop', envName: 'prod' }).split('&')[0];
    expect(scopePart).toBe('https://github.com/settings/tokens/new?scopes=read:packages');
    expect(problem).toContain(scopePart);
  });

  it('the new-token page has read:packages ticked and a description naming the cluster', () => {
    expect(newPullTokenUrl({ projectName: 'shop', envName: 'prod' })).toBe(
      'https://github.com/settings/tokens/new?scopes=read:packages&description=shop%20prod%20image%20pulls',
    );
  });

  it('reads scopes from the response header, never putting the token in a url', async () => {
    const { fetcher, fetched } = registry({ scopes: 'read:packages' });
    expect(await githubTokenScopes(TOKEN, { fetcher })).toEqual({
      login: 'octo',
      scopes: ['read:packages'],
    });
    expect(fetched[0]).toMatchObject({
      url: USER_URL,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    const broad = registry({ scopes: 'read:packages, repo' });
    expect((await githubTokenScopes(TOKEN, { fetcher: broad.fetcher })).scopes).toEqual([
      'read:packages',
      'repo',
    ]);

    const fineGrained = registry({ scopes: null });
    expect((await githubTokenScopes(TOKEN, { fetcher: fineGrained.fetcher })).scopes).toBeNull();

    const refused = registry({ user: 401 });
    const err = await githubTokenScopes(TOKEN, { fetcher: refused.fetcher }).catch((e) => e);
    expect(err.message).toMatch(/github did not accept that token/);
    expect(err.message).not.toContain(TOKEN);

    for (const { url } of [...fetched, ...broad.fetched, ...fineGrained.fetched]) {
      expect(url).not.toContain(TOKEN);
    }
  });

  it('a 403 says to make a classic token; only a 5xx or 429 says to try again', async () => {
    const said = async (user: number) =>
      (await githubTokenScopes(TOKEN, { fetcher: registry({ user }).fetcher }).catch((e) => e))
        .message as string;
    // A token type /user refuses will not get better with time.
    const forbidden = await said(403);
    expect(forbidden).toMatch(/not one github's \/user accepts/);
    expect(forbidden).toMatch(/make a classic token with only read:packages/);
    expect(forbidden).not.toMatch(/try again/);
    for (const status of [500, 503, 429]) {
      expect(await said(status), String(status)).toMatch(/try again in a minute/);
    }
    expect(await said(404)).not.toMatch(/try again/);
    for (const status of [401, 403, 404, 429, 500]) {
      expect(await said(status)).not.toContain(TOKEN);
    }
  });

  it('a paste with a space or a control character in it is sent nowhere', async () => {
    // fetch refuses such a header value with an error that quotes it.
    for (const bad of [`${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`, `${TOKEN} x`, '']) {
      const { fetcher } = registry();
      const err = await githubTokenScopes(bad, { fetcher }).catch((e) => e);
      expect(err.message).toMatch(/sent nowhere/);
      expect(err.message).not.toContain(TOKEN.slice(4, 20));
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});

describe('the ghcr probes', () => {
  it('a public package pulls anonymously', async () => {
    const { fetcher, fetched } = registry({ anonymous: { token: 200, tags: 200 } });
    expect(await ghcrPullsAnonymously({ owner: 'Acme', repo: 'Shop', fetcher })).toBe(true);
    // ghcr paths are lowercase, whatever case GitHub spells the owner in.
    expect(fetched.map((f) => f.url)).toEqual([TOKEN_URL, TAGS_URL]);
    expect(fetched[0].headers.Authorization).toBeUndefined();
  });

  it('a private or missing package does not', async () => {
    for (const anonymous of [
      { token: 200, tags: 401 },
      { token: 200, tags: 403 },
      { token: 200, tags: 404 },
      { token: 401, tags: 200 },
    ]) {
      const { fetcher } = registry({ anonymous });
      expect(await ghcrPullsAnonymously({ owner: 'acme', repo: 'shop', fetcher }), anonymous).toBe(
        false,
      );
    }
  });

  it('ghcr accepts a good token, before the first build too', async () => {
    const { fetcher, fetched } = registry();
    expect(
      await ghcrAcceptsToken({
        owner: 'acme',
        repo: 'shop',
        username: 'octo',
        token: TOKEN,
        fetcher,
      }),
    ).toBe(true);
    expect(fetched[0]).toEqual({
      url: TOKEN_URL,
      headers: { Authorization: basic('octo', TOKEN) },
    });
    expect(fetched[1].url).toBe(TAGS_URL);

    // No package yet: ghcr knows the token, and the tags are simply not there.
    const unbuilt = registry({ tokens: { [TOKEN]: { exchange: 200, tags: 404 } } });
    expect(
      await ghcrAcceptsToken({
        owner: 'acme',
        repo: 'shop',
        username: 'octo',
        token: TOKEN,
        fetcher: unbuilt.fetcher,
      }),
    ).toBe(true);
  });

  it('ghcr turns a bad token down', async () => {
    const check = (exchange: number, tags: number) =>
      ghcrAcceptsToken({
        owner: 'acme',
        repo: 'shop',
        username: 'octo',
        token: TOKEN,
        fetcher: registry({ tokens: { [TOKEN]: { exchange, tags } } }).fetcher,
      });
    expect(await check(401, 200)).toBe(false);
    expect(await check(200, 403)).toBe(false);
    expect(await check(200, 401)).toBe(false);
    const err = await check(500, 200).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('the Secret', () => {
  it('the Secret is a dockerconfigjson for ghcr.io in vibecarbon', () => {
    expect(GHCR_PULL_SECRET).toBe('ghcr-pull-secret');
    const doc = load(ghcrPullSecretManifest({ username: 'octo', token: TOKEN })) as {
      kind: string;
      type: string;
      metadata: { name: string; namespace: string };
      stringData: Record<string, string>;
    };
    expect(doc.kind).toBe('Secret');
    expect(doc.metadata).toEqual({ name: 'ghcr-pull-secret', namespace: 'vibecarbon' });
    expect(doc.type).toBe('kubernetes.io/dockerconfigjson');
    expect(Object.keys(doc.stringData)).toEqual(['.dockerconfigjson']);
    expect(JSON.parse(doc.stringData['.dockerconfigjson'])).toEqual({
      auths: {
        'ghcr.io': {
          username: 'octo',
          password: TOKEN,
          auth: Buffer.from(`octo:${TOKEN}`).toString('base64'),
        },
      },
    });
  });

  it('readGhcrPullSecret: missing or malformed is null, a kubectl error throws', async () => {
    const env = { KUBECONFIG: PRIMARY } as NodeJS.ProcessEnv;
    expect(await readGhcrPullSecret({ env })).toBeNull();
    // Missing reads as an empty answer, so a first handover prints no NotFound.
    expect(h.kubectl[0].argv).toEqual([
      'get',
      'secret',
      'ghcr-pull-secret',
      '-n',
      'vibecarbon',
      '--ignore-not-found',
      '-o',
      'jsonpath={.data.\\.dockerconfigjson}',
    ]);

    h.secrets[PRIMARY] = storedSecret('octo', TOKEN);
    expect(await readGhcrPullSecret({ env })).toEqual({ username: 'octo', token: TOKEN });

    for (const body of [
      'not base64 json',
      Buffer.from('{"auths":{}}').toString('base64'),
      Buffer.from('{"auths":{"ghcr.io":{"username":"octo"}}}').toString('base64'),
    ]) {
      h.secrets[PRIMARY] = body;
      expect(await readGhcrPullSecret({ env }), body).toBeNull();
    }

    h.kubectlFails = new Error('read Secret vibecarbon/ghcr-pull-secret failed with exit 1');
    await expect(readGhcrPullSecret({ env })).rejects.toThrow(/failed with exit 1/);
  });

  it('ensureGhcrPullSecretOn writes only what differs, through stdin', async () => {
    const env = { KUBECONFIG: PRIMARY } as NodeJS.ProcessEnv;
    const pull = { mode: 'token' as const, username: 'octo', token: TOKEN };

    // Public: nothing written. (The stale-Secret delete has its own test.)
    expect(await ensureGhcrPullSecretOn({ env, pull: { mode: 'public' } })).toBe('public');
    expect(writes()).toEqual([]);
    h.kubectl.length = 0;

    // Missing: created.
    expect(await ensureGhcrPullSecretOn({ env, pull })).toBe('stored');
    expect(writes().map((c) => c.argv)).toEqual([['create', '-f', '-']]);

    // The same pair already there: nothing written.
    h.kubectl.length = 0;
    h.secrets[PRIMARY] = storedSecret('octo', TOKEN);
    expect(await ensureGhcrPullSecretOn({ env, pull })).toBe('kept');
    expect(writes()).toEqual([]);

    // A different token there: replaced whole.
    h.kubectl.length = 0;
    h.secrets[PRIMARY] = storedSecret('octo', OLD_TOKEN);
    expect(await ensureGhcrPullSecretOn({ env, pull })).toBe('stored');
    const [write] = writes();
    expect(write.argv).toEqual(['replace', '-f', '-']);
    expect(write.input).toBe(ghcrPullSecretManifest({ username: 'octo', token: TOKEN }));
    expect(write.input).toContain(TOKEN);
    expect(write.env?.KUBECONFIG).toBe(PRIMARY);

    // The token rode stdin only.
    for (const call of h.kubectl) {
      for (const arg of call.argv) expect(arg).not.toContain(TOKEN);
    }
  });

  it('a public package deletes a token an earlier run stored, so none sits there unchecked', async () => {
    // The image went public after a run stored a token: kubelet would keep
    // pulling with it, and no later run would check its scopes again. A
    // Secret named in imagePullSecrets that is missing only makes kubelet
    // pull anonymously.
    const env = { KUBECONFIG: PRIMARY } as NodeJS.ProcessEnv;
    h.secrets[PRIMARY] = storedSecret('octo', OLD_TOKEN);
    expect(await ensureGhcrPullSecretOn({ env, pull: { mode: 'public' } })).toBe('public');
    expect(h.kubectl.map((c) => c.argv)).toEqual([
      ['delete', 'secret', 'ghcr-pull-secret', '-n', 'vibecarbon', '--ignore-not-found'],
    ]);
    expect(h.kubectl[0].env?.KUBECONFIG).toBe(PRIMARY);
    expect(writes()).toEqual([]);
  });

  it('a pull credential that was never resolved is a bug, not a public package', async () => {
    const env = { KUBECONFIG: PRIMARY } as NodeJS.ProcessEnv;
    await expect(ensureGhcrPullSecretOn({ env, pull: undefined })).rejects.toThrow(TypeError);
    expect(h.kubectl).toEqual([]);
  });
});

describe('resolveGhcrPull', () => {
  it('public: nothing asked, nothing stored', async () => {
    const { fetcher, fetched } = registry({ anonymous: { token: 200, tags: 200 } });
    const prompt = promptAnswering(TOKEN);
    expect(
      await resolveGhcrPull({ ...resolveArgs, stores: clusters, isTTY: true, prompt, fetcher }),
    ).toEqual({ mode: 'public' });
    expect(prompt).not.toHaveBeenCalled();
    expect(h.kubectl).toEqual([]);
    expect(fetched.map((f) => f.url)).not.toContain(USER_URL);
  });

  it('a stored token ghcr still accepts is reused, with no ask', async () => {
    h.secrets[STANDBY] = storedSecret('octo', TOKEN);
    const { fetcher, fetched } = registry();
    const prompt = promptAnswering(OLD_TOKEN);
    expect(
      await resolveGhcrPull({ ...resolveArgs, stores: clusters, isTTY: true, prompt, fetcher }),
    ).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).not.toHaveBeenCalled();
    // Each side was read with its own kubeconfig; the primary has none.
    expect(h.kubectl.map((c) => c.env?.KUBECONFIG)).toEqual([PRIMARY, STANDBY]);
    expect(writes()).toEqual([]);
    // Checked as a new token is: its scopes at github, then ghcr.
    expect(fetched.map((f) => f.url)).toEqual([TOKEN_URL, TAGS_URL, USER_URL, TOKEN_URL, TAGS_URL]);
    expect(fetched[2].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('a stored token that has since gained repo is not reused and is not copied to the other side', async () => {
    // The primary holds a token someone widened at github after it was
    // stored; the standby holds none.
    h.secrets[PRIMARY] = storedSecret('octo', OLD_TOKEN);
    const scopes = { [OLD_TOKEN]: 'read:packages, repo', [TOKEN]: 'read:packages' };
    const tokens = {
      [OLD_TOKEN]: { exchange: 200, tags: 200 },
      [TOKEN]: { exchange: 200, tags: 200 },
    };
    const prompt = promptAnswering(TOKEN);
    const pull = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: true,
      prompt,
      fetcher: registry({ scopes, tokens }).fetcher,
    });
    expect(pull).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).toHaveBeenCalledTimes(1);
    const warned = vi
      .mocked(clackMock.log.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain(
      "the token in prod-primary's cluster can also repo, so it gets replaced.",
    );
    expect(warned).not.toContain(OLD_TOKEN);

    // The new one goes on both sides, and the widened one on neither.
    for (const kubeconfigPath of [PRIMARY, STANDBY]) {
      const env = { KUBECONFIG: kubeconfigPath } as NodeJS.ProcessEnv;
      expect(await ensureGhcrPullSecretOn({ env, pull })).toBe('stored');
    }
    expect(writes().map((c) => [c.argv[0], c.env?.KUBECONFIG])).toEqual([
      ['replace', PRIMARY],
      ['create', STANDBY],
    ]);
    for (const write of writes()) {
      expect(write.input).toContain(TOKEN);
      expect(write.input).not.toContain(OLD_TOKEN);
    }

    // Headless with no GHCR_PULL_TOKEN: refused, saying why and what to export.
    h.kubectl.length = 0;
    const err = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: false,
      prompt,
      fetcher: registry({ scopes, tokens }).fetcher,
    }).catch((e) => e);
    expect(err.message).toContain("the token in prod-primary's cluster can also repo");
    expect(err.message).toMatch(/export GHCR_PULL_TOKEN/);
    expect(err.message).not.toContain(OLD_TOKEN);
    expect(writes()).toEqual([]);
  });

  it('a revoked stored token asks again', async () => {
    // Revoked at github. ghcr may still answer for a package not published
    // yet, so github's answer is the one that counts.
    h.secrets[PRIMARY] = storedSecret('octo', OLD_TOKEN);
    const prompt = promptAnswering(TOKEN);
    const pull = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: true,
      prompt,
      fetcher: registry({
        anonymous: { token: 200, tags: 404 },
        user: { [OLD_TOKEN]: 401, [TOKEN]: 200 },
        tokens: {
          [OLD_TOKEN]: { exchange: 200, tags: 404 },
          [TOKEN]: { exchange: 200, tags: 404 },
        },
      }).fetcher,
    });
    expect(pull).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).toHaveBeenCalledTimes(1);
    const warned = vi
      .mocked(clackMock.log.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain(
      "the token in prod-primary's cluster is one github no longer accepts, so it gets replaced.",
    );
  });

  it('a missing Secret asks once for both sides of k8s-ha', async () => {
    const { fetcher } = registry();
    const prompt = promptAnswering(TOKEN);
    expect(
      await resolveGhcrPull({ ...resolveArgs, stores: clusters, isTTY: true, prompt, fetcher }),
    ).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(h.kubectl.map((c) => c.env?.KUBECONFIG)).toEqual([PRIMARY, STANDBY]);
  });

  it('a store of any kind is read in order, and the first good pair wins with no ask', async () => {
    const empty = { name: "on prod's server", read: vi.fn(async () => null) };
    const holding = {
      name: "on prod-standby's server",
      read: vi.fn(async () => ({ username: 'octo', token: TOKEN })),
    };
    const never = { name: 'in a third place', read: vi.fn(async () => null) };
    const prompt = promptAnswering(OLD_TOKEN);
    expect(
      await resolveGhcrPull({
        ...resolveArgs,
        stores: [empty, holding, never],
        isTTY: true,
        prompt,
        fetcher: registry().fetcher,
      }),
    ).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(empty.read).toHaveBeenCalledTimes(1);
    expect(holding.read).toHaveBeenCalledTimes(1);
    expect(never.read).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('keptAs names where the token lives in the ask', async () => {
    await resolveGhcrPull({
      ...resolveArgs,
      stores: [],
      keptAs: "in the server's docker login file",
      isTTY: true,
      prompt: promptAnswering(TOKEN),
      fetcher: registry().fetcher,
    });
    const said = vi
      .mocked(clackMock.log.info)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(said).toContain(
      "it lives in the server's docker login file and nowhere else, so give it nothing more.",
    );
    expect(said).not.toContain('ghcr-pull-secret');
  });

  it('a stored token with more than read:packages is never reused', async () => {
    const wide = {
      name: "on prod's server",
      read: vi.fn(async () => ({ username: 'octo', token: OLD_TOKEN })),
    };
    const prompt = promptAnswering(TOKEN);
    const pull = await resolveGhcrPull({
      ...resolveArgs,
      stores: [wide],
      isTTY: true,
      prompt,
      fetcher: registry({
        scopes: { [OLD_TOKEN]: 'repo, read:packages, workflow', [TOKEN]: 'read:packages' },
        tokens: {
          [OLD_TOKEN]: { exchange: 200, tags: 200 },
          [TOKEN]: { exchange: 200, tags: 200 },
        },
      }).fetcher,
    });
    expect(pull).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).toHaveBeenCalledTimes(1);
    const warned = vi
      .mocked(clackMock.log.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain(
      "the token on prod's server can also repo, workflow, so it gets replaced.",
    );
    expect(warned).not.toContain(OLD_TOKEN);
  });

  it('a stored token ghcr turns down asks again', async () => {
    h.secrets[PRIMARY] = storedSecret('octo', OLD_TOKEN);
    // ghcr knows only the new token: the old one was revoked.
    const { fetcher } = registry();
    const prompt = promptAnswering(TOKEN);
    expect(
      await resolveGhcrPull({
        ...resolveArgs,
        stores: clusters.slice(0, 1),
        isTTY: true,
        prompt,
        fetcher,
      }),
    ).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('GHCR_PULL_TOKEN in the shell is used without asking, and a broader one is refused naming the variable', async () => {
    vi.stubEnv('GHCR_PULL_TOKEN', TOKEN);
    const prompt = promptAnswering(OLD_TOKEN);
    expect(
      await resolveGhcrPull({
        ...resolveArgs,
        stores: clusters,
        isTTY: false,
        prompt,
        fetcher: registry().fetcher,
      }),
    ).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).not.toHaveBeenCalled();

    const err = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: false,
      prompt,
      fetcher: registry({ scopes: 'read:packages, repo' }).fetcher,
    }).catch((e) => e);
    expect(err.message).toMatch(/GHCR_PULL_TOKEN/);
    expect(err.message).toMatch(/can also repo/);
    expect(err.message).not.toContain(TOKEN);

    // A value that cannot be a classic token is named by its key, never shown.
    vi.stubEnv('GHCR_PULL_TOKEN', 'ghp_short');
    const short = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: false,
      prompt,
      fetcher: registry().fetcher,
    }).catch((e) => e);
    expect(short.message).toMatch(/GHCR_PULL_TOKEN looks wrong/);
    expect(short.message).not.toContain('ghp_short');
  });

  it('no terminal and no GHCR_PULL_TOKEN: says what to export', async () => {
    const prompt = promptAnswering(TOKEN);
    const err = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: false,
      prompt,
      fetcher: registry().fetcher,
    }).catch((e) => e);
    expect(err.message).toMatch(/GHCR_PULL_TOKEN/);
    expect(err.message).toMatch(/read:packages/);
    expect(err.message).toContain(newPullTokenUrl({ projectName: 'shop', envName: 'prod' }));
    expect(prompt).not.toHaveBeenCalled();
  });

  it('a refused token is stored nowhere', async () => {
    const before = { ...process.env };
    for (const fetcher of [
      registry({ scopes: 'read:packages, repo' }).fetcher,
      registry({ scopes: null }).fetcher,
      registry({ tokens: {} }).fetcher,
    ]) {
      const err = await resolveGhcrPull({
        ...resolveArgs,
        stores: clusters,
        isTTY: true,
        prompt: promptAnswering(TOKEN),
        fetcher,
      }).catch((e) => e);
      expect(err.message).toMatch(/^the token you pasted was not stored: /);
      expect(err.message).not.toContain(TOKEN);
    }
    expect(writes()).toEqual([]);
    // Not exported for a later step to pick up, and never written to a file.
    expect(process.env).toEqual(before);
    for (const module of MODULES) {
      expect(readFileSync(module, 'utf-8')).not.toMatch(
        /writeFile|appendFile|createWriteStream|mkdtemp|node:fs/,
      );
    }
  });

  it('the ask links the new-token page with read:packages preselected', async () => {
    const prompt = promptAnswering(TOKEN);
    await resolveGhcrPull({
      ...resolveArgs,
      owner: 'Acme',
      stores: clusters,
      isTTY: true,
      prompt,
      fetcher: registry().fetcher,
    });
    const said = vi
      .mocked(clackMock.log.info)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(said).toContain(
      'your app image at ghcr.io/acme/shop is private or not published yet, so prod needs a token to pull it.',
    );
    expect(said).toContain('make a classic token with only read:packages here: ');
    expect(said).toContain(newPullTokenUrl({ projectName: 'shop', envName: 'prod' }));
    expect(said).toContain(
      'it lives in the cluster as ghcr-pull-secret and nowhere else, so give it nothing more.',
    );
    expect(prompt.mock.calls[0][0].message).toBe('paste the token');
  });

  it('a cancelled ask stops the run', async () => {
    const err = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters,
      isTTY: true,
      prompt: promptAnswering(Symbol('cancel')),
      fetcher: registry().fetcher,
    }).catch((e) => e);
    expect(err.message).toBe('exitCancelled');
    expect(exitCancelled).toHaveBeenCalledTimes(1);
  });

  it('a package not published yet: it asks, and a good token is stored', async () => {
    // Anonymous: no such package. The token: ghcr knows it, no tags yet.
    const { fetcher } = registry({
      anonymous: { token: 200, tags: 404 },
      tokens: { [TOKEN]: { exchange: 200, tags: 404 } },
    });
    const prompt = promptAnswering(TOKEN);
    const pull = await resolveGhcrPull({
      ...resolveArgs,
      stores: clusters.slice(0, 1),
      isTTY: true,
      prompt,
      fetcher,
    });
    expect(pull).toEqual({ mode: 'token', username: 'octo', token: TOKEN });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(
      await ensureGhcrPullSecretOn({ env: { KUBECONFIG: PRIMARY } as NodeJS.ProcessEnv, pull }),
    ).toBe('stored');
    expect(writes()[0].input).toContain(TOKEN);
  });
});

describe('the app image Flux rolls to is built before the handover', () => {
  const PUBLIC = { mode: 'public' as const };
  const PRIVATE = { mode: 'token' as const, username: 'octo', token: TOKEN };
  const check = (
    pull: typeof PUBLIC | typeof PRIVATE,
    opts: Parameters<typeof registry>[0] = {},
  ) => {
    const reg = registry(opts);
    return {
      ...reg,
      run: () =>
        assertAppImageBuilt({
          owner: 'Acme',
          repo: 'Shop',
          pull,
          envName: 'prod-standby',
          fetcher: reg.fetcher,
        }),
    };
  };
  const NOT_BUILT =
    'your app image ghcr.io/acme/shop:main is not built yet, so flux would roll the app to an ' +
    'image that does not exist. commit and push .github/workflows to main, wait for its first ' +
    'build in the actions tab, then run vibecarbon configure cicd prod';

  it('the tag is the one every app image line in k8s/base names', () => {
    expect(FLUX_APP_TAG).toBe('main');
  });

  it('a built tag carries on: one HEAD of the manifest, asking for every image type', async () => {
    for (const [pull, auth] of [
      [PUBLIC, undefined],
      [PRIVATE, basic('octo', TOKEN)],
    ] as const) {
      const { fetcher, fetched, run } = check(pull);
      await expect(run()).resolves.toBeUndefined();
      // The same exchange as the other probes, anonymous or with the token's
      // Basic pair, then the manifest, lowercased like every ghcr path.
      expect(fetched.map((f) => f.url)).toEqual([TOKEN_URL, MANIFEST_URL]);
      expect(fetched[0].headers.Authorization).toBe(auth);
      const [, init] = fetcher.mock.calls[1] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(init.method).toBe('HEAD');
      expect(init.headers.Accept.split(/,\s*/)).toEqual([
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ]);
      expect(init.headers.Authorization).toMatch(/^Bearer /);
    }
  });

  it('a tag not built yet refuses, saying to push the workflow and wait for its build', async () => {
    for (const [pull, opts] of [
      [PRIVATE, { manifest: { anonymous: 200, token: 404 } }],
      [PUBLIC, { manifest: { anonymous: 404, token: 200 } }],
    ] as const) {
      const err = await check(pull, opts)
        .run()
        .catch((e) => e);
      expect(err?.message, JSON.stringify(opts)).toBe(NOT_BUILT);
    }
  });

  it('a public package that turns down an anonymous pull now has turned private, not gone unbuilt', async () => {
    // Public mode is resolved only after an anonymous pull of the package
    // worked, so a later refusal is a visibility change.
    for (const opts of [
      { manifest: { anonymous: 401, token: 200 } },
      { anonymous: { token: 401, tags: 401 } },
    ] as const) {
      const err = await check(PUBLIC, opts)
        .run()
        .catch((e) => e);
      expect(err?.message, JSON.stringify(opts)).toBe(
        'ghcr.io no longer lets anyone pull ghcr.io/acme/shop, so it may have turned private since ' +
          'this run began, and prod-standby was not handed to flux. a rerun asks for a pull token ' +
          'if it needs one: vibecarbon configure cicd prod',
      );
    }
  });

  it('ghcr down or rate limited says to try again, and never says the image is missing', async () => {
    for (const status of [503, 500, 429]) {
      for (const pull of [PUBLIC, PRIVATE]) {
        const err = await check(pull, { manifest: { anonymous: status, token: status } })
          .run()
          .catch((e) => e);
        expect(err?.message, String(status)).toMatch(/try again in a minute/);
        expect(err?.message).not.toMatch(/not built yet/);
      }
    }
    const exchange = await check(PRIVATE, { tokens: { [TOKEN]: { exchange: 503, tags: 200 } } })
      .run()
      .catch((e) => e);
    expect(exchange?.message).toMatch(/try again in a minute/);
  });

  it('a token ghcr now turns down says to rerun, which checks it again', async () => {
    const err = await check(PRIVATE, { tokens: {} })
      .run()
      .catch((e) => e);
    expect(err?.message).toMatch(/turned down the pull token/);
    expect(err?.message).toMatch(/vibecarbon configure cicd prod$/);
  });

  it('the token goes only into the exchange header: never a url or an error', async () => {
    for (const opts of [
      {},
      { manifest: { anonymous: 200, token: 404 } },
      { manifest: { anonymous: 200, token: 503 } },
      { manifest: { anonymous: 200, token: 403 } },
      { tokens: {} },
    ]) {
      const { fetched, run } = check(PRIVATE, opts);
      const err = await run().catch((e) => e);
      expect(String(err?.message ?? '')).not.toContain(TOKEN);
      for (const { url, headers } of fetched) {
        expect(url).not.toContain(TOKEN);
        if (url === MANIFEST_URL) expect(JSON.stringify(headers)).not.toContain(TOKEN);
      }
    }
  });
});

describe('configure cicd', () => {
  it('configure cicd resolves the pull credential once, before its per-cluster loop, and hands it to each cluster', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/configure.js'), 'utf8');
    const body = src.slice(src.indexOf('export async function runConfigureCicd('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn.match(/resolveGhcrPull\(/g)).toHaveLength(1);
    const resolveAt = fn.indexOf('resolveGhcrPull(');
    const loopAt = fn.indexOf('for (const target of handed) {');
    expect(loopAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(loopAt);
    const call = fn.slice(fn.indexOf('await deployK8sGitOps({'));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/\bghcrPull,\n/);
  });
});
