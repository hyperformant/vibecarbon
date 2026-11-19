/**
 * tests/_shared/teardown-provider.ts: the Proxy provider the destroy tests
 * run destroy's real teardown effects against. Each rule it answers by, and
 * the order they are tried in, is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { teardownProvider } from '../../_shared/teardown-provider.js';

type Fake = Record<string, unknown>;
const call = (p: Fake, name: string, ...args: unknown[]) =>
  (p[name] as (...a: unknown[]) => unknown)(...args);

const deletedFor = (method: string, ...args: unknown[]) => ({ method, args });

describe('teardownProvider', () => {
  it('answers undefined for `then` and symbols, so awaiting it resolves to itself', async () => {
    const p = teardownProvider({ deleted: deletedFor }) as Fake;
    expect(p.then).toBeUndefined();
    expect((p as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect(await p).toBe(p);
  });

  it('answers `constructor` with ctor when given, and like any other name when not', () => {
    function Ctor() {}
    expect((teardownProvider({ ctor: Ctor, deleted: deletedFor }) as Fake).constructor).toBe(Ctor);
    const bare = (teardownProvider({ deleted: deletedFor }) as Fake).constructor;
    expect(bare).not.toBe(Ctor);
    expect(typeof bare === 'function' && bare()).toBeUndefined();
  });

  it('answers a method it is given as given, ahead of every pattern, and an undefined one as absent', async () => {
    const listServers = async () => ['s1'];
    const p = teardownProvider({
      methods: { listServers, deleteServer: undefined, serverNetworkIds: () => ['n1'] },
      serverIdsEmpty: true,
      deleted: deletedFor,
    }) as Fake;
    expect(p.listServers).toBe(listServers);
    expect(p.deleteServer).toBeUndefined();
    expect(call(p, 'serverNetworkIds')).toEqual(['n1']);
  });

  it('reads only the own keys of methods', () => {
    const p = teardownProvider({ methods: {}, deleted: deletedFor }) as Fake;
    expect(call(p, 'toString')).toBeUndefined();
    expect(call(p, 'hasOwnProperty', 'x')).toBeUndefined();
  });

  it('answers the server id readers with [] only when serverIdsEmpty is set', () => {
    const on = teardownProvider({ serverIdsEmpty: true, deleted: deletedFor }) as Fake;
    expect(call(on, 'serverNetworkIds')).toEqual([]);
    expect(call(on, 'serverVolumeIds')).toEqual([]);
    const off = teardownProvider({ deleted: deletedFor }) as Fake;
    expect(call(off, 'serverNetworkIds')).toBeUndefined();
    expect(call(off, 'serverVolumeIds')).toBeUndefined();
  });

  it('answers a delete-like method asynchronously with deleted(name, ...args), fresh each call', async () => {
    const p = teardownProvider({ deleted: deletedFor }) as Fake;
    for (const name of [
      'deleteServer',
      'removeStack',
      'destroyCluster',
      'detachVolume',
      'releaseIp',
    ]) {
      const answer = call(p, name, 7, 'x');
      expect(answer).toBeInstanceOf(Promise);
      expect(await answer).toEqual({ method: name, args: [7, 'x'] });
    }
    expect(await call(p, 'deleteServer')).not.toBe(await call(p, 'deleteServer'));
  });

  it('takes its own delete verbs: a name they leave out falls through to a no-op', async () => {
    const p = teardownProvider({
      deleteVerbs: /^(delete|remove|destroy|release)/,
      deleted: deletedFor,
    }) as Fake;
    expect(call(p, 'detachVolume')).toBeUndefined();
    expect(await call(p, 'deleteServer')).toEqual({ method: 'deleteServer', args: [] });
  });

  it('answers list, find and get with an async []', async () => {
    const p = teardownProvider({ deleted: deletedFor }) as Fake;
    for (const name of ['listServers', 'findServersByLabel', 'getZones']) {
      const answer = call(p, name);
      expect(answer).toBeInstanceOf(Promise);
      expect(await answer).toEqual([]);
    }
  });

  it('answers any other name with a method that does nothing', () => {
    const p = teardownProvider({ deleted: deletedFor }) as Fake;
    expect(call(p, 'serverLabels', {})).toBeUndefined();
    expect(call(p, 'reservedIpLabelMatch')).toBeUndefined();
  });
});
