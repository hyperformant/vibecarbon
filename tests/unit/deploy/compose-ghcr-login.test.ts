/**
 * A compose server's ghcr.io login (src/lib/deploy/compose/ghcr-login.js): the
 * `ghcr.io` entry of its /root/.docker/config.json. It holds the read:packages
 * pull token for a private app image, or is not there at all. Docker Hub's
 * entry beside it is never touched, and never leaves the server.
 *
 * ssh is faked one level down, at runCommandAsync, so the real sshRunAsync and
 * the real dockerLoginOnServer run: what reaches the fake is exactly the argv
 * and the stdin a server would get. Each fake server keeps its login file in a
 * temp dir here, and the fake runs the python the read and the removal ship
 * (`python3 -I`, the program on stdin) against that file, so what comes back
 * is what the server would print.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ argv: string[]; input?: string; secret?: boolean }>,
  /** What each command printed, as the wire carried it. */
  outputs: [] as string[],
  unreachable: new Map<string, string>(),
  warn: vi.fn(),
  /** What the operator-IP guard does when a transient ssh error asks it. */
  ipGuard: vi.fn(async () => {}),
  /** Set once the module is loaded: the fake server's answer to one command. */
  serve: null as null | ((ip: string, input: string) => string),
}));

vi.mock('@clack/prompts', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  log: { warn: h.warn, info: vi.fn() },
}));

vi.mock('../../../src/lib/operator-ip-guard.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertOperatorIpUnchanged: h.ipGuard,
}));

vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommandAsync: vi.fn(
    async (argv: string[], opts: { input?: string; secret?: boolean } = {}) => {
      h.calls.push({ argv, input: opts.input, secret: opts.secret });
      const ip = argv.find((a) => a.startsWith('root@'))?.slice('root@'.length) ?? '';
      const down = h.unreachable.get(ip);
      if (down) {
        throw Object.assign(new Error(`Command failed: ssh root@${ip} /bin/bash -s\n${down}`), {
          status: 255,
          stderr: `${down}\n`,
        });
      }
      const command = argv.at(-1) ?? '';
      if (command !== '/bin/bash -s') throw new Error(`unexpected command on ${ip}: ${command}`);
      const out = h.serve?.(ip, opts.input ?? '') ?? '';
      h.outputs.push(out);
      return out;
    },
  ),
}));

const {
  COMPOSE_KEPT_AS,
  COMPOSE_WHERE,
  ensureGhcrLoginOn,
  ghcrLoginReadPython,
  ghcrLoginReadScript,
  ghcrLoginRemovalPython,
  ghcrLoginRemovalScript,
  namedComposeServers,
  readGhcrLoginOnServer,
  serverStores,
} = await import('../../../src/lib/deploy/compose/ghcr-login.js');
const { resolveGhcrPull } = await import('../../../src/lib/deploy/ghcr-pull.js');

const IP = '203.0.113.5';
const IP2 = '203.0.113.6';
const KEY = '/project/.vibecarbon/deploy_key_prod';
const DOCKER_HUB = 'https://index.docker.io/v1/';

/** A classic token's shape: ghp_ and 36 more. Distinct enough to grep for. */
const TOKEN = `ghp_${'vcpullsentinel'.padEnd(36, 'Q')}`;
const OTHER = `ghp_${'vcpullother'.padEnd(36, 'Z')}`;
const HUB_TOKEN = 'dckr_pat_vchubsentinel';

const auth = (user: string, token: string) => Buffer.from(`${user}:${token}`).toString('base64');
const HUB_AUTH = auth('hubuser', HUB_TOKEN);
const loginFile = (auths: Record<string, { auth?: string }>, extra = {}) =>
  JSON.stringify({ auths, ...extra });
const withHub = (ghcr?: { auth?: string }) =>
  loginFile({ [DOCKER_HUB]: { auth: HUB_AUTH }, ...(ghcr && { 'ghcr.io': ghcr }) });

