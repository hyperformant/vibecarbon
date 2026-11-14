import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ProbeResult,
  type RecordedResource,
  recordedResources,
  type StateStoreApi,
  sweepRunStacks,
} from '../../e2e/utils/sweep-run-stacks.ts';

const stackFile = (resources: unknown[] | undefined) => ({
  version: 3,
  checkpoint: { stack: 'organization/p/s', latest: resources ? { resources } : undefined },
});
const srv = (id: string) => ({ type: 'hcloud:index/server:Server', id, urn: `urn:${id}` });

interface Fake {
  store: StateStoreApi;
  files: Map<string, unknown>;
  removed: string[];
  calls: string[];
}

function fake(files: Record<string, unknown>, extraKeys: string[] = []): Fake {
  const map = new Map(Object.entries(files));
  const keys = [...map.keys(), ...extraKeys];
  const removed: string[] = [];
  const calls: string[] = [];
  const store: StateStoreApi = {
    async list(prefix) {
      calls.push(`list ${prefix}`);
      return { keys: keys.filter((k) => k.startsWith(prefix)), complete: true };
    },
    async read(key) {
      calls.push(`read ${key}`);
      return map.has(key) ? map.get(key) : null;
    },
    async remove(ks) {
      calls.push(`remove ${ks.join(',')}`);
      removed.push(...ks);
      return ks;
    },
  };
  return { store, files: map, removed, calls };
}

const owns = (p: string) => p === 'p';
const allGone = async (): Promise<ProbeResult> => 'gone';
const STACK = '.pulumi/stacks/p/s.json';
const BAK = '.pulumi/stacks/p/s.json.bak';
const HIST = ['.pulumi/history/p/s/s-1.history.json', '.pulumi/history/p/s/s-1.checkpoint.json'];
const LOCK = ['.pulumi/locks/organization/p/s/abc.json'];

describe('recordedResources', () => {
  it('reads checkpoint.latest.resources, dropping pulumi:* types and resources without an id', () => {
    const out = recordedResources(
      stackFile([
        { type: 'pulumi:pulumi:Stack', id: 'x' },
        { type: 'pulumi:providers:hcloud', id: 'y' },
        { type: 'hcloud:index/server:Server' },
        srv('1'),
      ]),
    );
    expect(out.map((r) => r.id)).toEqual(['1']);
  });
  it('treats an absent latest, or anything unexpected, as zero resources', () => {
    expect(recordedResources(stackFile(undefined))).toEqual([]);
    expect(recordedResources(null)).toEqual([]);
    expect(recordedResources('x')).toEqual([]);
  });
});

