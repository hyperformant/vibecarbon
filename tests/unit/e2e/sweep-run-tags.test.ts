/**
 * Empty per-run tags (2026-11-13). DigitalOcean and Linode keep a tag as an
 * account object after the last resource carrying it is gone, so every e2e
 * run left its `project:<run>` tag behind (DO: 24 in a week; Linode: 78
 * project tags and 7 cluster tags since August). The sweep now deletes the
 * run's tags once nothing carries them. These tests pin that contract: only
 * the run's own tag keys, only at a resource count of exactly 0 read just
 * before the delete, and never a failed sweep over a tag (tags cost nothing).
 */
import { describe, expect, it, vi } from 'vitest';
import { type RunTagApi, runTagOwner, sweepRunTags } from '../../e2e/utils/sweep-run-tags.js';

const TAG = '[test]';

function fakeApi(
  tags: Record<string, number | null>,
  overrides: Partial<RunTagApi> = {},
): RunTagApi & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: vi.fn(async () => ({ names: Object.keys(tags), complete: true })),
    resourceCount: vi.fn(async (name: string) => tags[name] ?? null),
    remove: vi.fn(async (name: string) => {
      removed.push(name);
      return true;
    }),
    ...overrides,
  };
}

describe('runTagOwner', () => {
  const plain = (key: string, value: string) => `${key}:${value}`;

  it("matches the run's project tag and nothing that only shares a key", () => {
    const owns = runTagOwner('testapp-d3', ['project'], plain);
    expect(owns('project:testapp-d3')).toBe(true);
    expect(owns('project:otherapp-d3')).toBe(false);
    expect(owns('role:db')).toBe(false);
    expect(owns('environment:testapp-d3')).toBe(false);
  });

  it('matches every tag of a name prefix (the CI sweep passes citest-)', () => {
    const owns = runTagOwner('citest-', ['project'], plain);
    expect(owns('project:citest-compose-1786628877408-xvyyed')).toBe(true);
    expect(owns('project:testapp-compose-1794525058414-zwwxmh')).toBe(false);
  });

  it('only the keys it is given: a DO cluster tag is not a run tag there', () => {
    const owns = runTagOwner('testapp-k8s-1', ['project'], plain);
    expect(owns('cluster:testapp-k8s-1-d3')).toBe(false);
    const linode = runTagOwner('testapp-k8s-1', ['project', 'cluster'], plain);
    expect(linode('cluster:testapp-k8s-1-l3')).toBe(true);
  });

  it('encodes the name the way the provider wrote it', () => {
    const owns = runTagOwner('my.app', ['project'], (k, v) =>
      `${k}:${v}`.replace(/[^A-Za-z0-9:_-]/g, '-'),
    );
    expect(owns('project:my-app-x1')).toBe(true);
  });

  it("matches a Linode tag squeezed to 50 characters by the name's first 41", () => {
    // linode.js encodeLabel: a tag over 50 characters keeps its first 41,
    // then `-` and an 8-hex hash. The run's cluster tag on k8s-ha is one.
    const project = 'testapp-k8s-ha-1794526158726-5ke0dz';
    const squeezed = `${`cluster:${project}-l4-primary`.slice(0, 41)}-0123abcd`;
    expect(squeezed).toHaveLength(50);
    const owns = runTagOwner(project, ['project', 'cluster'], plain, { squeezeMax: 50 });
    expect(owns(squeezed)).toBe(true);
    // Another run's squeezed tag differs inside the first 41 characters.
    const other = `${'cluster:testapp-k8s-ha-1794526158726-zzzzzz-l4-primary'.slice(0, 41)}-0123abcd`;
    expect(owns(other)).toBe(false);
    // A 50-character tag without the hash tail is not a squeezed one.
    expect(owns(`${squeezed.slice(0, 41)}-0123abcz`)).toBe(false);
    // DigitalOcean never squeezes, so without the option it is not the run's.
    expect(runTagOwner(project, ['project', 'cluster'], plain)(squeezed)).toBe(false);
  });
});

describe('sweepRunTags', () => {
  it('deletes the run tags that no resource carries and keeps the rest', async () => {
    const api = fakeApi({
      'project:testapp-d3': 0,
      'project:testapp-d3-other-run-same-prefix': 0,
      'project:otherapp': 0,
      'role:db': 0,
    });
    const owns = runTagOwner('testapp-d3', ['project'], (k, v) => `${k}:${v}`);
    const result = await sweepRunTags(TAG, owns, api);
    expect(api.removed).toEqual(['project:testapp-d3', 'project:testapp-d3-other-run-same-prefix']);
    expect(result.deleted).toEqual(api.removed);
  });

  it('keeps a run tag that still has resources: deleting it would untag them', async () => {
    const api = fakeApi({ 'project:testapp-d3': 2 });
    const owns = runTagOwner('testapp-d3', ['project'], (k, v) => `${k}:${v}`);
    const result = await sweepRunTags(TAG, owns, api);
    expect(api.removed).toEqual([]);
    expect(result.kept).toEqual(['project:testapp-d3']);
  });

  it('keeps a run tag whose count could not be read', async () => {
    const api = fakeApi({ 'project:testapp-d3': null });
    const owns = runTagOwner('testapp-d3', ['project'], (k, v) => `${k}:${v}`);
    const result = await sweepRunTags(TAG, owns, api);
    expect(api.removed).toEqual([]);
    expect(result.kept).toEqual(['project:testapp-d3']);
  });

  it('reads the count of each tag just before deleting it, not from the listing', async () => {
    const calls: string[] = [];
    const api = fakeApi(
      { 'project:testapp-d3': 0 },
      {
        resourceCount: vi.fn(async (name: string) => {
          calls.push(`count ${name}`);
          return 0;
        }),
        remove: vi.fn(async (name: string) => {
          calls.push(`remove ${name}`);
          return true;
        }),
      },
    );
    await sweepRunTags(
      TAG,
      runTagOwner('testapp-d3', ['project'], (k, v) => `${k}:${v}`),
      api,
    );
    expect(calls).toEqual(['count project:testapp-d3', 'remove project:testapp-d3']);
  });

  it('never throws: a failing list, count or delete is a warning', async () => {
    const owns = runTagOwner('testapp-d3', ['project'], (k, v) => `${k}:${v}`);
    await expect(
      sweepRunTags(TAG, owns, fakeApi({}, { list: vi.fn().mockRejectedValue(new Error('500')) })),
    ).resolves.toEqual({ deleted: [], kept: [] });
    await expect(
      sweepRunTags(
        TAG,
        owns,
        fakeApi(
          { 'project:testapp-d3': 0 },
          { resourceCount: vi.fn().mockRejectedValue(new Error('timeout')) },
        ),
      ),
    ).resolves.toEqual({ deleted: [], kept: ['project:testapp-d3'] });
    await expect(
      sweepRunTags(
        TAG,
        owns,
        fakeApi({ 'project:testapp-d3': 0 }, { remove: vi.fn().mockResolvedValue(false) }),
      ),
    ).resolves.toEqual({ deleted: [], kept: ['project:testapp-d3'] });
  });
});
