/**
 * A compose server's ghcr.io login (src/lib/deploy/compose/ghcr-login.js): the
 * `ghcr.io` entry of its /root/.docker/config.json. It holds the read:packages
 * pull token for a private app image, or is not there at all. Docker Hub's
 * entry beside it is never touched.
 *
 * ssh is faked one level down, at runCommandAsync, so the real sshRunAsync and
 * the real dockerLoginOnServer run: what reaches the fake is exactly the argv
 * and the stdin a server would get.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ argv: string[]; input?: string }>,
  /** Each server's docker login file as `cat` prints it; a server not here has none. */
  configs: {} as Record<string, string>,
  /** What the removal script prints on each server. */
  removal: {} as Record<string, string>,
  unreachable: new Set<string>(),
}));

vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommandAsync: vi.fn(async (argv: string[], opts: { input?: string } = {}) => {
    h.calls.push({ argv, input: opts.input });
    const ip = argv.find((a) => a.startsWith('root@'))?.slice('root@'.length) ?? '';
    if (h.unreachable.has(ip)) {
      const stderr = `root@${ip}: Permission denied (publickey).`;
      throw Object.assign(new Error(`Command failed: ssh root@${ip}\n${stderr}`), {
        status: 255,
        stderr,
      });
    }
    const command = argv.at(-1) ?? '';
    if (/^cat \/root\/\.docker\/config\.json\b/.test(command)) return h.configs[ip] ?? '';
    if (command === '/bin/bash -s') {
      // dockerLoginOnServer's write prints nothing; the removal says what it did.
      return opts.input?.includes('AUTH=') ? '' : (h.removal[ip] ?? 'absent\n');
    }
    throw new Error(`unexpected command on ${ip}: ${command}`);
  }),
}));

const {
  COMPOSE_KEPT_AS,
  COMPOSE_WHERE,
  ensureGhcrLoginOn,
  namedComposeServers,
  readGhcrLoginOnServer,
  serverStores,
} = await import('../../../src/lib/deploy/compose/ghcr-login.js');

const IP = '203.0.113.5';
const KEY = '/project/.vibecarbon/deploy_key_prod';
const DOCKER_HUB = 'https://index.docker.io/v1/';

/** A classic token's shape: ghp_ and 36 more. Distinct enough to grep for. */
const TOKEN = `ghp_${'vcpullsentinel'.padEnd(36, 'Q')}`;
const OTHER = `ghp_${'vcpullother'.padEnd(36, 'Z')}`;
const HUB_TOKEN = 'dckr_pat_vchubsentinel';

const auth = (user: string, token: string) => Buffer.from(`${user}:${token}`).toString('base64');
const loginFile = (auths: Record<string, { auth: string }>) => JSON.stringify({ auths });
const withHub = (ghcr?: { auth: string }) =>
  loginFile({
    [DOCKER_HUB]: { auth: auth('hubuser', HUB_TOKEN) },
    ...(ghcr && { 'ghcr.io': ghcr }),
  });

/** The scripts sent on ssh's stdin. */
const scripts = () => h.calls.flatMap((c) => (c.input === undefined ? [] : [c.input]));
/** Every argv element of every command this file ran, one string. */
const allArgv = () => h.calls.flatMap((c) => c.argv).join('\n');

beforeEach(() => {
  h.calls.length = 0;
  h.configs = {};
  h.removal = {};
  h.unreachable.clear();
});

describe('reading a server login back', () => {
  it('reads the ghcr.io pair back, and nothing else', async () => {
    h.configs[IP] = withHub({ auth: auth('octo', TOKEN) });
    expect(await readGhcrLoginOnServer(IP, KEY)).toEqual({ username: 'octo', token: TOKEN });
    // One read, no script: reading changes nothing on the server.
    expect(h.calls).toHaveLength(1);
    expect(scripts()).toEqual([]);
  });

  it('missing file, missing entry, malformed json: null', async () => {
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    h.configs[IP] = withHub();
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    h.configs[IP] = '{"auths": {"ghcr.io": ';
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    h.configs[IP] = loginFile({ 'ghcr.io': { auth: Buffer.from('no-colon').toString('base64') } });
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
    h.configs[IP] = JSON.stringify({ auths: { 'ghcr.io': {} } });
    expect(await readGhcrLoginOnServer(IP, KEY)).toBeNull();
  });

  it('a server ssh cannot reach throws, saying nothing of a token', async () => {
    h.unreachable.add(IP);
    await expect(readGhcrLoginOnServer(IP, KEY)).rejects.toThrow(/Permission denied/);
  });

  it('each server is a store named for the server, read with the env key', async () => {
    h.configs[IP] = withHub({ auth: auth('octo', TOKEN) });
    const stores = serverStores(
      [
        { name: 'prod-primary', ip: IP },
        { name: 'prod-standby', ip: '203.0.113.6' },
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
    expect(h.calls.every((c) => c.argv.includes(KEY))).toBe(true);
  });

  it('a single server is named for its environment, each compose-ha side for its role', () => {
    expect(namedComposeServers('prod', [{ ip: IP, name: 'master' }])).toEqual([
      { name: 'prod', ip: IP },
    ]);
    expect(
      namedComposeServers('prod', [
        { ip: IP, role: 'primary' },
        { ip: '203.0.113.6', role: 'standby' },
        { role: 'standby' },
        null,
      ]),
    ).toEqual([
      { name: 'prod-primary', ip: IP },
      { name: 'prod-standby', ip: '203.0.113.6' },
    ]);
  });
});

describe('making a server login match the pull credential', () => {
  it('public and null remove only the ghcr.io entry', async () => {
    h.removal[IP] = 'removed\n';
    expect(await ensureGhcrLoginOn(IP, KEY, { mode: 'public' })).toBe('removed');
    expect(await ensureGhcrLoginOn(IP, KEY, null)).toBe('removed');
    h.removal[IP] = 'absent\n';
    expect(await ensureGhcrLoginOn(IP, KEY, null)).toBe('absent');

    const sent = scripts();
    expect(sent).toHaveLength(3);
    for (const script of sent) {
      // The one key it names is ghcr.io's, and python deletes only that key
      // and writes the rest of the same object back.
      expect(script).toContain("HOST='ghcr.io' python3 -I - <<'PY'");
      expect(script).toContain("del auths[os.environ['HOST']]");
      expect(script).toContain('json.dump(cfg, f)');
      expect(script.match(/del /g)).toHaveLength(1);
      // Docker Hub's entry is never named, popped or overwritten.
      expect(script).not.toContain('index.docker.io');
      expect(script).not.toMatch(/\.pop\(|\.clear\(|echo '\{\}'|printf '\{/);
      // It reads no token and writes none.
      expect(script).not.toContain('AUTH');
    }
  });

  it('the same pair is kept with no write', async () => {
    h.configs[IP] = withHub({ auth: auth('octo', TOKEN) });
    expect(
      await ensureGhcrLoginOn(IP, KEY, { mode: 'token', username: 'octo', token: TOKEN }),
    ).toBe('kept');
    expect(scripts()).toEqual([]);
  });

  it('a different pair is written through dockerLoginOnServer and never appears in argv', async () => {
    h.configs[IP] = withHub({ auth: auth('octo', OTHER) });
    expect(
      await ensureGhcrLoginOn(IP, KEY, { mode: 'token', username: 'octo', token: TOKEN }),
    ).toBe('stored');

    const [write, ...more] = scripts();
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
      lives: "on the server in docker's login file",
      readers: 'anyone with root on the server',
      puller: 'the server',
    });
  });
});
