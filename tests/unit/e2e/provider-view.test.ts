/**
 * The provider's view of every server of a scenario, in the failure bundle
 * (tests/e2e/utils/provider-view.ts).
 *
 * WHY (CI run 45994716507, vultr/k8s, step scale, 2026-11-27): `scale` resized
 * three nodes in place; worker-1 went NotReady two minutes in and was still
 * NotReady 57 minutes later, and the step read only `Scale exited with code 1.`
 * The bundle held kubectl state and ssh into the master and db, nothing of what
 * Vultr said about the worker (still resizing? server_status locked? old plan?).
 * The rig is destroyed at teardown, so that view is read in the bundle or never.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';
import {
  collectProviderView,
  PROVIDER_VIEW_BOUND_MS,
  type ProviderViewProvider,
} from '../../e2e/utils/provider-view.js';
import {
  hetznerServerLabels,
  hetznerServerSelectorQuery,
  sweepOwnsServer,
} from '../../e2e/utils/sweep-core.js';

const PROJECT = 'citest-abc123';

type Item = { id: number | string; name?: string; label?: string } & Record<string, unknown>;

function view(id: number | string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    status: 'ok',
    detail: 'power running, subscription active',
    created: '2026-11-27T10:00:00Z',
    location: 'ewr',
    plan: 'vc2-4c-8gb',
    publicIp: '203.0.113.7',
    privateIp: '10.20.0.4',
    events: [],
    eventsNote: 'no event history',
    ...extra,
  };
}

function fakeProvider(opts: {
  items: Item[];
  complete?: boolean;
  listThrows?: boolean;
  describe?: (id: number | string) => Promise<unknown>;
}): ProviderViewProvider & { listedWith: Array<Record<string, string> | undefined> } {
  const listedWith: Array<Record<string, string> | undefined> = [];
  return {
    listedWith,
    async listServersDetailed(labels?: Record<string, string>) {
      listedWith.push(labels);
      if (opts.listThrows) throw new Error('connect ECONNRESET api.example');
      return { items: opts.items, complete: opts.complete ?? true };
    },
    async describeServerForDiagnosis(id: number | string) {
      if (opts.describe) return opts.describe(id) as never;
      const it = opts.items.find((i) => i.id === id);
      return view(id, String(it?.label ?? it?.name)) as never;
    },
  };
}

describe('collectProviderView', () => {
  it('lists only this project servers, one line per server, labelled by the section', async () => {
    const provider = fakeProvider({
      items: [
        { id: 1, label: `${PROJECT}-master` },
        { id: 2, label: `${PROJECT}-worker-1` },
        { id: 3, label: 'someone-elses-box' },
      ],
    });
    const [label, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
    });
    expect(label).toBe(`provider view: servers of ${PROJECT}`);
    expect(text).toContain(`${PROJECT}-master`);
    expect(text).toContain(`${PROJECT}-worker-1`);
    expect(text).not.toContain('someone-elses-box');
    const serverLines = text.split('\n').filter((l) => l.includes(`${PROJECT}-`));
    expect(serverLines).toHaveLength(2);
  });

  it("carries the view's named fields on the server's line", async () => {
    const provider = fakeProvider({ items: [{ id: 'abc-1', label: `${PROJECT}-worker-1` }] });
    const [, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
    });
    for (const part of [
      'abc-1',
      'status ok',
      'power running, subscription active',
      'vc2-4c-8gb',
      'ewr',
      '2026-11-27T10:00:00Z',
      '203.0.113.7',
      '10.20.0.4',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('never lets raw JSON or a secret field reach the text', async () => {
    const provider = fakeProvider({
      items: [
        {
          id: 1,
          label: `${PROJECT}-master`,
          default_password: 'hunter2-listing',
          kvm: 'https://my.vultr.com/kvm/?token=KVMSECRET',
        },
      ],
      describe: async (id) =>
        view(id, `${PROJECT}-master`, {
          default_password: 'hunter2-view',
          kvm: 'https://my.vultr.com/kvm/?token=KVMSECRET2',
          raw: { default_password: 'hunter2-raw' },
        }),
    });
    const [, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
    });
    expect(text).not.toMatch(/hunter2|KVMSECRET|default_password|kvm/);
    expect(text).not.toContain('{');
  });

  it('writes events and notes as named fields, redacted', async () => {
    const provider = fakeProvider({
      items: [{ id: 1, name: `${PROJECT}-db` }],
      describe: async (id) =>
        view(id, `${PROJECT}-db`, {
          events: [
            {
              action: 'create_server',
              status: 'error',
              started: null,
              finished: null,
              error: 'quota',
            },
          ],
          eventsNote: undefined,
          eventsError: 'Authorization: Bearer abcdef0123456789abcdef',
        }),
    });
    const [, text] = await collectProviderView({
      provider,
      providerId: 'hetzner',
      projectName: PROJECT,
    });
    expect(text).toContain('create_server');
    expect(text).toContain('quota');
    expect(text).not.toContain('abcdef0123456789abcdef');
  });

  it('turns a listing that throws into one line, without throwing', async () => {
    const provider = fakeProvider({ items: [], listThrows: true });
    const [, text] = await collectProviderView({
      provider,
      providerId: 'linode',
      projectName: PROJECT,
    });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('could not list');
    expect(text).toContain('ECONNRESET');
  });

  it('says so, in one line, when the listing is incomplete, and still reads what it has', async () => {
    const provider = fakeProvider({
      items: [{ id: 1, label: `${PROJECT}-master` }],
      complete: false,
    });
    const [, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
    });
    expect(text.split('\n').filter((l) => l.includes('incomplete'))).toHaveLength(1);
    expect(text).toContain(`${PROJECT}-master`);
  });

  it('gives a server whose read fails one line, and keeps the others', async () => {
    const provider = fakeProvider({
      items: [
        { id: 1, label: `${PROJECT}-master` },
        { id: 2, label: `${PROJECT}-worker-1` },
      ],
      describe: async (id) => {
        if (id === 2) throw new Error('describe 500');
        return view(id, `${PROJECT}-master`);
      },
    });
    const [, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
    });
    expect(text).toContain('status ok');
    const bad = text.split('\n').filter((l) => l.includes(`${PROJECT}-worker-1`));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('describe 500');
  });

  it('cuts a describe that hangs at the bound and names the server', async () => {
    const provider = fakeProvider({
      items: [
        { id: 1, label: `${PROJECT}-master` },
        { id: 2, label: `${PROJECT}-worker-1` },
      ],
      describe: (id) =>
        id === 2 ? new Promise(() => {}) : Promise.resolve(view(id, `${PROJECT}-master`)),
    });
    const t0 = Date.now();
    const [, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
      boundMs: 60,
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(text).toContain('status ok');
    const hung = text.split('\n').filter((l) => l.includes(`${PROJECT}-worker-1`));
    expect(hung).toHaveLength(1);
    expect(hung[0]).toContain('not read');
  });

  it('cuts a listing that hangs at the bound', async () => {
    const provider: ProviderViewProvider = {
      listServersDetailed: () => new Promise(() => {}),
      describeServerForDiagnosis: async () => view(1, 'x') as never,
    };
    const [, text] = await collectProviderView({
      provider,
      providerId: 'vultr',
      projectName: PROJECT,
      boundMs: 40,
    });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('could not list');
  });

  it('turns a provider that cannot be built into one line', async () => {
    const [, text] = await collectProviderView({
      provider: () => {
        throw new Error('no token for vultr');
      },
      providerId: 'vultr',
      projectName: PROJECT,
    });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('no token for vultr');
  });

  it('refuses a project name too short to own anything', async () => {
    const provider = fakeProvider({ items: [{ id: 1, label: 'anything' }] });
    const [, text] = await collectProviderView({ provider, providerId: 'vultr', projectName: '' });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('refusing');
  });

  it('is bounded at about 30 s by default', () => {
    expect(PROVIDER_VIEW_BOUND_MS).toBe(30_000);
  });
});

describe('ownership is the sweeps', () => {
  it('Hetzner lists by the project label the sweep selects on', async () => {
    const provider = fakeProvider({ items: [{ id: 1, name: `${PROJECT}-master` }] });
    await collectProviderView({ provider, providerId: 'hetzner', projectName: PROJECT });
    expect(provider.listedWith).toEqual([hetznerServerLabels(PROJECT)]);
    expect(hetznerServerSelectorQuery(PROJECT)).toBe(
      `label_selector=${encodeURIComponent(`project=${PROJECT}`)}`,
    );
  });

  it('the other clouds own a server by prefix on its name or label', () => {
    expect(sweepOwnsServer({ label: `${PROJECT}-x` }, PROJECT)).toBe(true);
    expect(sweepOwnsServer({ name: `${PROJECT}-x` }, PROJECT)).toBe(true);
    expect(sweepOwnsServer({ name: `other-${PROJECT}` }, PROJECT)).toBe(false);
  });

  it('the sweeps use that one rule, not their own copy', () => {
    for (const cloud of ['digitalocean', 'linode', 'scaleway', 'vultr']) {
      const src = readFileSync(join(__dirname, `../../e2e/utils/sweep-${cloud}.ts`), 'utf8');
      expect(src, cloud).toContain('sweepOwnsServer(');
    }
    const hz = readFileSync(join(__dirname, '../../e2e/utils/sweep-hetzner.ts'), 'utf8');
    expect(hz).toContain('hetznerServerSelectorQuery(');
  });
});

describe('every registered e2e provider gets the section', () => {
  // The shape of each cloud's server listing: the field that carries its name.
  const NAME_FIELD: Record<string, 'name' | 'label'> = {
    hetzner: 'name',
    digitalocean: 'name',
    linode: 'label',
    vultr: 'label',
    scaleway: 'name',
  };
  const ids = Object.keys(testConfig.e2e.providers);

  it('knows every registered provider', () => {
    expect(Object.keys(NAME_FIELD).sort()).toEqual([...ids].sort());
  });

  for (const id of ids) {
    it(`${id}: lists this project's servers only and reads each one`, async () => {
      const field = NAME_FIELD[id];
      const mine = { id: 11, [field]: `${PROJECT}-worker-1` } as Item;
      const other = { id: 12, [field]: 'unrelated-server' } as Item;
      const all = [mine, other];
      const base = fakeProvider({ items: all });
      // Hetzner filters on the label server-side, as its API does.
      const provider: ProviderViewProvider = {
        ...base,
        async listServersDetailed(labels?: Record<string, string>) {
          return { items: labels?.project ? [mine] : all, complete: true };
        },
        describeServerForDiagnosis: base.describeServerForDiagnosis,
      };
      const [label, text] = await collectProviderView({
        provider,
        providerId: id,
        projectName: PROJECT,
      });
      expect(label).toBe(`provider view: servers of ${PROJECT}`);
      expect(text).toContain(`${PROJECT}-worker-1`);
      expect(text).toContain('status ok');
      expect(text).not.toContain('unrelated-server');
    });
  }

  it('the failure-bundle writer runs it for every mode and provider', () => {
    const src = readFileSync(join(__dirname, '../../e2e/scenarios/_run-lifecycle.ts'), 'utf8');
    const start = src.indexOf('async function captureFailureDiagnostics');
    const end = src.indexOf('Failure diagnostics written to');
    const body = src.slice(start, end);
    // At the function's own indent: not inside the k8s-only or compose-only branches.
    expect(body).toMatch(/\n {2}sections\.push\(\s*await collectProviderView\(/);
  });
});