describe('sweepRunStacks', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('deletes a stack, its backup, history and lock once every recorded resource reads 404', async () => {
    const f = fake({ [STACK]: stackFile([srv('1'), srv('2')]), [BAK]: stackFile([]) }, [
      ...HIST,
      ...LOCK,
      '.pulumi/history/p/s-other/x.json',
    ]);
    const r = await sweepRunStacks('T', owns, f.store, allGone);
    expect(r.deleted).toEqual(['p/s']);
    expect(r.kept).toEqual([]);
    expect([...f.removed].sort()).toEqual([STACK, BAK, ...HIST, ...LOCK].sort());
  });

  it('counts a stack with zero resources as gone', async () => {
    const f = fake({ [STACK]: stackFile(undefined) });
    const probe = vi.fn(allGone);
    const r = await sweepRunStacks('T', owns, f.store, probe);
    expect(r.deleted).toEqual(['p/s']);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps a stack while any recorded resource still answers', async () => {
    const f = fake({ [STACK]: stackFile([srv('1'), srv('2')]) });
    const r = await sweepRunStacks('T', owns, f.store, async (res: RecordedResource) =>
      res.id === '2' ? 'present' : 'gone',
    );
    expect(r).toEqual({ deleted: [], kept: ['p/s'] });
    expect(f.removed).toEqual([]);
  });

  it('keeps a stack whose resource type has no probe (unknown)', async () => {
    const f = fake({ [STACK]: stackFile([srv('1')]) });
    const r = await sweepRunStacks('T', owns, f.store, async () => 'unknown');
    expect(r.kept).toEqual(['p/s']);
    expect(f.removed).toEqual([]);
  });

  it('keeps a stack whose file cannot be read', async () => {
    const f = fake({}, [STACK]);
    const r = await sweepRunStacks('T', owns, f.store, allGone);
    expect(r).toEqual({ deleted: [], kept: ['p/s'] });
    expect(f.removed).toEqual([]);
  });

  it('decides on an orphan .bak when the stack file is gone', async () => {
    const f = fake({ [BAK]: stackFile([srv('1')]) });
    const probe = vi.fn(allGone);
    const r = await sweepRunStacks('T', owns, f.store, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(r.deleted).toEqual(['p/s']);
    expect(f.removed).toEqual([BAK]);
  });

  it('prefers the stack file over the backup when both exist', async () => {
    const f = fake({ [STACK]: stackFile([srv('1')]), [BAK]: stackFile([srv('2')]) });
    const seen: string[] = [];
    await sweepRunStacks('T', owns, f.store, async (res) => {
      seen.push(res.id);
      return 'gone';
    });
    expect(seen).toEqual(['1']);
  });

  it('touches only owned projects', async () => {
    const f = fake({
      [STACK]: stackFile([srv('1')]),
      '.pulumi/stacks/other/s.json': stackFile([srv('9')]),
    });
    const r = await sweepRunStacks('T', owns, f.store, allGone);
    expect(r.deleted).toEqual(['p/s']);
    expect(f.removed.every((k) => !k.includes('other'))).toBe(true);
    expect(f.calls.some((c) => c.includes('other/s.json'))).toBe(false);
  });

  it('reads each stack just before deciding, not from the listing', async () => {
    const f = fake({ [STACK]: stackFile([srv('1')]) }, HIST);
    await sweepRunStacks('T', owns, f.store, async () => {
      f.calls.push('probe');
      return 'gone';
    });
    const iRead = f.calls.indexOf(`read ${STACK}`);
    const iProbe = f.calls.indexOf('probe');
    const iRemove = f.calls.findIndex((c) => c.startsWith('remove'));
    expect(iRead).toBeGreaterThan(-1);
    expect(iRead).toBeLessThan(iProbe);
    expect(iProbe).toBeLessThan(iRemove);
  });

  it('removes the stack file last, so a half-finished delete is found again', async () => {
    const f = fake({ [STACK]: stackFile([]) }, HIST);
    await sweepRunStacks('T', owns, f.store, allGone);
    expect(f.removed[f.removed.length - 1]).toBe(STACK);
  });

  it('keeps the stack when a remove leaves keys behind', async () => {
    const f = fake({ [STACK]: stackFile([]) }, HIST);
    f.store.remove = async (ks) => ks.filter((k) => !k.includes('history'));
    const r = await sweepRunStacks('T', owns, f.store, allGone);
    expect(r).toEqual({ deleted: [], kept: ['p/s'] });
  });

  it('keeps stacks when the history listing is incomplete', async () => {
    const f = fake({ [STACK]: stackFile([]) });
    const list = f.store.list;
    f.store.list = async (p) =>
      p.startsWith('.pulumi/history') ? { keys: [], complete: false } : list(p);
    const r = await sweepRunStacks('T', owns, f.store, allGone);
    expect(r.kept).toEqual(['p/s']);
    expect(f.removed).toEqual([]);
  });

  it('runs at most 4 probes at a time', async () => {
    const f = fake({ [STACK]: stackFile(Array.from({ length: 12 }, (_, i) => srv(String(i)))) });
    let active = 0;
    let peak = 0;
    await sweepRunStacks('T', owns, f.store, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return 'gone';
    });
    expect(peak).toBe(4);
  });

  it('never throws: a failing list, read, probe or remove is a warning', async () => {
    const boom = async () => {
      throw new Error('boom');
    };
    const mk = () => fake({ [STACK]: stackFile([srv('1')]) });

    const a = mk();
    a.store.list = boom;
    await expect(sweepRunStacks('T', owns, a.store, allGone)).resolves.toEqual({
      deleted: [],
      kept: [],
    });

    const b = mk();
    b.store.read = boom;
    await expect(sweepRunStacks('T', owns, b.store, allGone)).resolves.toEqual({
      deleted: [],
      kept: ['p/s'],
    });

    const c = mk();
    await expect(sweepRunStacks('T', owns, c.store, boom)).resolves.toEqual({
      deleted: [],
      kept: ['p/s'],
    });

    const d = mk();
    d.store.remove = boom;
    await expect(sweepRunStacks('T', owns, d.store, allGone)).resolves.toEqual({
      deleted: [],
      kept: ['p/s'],
    });
    expect(warn).toHaveBeenCalled();
  });
});