const DIR = mkdtempSync(join(tmpdir(), 'vc-ghcr-login-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** Each fake server's login file, in the temp dir. */
const fileOf = (ip: string) => join(DIR, `${ip}.config.json`);
function setLogin(ip: string, text: string | null) {
  if (text === null) rmSync(fileOf(ip), { force: true });
  else writeFileSync(fileOf(ip), text, { mode: 0o600 });
}
const loginText = (ip: string) => readFileSync(fileOf(ip), 'utf-8');

/** Run a shipped python program the way the scripts do: `python3 -I`, the program on stdin. */
function runPython(program: string): string {
  return execFileSync('python3', ['-I', '-'], {
    input: program,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

h.serve = (ip, input) => {
  // The shipped scripts, each with the server's file in place of its path.
  if (input === ghcrLoginReadScript()) return runPython(ghcrLoginReadPython(fileOf(ip)));
  if (input === ghcrLoginRemovalScript()) {
    try {
      return runPython(ghcrLoginRemovalPython(fileOf(ip)));
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '');
      throw Object.assign(new Error(`Command failed: ssh root@${ip} /bin/bash -s\n${stderr}`), {
        status: 1,
        stderr,
      });
    }
  }
  // dockerLoginOnServer's write prints nothing.
  if (input.includes('AUTH=')) return '';
  throw new Error(`unexpected script on ${ip}`);
};

/** The scripts sent on ssh's stdin. */
const scripts = () => h.calls.flatMap((c) => (c.input === undefined ? [] : [c.input]));
/** Every argv element of every command this file ran, one string. */
const allArgv = () => h.calls.flatMap((c) => c.argv).join('\n');

beforeEach(() => {
  h.calls.length = 0;
  h.outputs.length = 0;
  h.unreachable.clear();
  h.warn.mockClear();
  h.ipGuard.mockReset();
  h.ipGuard.mockImplementation(async () => {});
  setLogin(IP, null);
  setLogin(IP2, null);
});

describe('reading a server login back', () => {
  it("reads the ghcr.io pair back, and Docker Hub's pair never leaves the server", async () => {
    setLogin(IP, withHub({ auth: auth('octo', TOKEN) }));
    expect(await readGhcrLoginOnServer(IP, KEY)).toEqual({ username: 'octo', token: TOKEN });
    // One read, the read script, sent as a secret read; it changes nothing.
    expect(h.calls).toHaveLength(1);
    expect(scripts()).toEqual([ghcrLoginReadScript()]);
    expect(h.calls[0].secret).toBe(true);
    expect(loginText(IP)).toBe(withHub({ auth: auth('octo', TOKEN) }));
    // What crossed the wire is the ghcr.io login alone.
    expect(h.outputs).toEqual([`${auth('octo', TOKEN)}\n`]);
    expect(h.outputs.join('')).not.toContain(HUB_AUTH);
  });

  it('missing file, missing entry, malformed json: null', async () => {
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    setLogin(IP, withHub());
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    setLogin(IP, '{"auths": {"ghcr.io": ');
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    setLogin(IP, loginFile({ 'ghcr.io': { auth: Buffer.from('no-colon').toString('base64') } }));
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    setLogin(IP, loginFile({ 'ghcr.io': {} }));
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    // None of them printed anything but a ghcr.io login.
    expect(h.outputs.join('')).not.toContain(HUB_AUTH);
  });

  it('a server ssh cannot reach throws, saying nothing of a token', async () => {
    h.unreachable.set(IP, `root@${IP}: Permission denied (publickey).`);
    await expect(readGhcrLoginOnServer(IP, KEY)).rejects.toThrow(/Permission denied/);
  });

  it('each server is a store named for the server, read with the env key', async () => {
    setLogin(IP, withHub({ auth: auth('octo', TOKEN) }));
    const stores = serverStores(
      [
        { name: 'prod-primary', ip: IP },
        { name: 'prod-standby', ip: IP2 },
      ],
      KEY,
    );
    expect(stores.map((s) => s.name)).toEqual([
      "on prod-primary's server",
      "on prod-standby's server",
    ]);
    // Nothing is read until the resolver asks.
    expect(h.calls).toEqual([]);
    expect(await stores[0].read()).toEqual({ username: 'octo', token: TOKEN });
    expect(await stores[1].read()).toBeNull();
    expect(h.calls.every((c) => c.argv.includes(KEY) && c.secret === true)).toBe(true);
  });

  it('a store that cannot be read warns once, tries once, and holds nothing to reuse', async () => {
    // A timeout is transient: the default read would try three times, 5 s apart.
    h.unreachable.set(IP, `ssh: connect to host ${IP} port 22: Connection timed out`);
    const [store] = serverStores([{ name: 'prod-primary', ip: IP }], KEY);
    expect(await store.read()).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toBe(
      `could not read the token on prod-primary's server (ssh: connect to host ${IP} port 22: Connection timed out), so it is not reused.`,
    );
  });

  it('a changed operator IP stops the command, not just the read', async () => {
    // The guard runs on a transient ssh error. Its abort names the real cause;
    // a warning here would turn it into a GHCR_PULL_TOKEN refusal.
    h.unreachable.set(IP, `ssh: connect to host ${IP} port 22: Connection timed out`);
    h.ipGuard.mockRejectedValueOnce(
      Object.assign(new Error('Your public IP changed during this command'), {
        code: 'OPERATOR_IP_CHANGED',
      }),
    );
    const [store] = serverStores([{ name: 'prod-primary', ip: IP }], KEY);
    await expect(store.read()).rejects.toMatchObject({ code: 'OPERATOR_IP_CHANGED' });
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('a single server is named for its environment, each compose-ha side for its role', () => {
    expect(namedComposeServers('prod', [{ ip: IP, name: 'master' }])).toEqual([
      { name: 'prod', ip: IP },
    ]);
    expect(
      namedComposeServers('prod', [
        { ip: IP, role: 'primary' },
        { ip: IP2, role: 'standby' },
        { role: 'standby' },
        null,
      ]),
    ).toEqual([
      { name: 'prod-primary', ip: IP },
      { name: 'prod-standby', ip: IP2 },
    ]);
  });
});

describe('a compose-ha redeploy with one side down', () => {
  const NEW = `ghp_${'vcpullnewtoken'.padEnd(36, 'N')}`;
  // GitHub says the token has only read:packages; ghcr turns the anonymous
  // probe down and lets the token pull acme/shop.
  const fetcher = async (url: string, init: { headers?: Record<string, string> } = {}) => {
    const authz = init.headers?.Authorization ?? '';
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers });
    if (url === 'https://api.github.com/user') {
      return json(200, { login: 'octo' }, { 'x-oauth-scopes': 'read:packages' });
    }
    if (url.startsWith('https://ghcr.io/token?scope=repository:acme/shop:pull')) {
      return authz.startsWith('Basic ') ? json(200, { token: 'bearer' }) : json(401, {});
    }
    if (url === 'https://ghcr.io/v2/acme/shop/tags/list') return json(200, { tags: ['abc'] });
    throw new Error(`unexpected fetch ${url}`);
  };

  it('the side that cannot be read warns, and the resolve takes GHCR_PULL_TOKEN', async () => {
    h.unreachable.set(IP, `ssh: connect to host ${IP} port 22: No route to host`);
    setLogin(IP2, withHub());
    vi.stubEnv('GHCR_PULL_TOKEN', NEW);
    let pull: unknown;
    try {
      pull = await resolveGhcrPull({
        owner: 'acme',
        repo: 'shop',
        projectName: 'shop',
        envName: 'prod',
        stores: serverStores(
          namedComposeServers('prod', [
            { ip: IP, role: 'primary' },
            { ip: IP2, role: 'standby' },
          ]),
          KEY,
        ),
        keptAs: COMPOSE_KEPT_AS,
        where: COMPOSE_WHERE,
        isTTY: false,
        fetcher: fetcher as never,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(pull).toEqual({ mode: 'token', username: 'octo', token: NEW });
    expect(h.warn.mock.calls.map((c) => c[0])).toEqual([
      `could not read the token on prod-primary's server (ssh: connect to host ${IP} port 22: No route to host), so it is not reused.`,
    ]);
  });
});

describe('the removal python, run against a login file', () => {
  const file = join(DIR, 'removal.config.json');
  const extras = {
    credsStore: 'desktop',
    HttpHeaders: { 'User-Agent': 'vc' },
    proxies: { default: { httpProxy: 'http://proxy:3128' } },
  };

  it("drops only ghcr.io's entry: Docker Hub, credsStore, HttpHeaders and proxies stay, and so does mode 600", () => {
    writeFileSync(
      file,
      loginFile(
        { [DOCKER_HUB]: { auth: HUB_AUTH }, 'ghcr.io': { auth: auth('octo', TOKEN) } },
        extras,
      ),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    expect(runPython(ghcrLoginRemovalPython(file))).toBe('removed\n');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      auths: { [DOCKER_HUB]: { auth: HUB_AUTH } },
      ...extras,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Again: nothing left to drop, and the file is as it was.
    const before = readFileSync(file, 'utf-8');
    expect(runPython(ghcrLoginRemovalPython(file))).toBe('absent\n');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('no file: absent, and none is made', () => {
    rmSync(file, { force: true });
    expect(runPython(ghcrLoginRemovalPython(file))).toBe('absent\n');
    expect(existsSync(file)).toBe(false);
  });

  it('a body it cannot read that names ghcr.io fails loudly and is left as it was', () => {
    const broken = `{"auths": {"ghcr.io": {"auth": "${auth('octo', TOKEN)}"}`;
    writeFileSync(file, broken, { mode: 0o600 });
    let err: { status?: number; stderr?: string } | undefined;
    try {
      runPython(ghcrLoginRemovalPython(file));
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.status).toBe(1);
    expect(err?.stderr).toContain('names ghcr.io, so its login could not be removed');
    expect(err?.stderr).not.toContain(TOKEN);
    expect(readFileSync(file, 'utf-8')).toBe(broken);
  });

  it('a body it cannot read that does not name ghcr.io is absent, and left as it was', () => {
    writeFileSync(file, '{"auths": ', { mode: 0o600 });
    expect(runPython(ghcrLoginRemovalPython(file))).toBe('absent\n');
    expect(readFileSync(file, 'utf-8')).toBe('{"auths": ');
  });

  it('the script that ships runs that same python, under python3 -I, on stdin', () => {
    const script = ghcrLoginRemovalScript();
    expect(script).toContain(
      `python3 -I - <<'PY'\n${ghcrLoginRemovalPython('/root/.docker/config.json')}PY\n`,
    );
    // Docker Hub's entry is never named, and no login is read or written.
    expect(script).not.toContain('index.docker.io');
    expect(script).not.toContain('AUTH');
    expect(script.match(/del /g)).toHaveLength(1);
  });
});

describe('making a server login match the pull credential', () => {
  it('public and null remove only the ghcr.io entry', async () => {
    setLogin(IP, withHub({ auth: auth('octo', TOKEN) }));
    expect(await ensureGhcrLoginOn(IP, KEY, { mode: 'public' })).toBe('removed');
    expect(JSON.parse(loginText(IP))).toEqual({ auths: { [DOCKER_HUB]: { auth: HUB_AUTH } } });
    expect(await ensureGhcrLoginOn(IP, KEY, null)).toBe('absent');
    setLogin(IP, withHub({ auth: auth('octo', TOKEN) }));
    expect(await ensureGhcrLoginOn(IP, KEY, null)).toBe('removed');
    expect(JSON.parse(loginText(IP))).toEqual({ auths: { [DOCKER_HUB]: { auth: HUB_AUTH } } });
    expect(scripts().every((s) => s === ghcrLoginRemovalScript())).toBe(true);
  });

  it('a login file that names ghcr.io but cannot be read stops the step, saying why', async () => {
    setLogin(IP, '{"auths": {"ghcr.io": ');
    await expect(ensureGhcrLoginOn(IP, KEY, null)).rejects.toThrow(
      /names ghcr\.io, so its login could not be removed/,
    );
    expect(loginText(IP)).toBe('{"auths": {"ghcr.io": ');
  });

  it('the same pair is kept with no write', async () => {
    setLogin(IP, withHub({ auth: auth('octo', TOKEN) }));
    expect(
      await ensureGhcrLoginOn(IP, KEY, { mode: 'token', username: 'octo', token: TOKEN }),
    ).toBe('kept');
    expect(scripts()).toEqual([ghcrLoginReadScript()]);
  });

  it('a different pair is written through dockerLoginOnServer and never appears in argv', async () => {
    setLogin(IP, withHub({ auth: auth('octo', OTHER) }));
    expect(
      await ensureGhcrLoginOn(IP, KEY, { mode: 'token', username: 'octo', token: TOKEN }),
    ).toBe('stored');

    const [read, write, ...more] = scripts();
    expect(read).toBe(ghcrLoginReadScript());
    expect(more).toEqual([]);
    // dockerLoginOnServer's merge, for ghcr.io, with the new pair on stdin.
    expect(write).toContain(`HOST='ghcr.io' AUTH='${auth('octo', TOKEN)}' python3 -`);
    expect(write).not.toContain(TOKEN);
    // No argv here holds the token, its login pair, or the one it replaced.
    for (const secret of [TOKEN, auth('octo', TOKEN), OTHER, auth('octo', OTHER)]) {
      expect(allArgv()).not.toContain(secret);
    }
    // Nor on the server: the check that the write landed hands grep the pair
    // on its stdin, and a failed check never prints the file it holds.
    expect(write).not.toMatch(new RegExp(`grep[^\\n]*${auth('octo', TOKEN)}`));
    expect(write).not.toMatch(/cat "\$cfg"/);
  });

  it("the read-back fails loudly on a server ssh cannot reach: a deploy's own step does not skip it", async () => {
    h.unreachable.set(IP, `root@${IP}: Permission denied (publickey).`);
    await expect(
      ensureGhcrLoginOn(IP, KEY, { mode: 'token', username: 'octo', token: TOKEN }),
    ).rejects.toThrow(/Permission denied/);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('refuses anything but a resolved credential or null', async () => {
    await expect(
      ensureGhcrLoginOn(IP, KEY, { mode: 'token', username: 'octo' } as never),
    ).rejects.toThrow(TypeError);
    expect(h.calls).toEqual([]);
  });
});

describe('where a compose pull token lives, in the words the resolver uses', () => {
  it('is the server login file, readable by root there', () => {
    expect(COMPOSE_KEPT_AS).toBe("on the server in docker's login file");
    expect(COMPOSE_WHERE).toEqual({
      lives: COMPOSE_KEPT_AS,
      readers: 'anyone with root on the server',
      puller: 'the server',
    });
  });
});
