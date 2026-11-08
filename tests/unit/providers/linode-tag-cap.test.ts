import { describe, expect, it, vi } from 'vitest';

/**
 * Linode caps every tag at 3-50 characters. Live 2026-11-07: POST /v4/tags
 * with a 55-character label returned 400 {"reason": "Length must be 3-50
 * characters", "field": "label"}. The k8s-ha e2e cluster tag
 * (`cluster:testapp-k8s-ha-<13 digits>-<6 chars>-l4-primary`) is 54.
 *
 * encodeLabel keeps a tag that fits byte-identical and squeezes a longer one
 * to exactly 50: the key, a value prefix, then an 8-hex hash of the value.
 * Every writer and every selector goes through it, so they agree. A decoded
 * label no longer equals the raw name, so ownership checks compare against
 * provider.labelValue(key, raw) instead.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import {
  decodeLabels,
  encodeLabel,
  encodeLabels,
  LinodeProvider,
} from '../../../src/lib/providers/linode.js';

// runner.ts names a local project `testapp-<mode>-<ms>-<6 chars>`.
const HA_PROJECT = 'testapp-k8s-ha-1787258789210-0typg2';
const HA_CLUSTER = `${HA_PROJECT}-l4-primary`;

describe('encodeLabel keeps every Linode tag within 3-50', () => {
  it('leaves a tag that fits byte-identical, up to exactly 50', () => {
    expect(encodeLabel('project', 'acme')).toBe('project:acme');
    expect(encodeLabel('cluster-autoscaler/node', 'worker-pool')).toBe(
      'cluster-autoscaler-node:worker-pool',
    );
    const fits = 'x'.repeat(50 - 'project:'.length);
    expect(encodeLabel('project', fits)).toBe(`project:${fits}`);
  });

  it('squeezes a longer tag to exactly 50: key, value prefix, hash of the value', () => {
    const tag = encodeLabel('cluster', HA_CLUSTER);
    expect(`cluster:${HA_CLUSTER}`.length).toBe(54);
    expect(tag).toHaveLength(50);
    expect(tag).toMatch(/^cluster:testapp-k8s-ha-1787258789210-0typ-[0-9a-f]{8}$/);
    expect(tag).toMatch(/^[A-Za-z0-9:_-]+$/);
  });

  it('caps a tag one character past the limit', () => {
    const value = 'y'.repeat(51 - 'project:'.length);
    expect(encodeLabel('project', value)).toHaveLength(50);
  });

  it('is stable for one input and distinct for names that differ only at the end', () => {
    expect(encodeLabel('cluster', HA_CLUSTER)).toBe(encodeLabel('cluster', HA_CLUSTER));
    const standby = `${HA_PROJECT}-l4-standby`;
    expect(encodeLabel('cluster', standby)).toHaveLength(50);
    expect(encodeLabel('cluster', standby)).not.toBe(encodeLabel('cluster', HA_CLUSTER));
  });

  it('keeps the key intact, so a squeezed tag still decodes under its key', () => {
    const decoded = decodeLabels([encodeLabel('cluster', HA_CLUSTER)]);
    expect(Object.keys(decoded)).toEqual(['cluster']);
    expect(decoded.cluster.startsWith('testapp-k8s-ha-')).toBe(true);
  });

  it('encodeLabels caps each tag', () => {
    const tags = encodeLabels({
      project: HA_PROJECT,
      environment: 'l4-primary',
      cluster: HA_CLUSTER,
    });
    for (const tag of tags) {
      expect(tag.length).toBeGreaterThanOrEqual(3);
      expect(tag.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('LinodeProvider.listServers finds a server by its squeezed cluster tag', () => {
  it('matches the selector the autoscaler sends against tags the program wrote', async () => {
    const ours = {
      id: 1,
      label: 'master',
      tags: encodeLabels({ role: 'master', cluster: HA_CLUSTER }),
    };
    const other = {
      id: 2,
      label: 'other',
      tags: encodeLabels({ role: 'master', cluster: `${HA_PROJECT}-l4-standby` }),
    };
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [ours, other], page: 1, pages: 1 }),
    });
    const found = await new LinodeProvider('t').listServers({ cluster: HA_CLUSTER });
    expect(found.map((s: { id: number }) => s.id)).toEqual([1]);
  });
});
