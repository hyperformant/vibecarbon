/**
 * Census: every compose server runs Docker's classic image store, from its
 * first pull on.
 *
 * Docker 29 made the containerd image store the default on a fresh install,
 * and that store's pull makes one attempt per layer: dockerd's
 * max-download-attempts (default 5) is read only by the classic store's pull.
 * Seven times from 2026-11-06 a fresh server's first pull failed with
 * `connection reset by peer` and a rerun worked, cause unknown, so compose
 * servers turn the containerd snapshotter off (decided 2026-11-09). The config
 * must be in place before dockerd first starts, or before the restart that
 * precedes the first pull: an image pulled into one store is hidden from the
 * other.
 *
 * Nothing here is a hand list of servers or files:
 *   (a) every file under src/, carbon/, docker/ and scripts/ that writes a
 *       Docker daemon config is found by the walk, and each one must be the
 *       config every compose server's user data carries. A second writer, or
 *       one this census cannot read, fails with what to do.
 *   (b) every compose program in src/lib/iac/programs/ runs (each provider SDK
 *       replaced by a recorder), and the user data each server-class resource
 *       is handed is checked. compose and compose-ha build their servers here.
 *   (c) every provider in the registry's replacement-server user data (what
 *       `vibecarbon scale` boots, getComposeUserData) is checked, and must be
 *       byte-identical to what its program hands its server.
 * For each user data: one daemon.json, written by write_files (cloud-init runs
 * those before runcmd), with the snapshotter off; nothing else configures
 * dockerd; and in runcmd the Docker install comes before the one restart,
 * which comes before the boot pull, any docker command and the ready marker
 * every deploy pull waits for.
 *
 * k8s nodes run no dockerd (k3s brings its own containerd), so the k8s
 * programs are out of scope here; (a) still fails if one of them grows a
 * Docker daemon config.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { resolveOutputs } from '../../_shared/pulumi-secrets.js';

const { created } = vi.hoisted(() => ({
  created: [] as Array<{ type: string; name: string; args: unknown; opts?: unknown }>,
}));

vi.mock('@pulumi/hcloud', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('hcloud', created),
);
vi.mock('@pulumi/digitalocean', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('digitalocean', created),
);
vi.mock('@ediri/vultr', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('vultr', created),
);
vi.mock('@pulumi/linode', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('linode', created),
);
vi.mock('@pulumiverse/scaleway', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('scaleway', created),
);

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DAEMON_JSON = '/etc/docker/daemon.json';

// ---------------------------------------------------------------------------
// (a) the writers
// ---------------------------------------------------------------------------

const WALK_ROOTS = ['src', 'carbon', 'docker', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const TEXT_FILE = /\.(js|mjs|cjs|ts|sh|ya?ml|json|conf|service|tpl|txt)$|(^|\/)Dockerfile[^/]*$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * The ways a file can configure a Docker daemon. Mentions in prose (a comment
 * naming daemon.json) are not writes; each form below is.
 */
