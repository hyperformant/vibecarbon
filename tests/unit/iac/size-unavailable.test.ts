/**
 * A droplet size that goes out of stock between the catalog check and the
 * create becomes one plain message; other 422s pass through untouched.
 *
 * Fixture: the real Diagnostics text from a k8s-ha deploy log (d4, 2026-11-04),
 * request id replaced. See src/lib/iac/size-unavailable.js for the evidence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDropletPlanRecorder,
  describeSizeUnavailable,
  sizeUnavailableError,
} from '../../../src/lib/iac/size-unavailable.js';

const selectStackMock = vi.fn();
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));
vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

const STOCKOUT = [
  'Diagnostics:',
  '  digitalocean:index:Droplet (db):',
  '    error:   sdk-v2/provider2.go:574: sdk.helper_schema: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422 (request "req-1") Size is not available in this region.: provider=digitalocean',
  '    error: 1 error occurred:',
  '    \t* Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422 (request "req-1") Size is not available in this region.',
].join('\n');

const OTHER_422S = [
  'Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422 (request "r") Name or ssh key already in use',
  'Error creating VPC: POST https://api.digitalocean.com/v2/vpcs: 422 (request "r") The specified IP range overlaps with another VPC network in your account.',
  // same words, wrong status: not a stock-out
  'Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 500 (request "r") Size is not available in this region.',
  // the size sentence on a different resource kind
  'Error creating volume: POST https://api.digitalocean.com/v2/volumes: 422 (request "r") Size is not available in this region.',
];

describe('sizeUnavailableError', () => {
  it('maps the real stock-out 422 to a plain message naming size and region', () => {
    const rec = createDropletPlanRecorder();
    rec.onEvent({
      resourcePreEvent: {
        metadata: {
          urn: 'urn:pulumi:s::p::digitalocean:index/droplet:Droplet::db',
          type: 'digitalocean:index/droplet:Droplet',
          op: 'create',
          new: { inputs: { size: 's-4vcpu-8gb', region: 'nyc3', name: 'x-db' } },
        },
      },
    });
    const err = sizeUnavailableError(new Error(STOCKOUT), { plans: rec.plans });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('"s-4vcpu-8gb" in nyc3');
    expect(err?.message).toContain(
      'it answered that the size is not available in the region. That can mean the size is out of stock or that the region does not sell it, and DigitalOcean does not say which.',
    );
    // every sentence is a fact the CLI knows: no claim about the earlier catalog check
    expect(err?.message).toContain('does not say which');
    expect(err?.message).not.toMatch(/when the deploy checked|right now/);
    expect(err?.message).toContain('another size or another region');
    expect(err?.message).toContain('try again later');
    expect(err?.message).not.toContain('422');
    expect(err?.message).not.toMatch(/—/);
    expect(err?.cause).toBeInstanceOf(Error);
  });

  it('still maps when size and region were never recorded', () => {
    const err = sizeUnavailableError(new Error(STOCKOUT));
    expect(err?.message).toContain('out of stock');
  });

  it.each(OTHER_422S)('passes unrelated failures through: %s', (text) => {
    expect(sizeUnavailableError(new Error(text))).toBeNull();
  });
});

describe('describeSizeUnavailable', () => {
  it('names the size and region', () => {
    const m = describeSizeUnavailable({ size: 's-2vcpu-4gb', region: 'sfo3', name: 'web' });
    expect(m).toContain('"s-2vcpu-4gb" in sfo3');
    expect(m).toContain('other than sfo3');
  });
});

describe('upStack: an out-of-stock droplet fails with the plain message, once', () => {
  beforeEach(() => selectStackMock.mockReset());

  function stackFailing(error: Error) {
    return {
      name: 'e1',
      cancel: vi.fn().mockResolvedValue(undefined),
      exportStack: vi.fn().mockResolvedValue({ deployment: { resources: [] } }),
      refresh: vi.fn().mockResolvedValue(undefined),
      up: vi.fn(async (opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          resourcePreEvent: {
            metadata: {
              urn: 'urn:pulumi:e1::acme::digitalocean:index/droplet:Droplet::db',
              type: 'digitalocean:index/droplet:Droplet',
              op: 'create',
              new: { inputs: { size: 's-4vcpu-8gb', region: 'nyc3' } },
            },
          },
        });
        throw error;
      }),
      outputs: vi.fn().mockResolvedValue({}),
    };
  }

  it('names the size and region from the engine events and does not retry', async () => {
    const stack = stackFailing(new Error(STOCKOUT));
    selectStackMock.mockResolvedValue(stack);
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const caught = await upStack('e1', () => ({}), { projectName: 'acme' }).catch(
      (e: unknown) => e,
    );
    expect((caught as Error).name).toBe('SizeUnavailableError');
    expect((caught as Error).message).toContain('"s-4vcpu-8gb" in nyc3');
    expect(stack.up).toHaveBeenCalledTimes(1);
  });

  it('leaves an unrelated 422 as it was', async () => {
    const other = new Error(OTHER_422S[0]);
    selectStackMock.mockResolvedValue(stackFailing(other));
    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e1', () => ({}), { projectName: 'acme' })).rejects.toBe(other);
  });
});