const WRITE_FORMS: Array<[string, RegExp]> = [
  ['cloud-init write_files entry', /^\s*-?\s*path:\s*['"]?\/etc\/docker\/daemon\.json\b/m],
  [
    'shell write (redirect, tee, cp, mv, install, ln)',
    /(>>?\s*|\btee\b(\s+-a)?\s+|\b(cp|mv|install|ln)\b[^\n]*\s)['"]?\/etc\/docker\/daemon\.json\b/,
  ],
  ['JS file write', /\b(writeFile|writeFileSync|appendFile|appendFileSync)\([^)\n]*daemon\.json/],
  ['dockerd flags', /\bdockerd\b[^\n]*\s--(feature|config-file|storage-driver|data-root)\b/],
  ['docker.service drop-in', /docker\.service\.d\b/],
  ['the containerd-snapshotter feature', /containerd-snapshotter/],
];

function writeForms(text: string): string[] {
  return WRITE_FORMS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

const PRODUCTION_FILES = WALK_ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .map((f) => relative(ROOT, f))
  .filter((rel) => TEXT_FILE.test(rel) || basename(rel) === 'daemon.json');

const WRITERS = PRODUCTION_FILES.map((rel) => ({
  rel,
  forms:
    basename(rel) === 'daemon.json'
      ? ['a daemon.json file']
      : writeForms(readFileSync(join(ROOT, rel), 'utf-8')),
})).filter((w) => w.forms.length > 0);

type CloudConfig = {
  write_files?: Array<{ path?: string; content?: string; defer?: boolean; encoding?: string }>;
  runcmd?: Array<string | string[]>;
  bootcmd?: Array<string | string[]>;
};

/** The daemon.json write_files entries of a cloud-config text. */
function daemonWrites(text: string) {
  const cfg = (loadYaml(text) ?? {}) as CloudConfig;
  return (cfg.write_files ?? []).filter((f) => f.path === DAEMON_JSON);
}

// ---------------------------------------------------------------------------
// (b) + (c) the user data every compose server boots
// ---------------------------------------------------------------------------

const base = {
  projectName: 'p',
  environment: 'e',
  sshPublicKey: 'ssh-ed25519 AAAA',
  serverType: 'cx23',
  labels: {},
  allowedSshIps: ['203.0.113.7/32'],
};

/** A location each provider's program accepts; a new provider needs a row. */
const LOCATION: Record<string, string> = {
  hetzner: 'fsn1',
  digitalocean: 'nyc3',
  vultr: 'ewr',
  linode: 'us-east',
  scaleway: 'fr-par-1',
};

const PROGRAM_DIR = join(ROOT, 'src/lib/iac/programs');
const PROGRAM_FILES = readdirSync(PROGRAM_DIR).filter((f) => f.endsWith('.js'));
const COMPOSE_PROGRAMS = PROGRAM_FILES.filter((f) => f.endsWith('-compose.js')).sort();

/** The one cloud-config text inside a server's user-data input, decoded. */
function cloudConfigIn(value: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('#cloud-config')) found.push(v);
      else if (/^[A-Za-z0-9+/]+=*$/.test(v) && v.length > 64) {
        const decoded = Buffer.from(v, 'base64').toString('utf-8');
        if (decoded.startsWith('#cloud-config')) found.push(decoded);
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return found;
}

/** Each compose program's server user data, as `[label, text]`. */
async function programUserData(file: string): Promise<Array<[string, string]>> {
  const provider = file.replace(/-compose\.js$/, '');
  const mod = await import(`../../../src/lib/iac/programs/${provider}-compose.js`);
  const builders = Object.keys(mod).filter((k) => /^build\w*ComposeProgram$/.test(k));
  expect(builders, `${file} exports one build*ComposeProgram`).toHaveLength(1);
  expect(LOCATION[provider], `add a location for ${provider} to this census`).toBeTruthy();
  created.length = 0;
  await mod[builders[0]]({ ...base, location: LOCATION[provider] })();
  const servers = created.filter((r) => {
    const parts = r.type.split('.');
    const cls = parts.pop() as string;
    const [pkg, m = 'index'] = parts;
    return `${pkg}:${m}/${cls[0].toLowerCase()}${cls.slice(1)}:${cls}` in SERVER_RESOURCE_TYPES;
  });
  expect(servers.length, `${file} registered no server-class resource`).toBeGreaterThan(0);
  return Promise.all(
    servers.map(async (s) => {
      const texts = cloudConfigIn(await resolveOutputs(s.args));
      expect(texts, `${file}: server "${s.name}" carries one cloud-config`).toHaveLength(1);
      return [`${file} server "${s.name}"`, texts[0]] as [string, string];
    }),
  );
}

const step = (s: string | string[]) => (Array.isArray(s) ? s.join(' ') : String(s));

/** The rules a compose server's user data breaks; empty when it meets them all. */
function classicStoreViolations(text: string): string[] {
  const out: string[] = [];
  const cfg = (loadYaml(text) ?? {}) as CloudConfig;
  const files = cfg.write_files ?? [];

  const writes = files.filter((f) => f.path === DAEMON_JSON);
  if (writes.length !== 1) out.push(`${writes.length} write_files entries for ${DAEMON_JSON}`);
  for (const w of writes) {
    if (w.defer) out.push(`${DAEMON_JSON} is deferred, so it may land after Docker starts`);
    if (w.encoding) out.push(`${DAEMON_JSON} is ${w.encoding}-encoded; write it as plain JSON`);
    let daemon: { features?: Record<string, unknown> } = {};
    try {
      daemon = JSON.parse(w.content ?? '');
    } catch (err) {
      out.push(`${DAEMON_JSON} is not JSON: ${(err as Error).message}`);
    }
    if (daemon.features?.['containerd-snapshotter'] !== false) {
      out.push(
        `${DAEMON_JSON} does not set features.containerd-snapshotter to false ` +
          `(got ${JSON.stringify(daemon.features?.['containerd-snapshotter'])})`,
      );
    }
  }
  // Any other file that configures dockerd would override or fight this one.
  for (const f of files) {
    if (
      f.path !== DAEMON_JSON &&
      /\/etc\/docker\/|docker\.service\.d|\/etc\/default\/docker/.test(f.path ?? '')
    ) {
      out.push(`write_files also configures Docker at ${f.path}`);
    }
  }
  const runcmd = (cfg.runcmd ?? []).map(step);
  const bootcmd = (cfg.bootcmd ?? []).map(step);
  const configures = /daemon\.json|containerd-snapshotter|\bdockerd\b|docker\.service\.d/;
  for (const s of [...bootcmd, ...runcmd]) {
    if (configures.test(s)) out.push(`a command configures Docker outside write_files: ${s}`);
  }
  if (bootcmd.some((s) => /\bdocker\b/.test(s))) out.push('bootcmd runs Docker before the config');

  const install = runcmd.findIndex((s) => /apt-get\b.*\binstall\b.*\bdocker-ce\b/.test(s));
  const restarts = runcmd.filter((s) => /^systemctl (restart|stop|start) docker$/.test(s));
  const restart = runcmd.indexOf('systemctl restart docker');
  const firstUse = runcmd.findIndex((s) =>
    /boot-pull\.sh|\bdocker\s+(pull|run|compose|load|image|create)\b/.test(s),
  );
  const ready = runcmd.findIndex((s) => s.includes('/var/lib/vibecarbon/ready'));
  if (install === -1) out.push('runcmd installs no Docker');
  if (restart === -1) out.push('runcmd never restarts Docker');
  if (restarts.length !== 1) {
    out.push(`runcmd starts or stops Docker ${restarts.length} times: ${restarts.join(', ')}`);
  }
  if (install !== -1 && restart !== -1 && restart < install) {
    out.push('runcmd restarts Docker before installing it');
  }
  if (firstUse === -1) out.push('runcmd starts no boot pull (the order check would be vacuous)');
  if (firstUse !== -1 && restart !== -1 && firstUse < restart) {
    out.push(`runcmd uses Docker before the restart: ${runcmd[firstUse]}`);
  }
  if (ready === -1) out.push('runcmd writes no ready marker');
  if (ready !== -1 && restart !== -1 && ready < restart) {
    out.push('the ready marker the deploy waits on comes before the restart');
  }
  return out;
}

describe('(a) every Docker daemon config writer is the compose servers’ one', () => {
  it('the walk finds the writers (not vacuous)', () => {
    expect(PRODUCTION_FILES.length).toBeGreaterThan(100);
    expect(WRITERS.length).toBeGreaterThan(0);
  });

  it('each writer is a cloud-config whose daemon.json every compose server carries', async () => {
    const rendered = await Promise.all(
      Object.values(PROVIDERS).map(async (P) => (await P.getComposeUserData()) as string),
    );
    const carried = new Set(rendered.flatMap((t) => daemonWrites(t).map((w) => w.content)));
    expect(carried.size, 'every compose server carries the same daemon.json').toBe(1);
    for (const { rel, forms } of WRITERS) {
      const text = readFileSync(join(ROOT, rel), 'utf-8');
      const isCloudConfig = /\.ya?ml$/.test(rel) && forms.includes('cloud-init write_files entry');
      expect(
        isCloudConfig,
        `${rel} configures a Docker daemon (${forms.join(', ')}). Only a cloud-config the ` +
          'compose user data is rendered from may: put the config in ' +
          'carbon/cloud-init/docker-ce-setup.yaml, or teach this census to read the new writer ' +
          'and prove it turns the containerd snapshotter off before the first pull.',
      ).toBe(true);
      const writes = daemonWrites(text);
      expect(writes, `${rel}: one ${DAEMON_JSON} entry`).toHaveLength(1);
      expect(
        carried.has(writes[0].content),
        `${rel} writes a ${DAEMON_JSON} that no compose server carries, so nothing checks it`,
      ).toBe(true);
    }
  });

  it('detects every write form, and not prose (positive and negative controls)', () => {
    const writes = [
      '  - path: /etc/docker/daemon.json',
      "echo '{}' > /etc/docker/daemon.json",
      'printf x | tee -a /etc/docker/daemon.json',
      'cp ./d.json /etc/docker/daemon.json',
      "writeFileSync(join(dir, 'daemon.json'), s)",
      'dockerd --feature containerd-snapshotter=false',
      'mkdir -p /etc/systemd/system/docker.service.d',
      '{"features": {"containerd-snapshotter": true}}',
    ];
    for (const w of writes) expect(writeForms(w), w).not.toEqual([]);
    const prose = [
      '# the shared cloud-init writes /etc/docker/daemon.json in write_files',
      ' * reads /etc/docker/daemon.json on start',
      '// the containerd snapshotter is off',
    ];
    for (const p of prose) expect(writeForms(p), p).toEqual([]);
  });
});

describe('(b) every compose program hands its servers the classic store', () => {
  it('every program is a compose or a k8s program (a new kind needs a decision here)', () => {
    const other = PROGRAM_FILES.filter((f) => !/-(compose|k8s)\.js$/.test(f));
    expect(other).toEqual([]);
    expect(COMPOSE_PROGRAMS.length).toBeGreaterThan(0);
  });

  it.each(COMPOSE_PROGRAMS)('%s', async (file) => {
    for (const [label, text] of await programUserData(file)) {
      expect(classicStoreViolations(text), label).toEqual([]);
    }
  });
});

describe('(c) every provider’s replacement server (scale) gets the same user data', () => {
  it('every provider has a compose program', () => {
    expect(
      Object.keys(PROVIDERS)
        .map((p) => `${p}-compose.js`)
        .sort(),
    ).toEqual(COMPOSE_PROGRAMS);
  });

  it.each(Object.keys(PROVIDERS))('%s', async (id) => {
    const P = PROVIDERS[id as keyof typeof PROVIDERS];
    const text = (await P.getComposeUserData()) as string;
    expect(classicStoreViolations(text), `${id} getComposeUserData`).toEqual([]);
    for (const [label, programText] of await programUserData(`${id}-compose.js`)) {
      expect(programText, `${label} matches ${id} getComposeUserData`).toBe(text);
    }
  });
});

describe('the rules reject each way to break them (controls)', () => {
  it('the real user data passes and each mutation of it fails', async () => {
    const text = (await PROVIDERS.hetzner.getComposeUserData()) as string;
    expect(classicStoreViolations(text)).toEqual([]);
    const restart = '  - [systemctl, restart, docker]\n';
    const reload = '  - [systemctl, reload, ssh]\n';
    const entry = `  - path: ${DAEMON_JSON}\n`;
    const mutations: Array<[string, string]> = [
      [
        'snapshotter on',
        text.replace('"containerd-snapshotter": false', '"containerd-snapshotter": true'),
      ],
      [
        'features gone',
        text.replace(/,\n\s*"features": \{\n\s*"containerd-snapshotter": false\n\s*\}/, ''),
      ],
      ['deferred', text.replace(entry, `${entry}    defer: true\n`)],
      ['restart after the boot pull', text.replace(restart, '').replace(reload, reload + restart)],
      [
        'a runcmd config write',
        text.replace(restart, `  - [sh, -c, 'echo {} > ${DAEMON_JSON}']\n${restart}`),
      ],
      ['no restart', text.replace(restart, '')],
    ];
    for (const [name, mutated] of mutations) {
      expect(mutated, `${name}: the mutation applied`).not.toBe(text);
      expect(classicStoreViolations(mutated), name).not.toEqual([]);
    }
  });
});
