import { describe, expect, it } from 'vitest';
import { waitForKubeletsRenewing } from '../../../src/lib/deploy/k8s/kubelet-liveness.js';

// One kubectl answer: node name to the lease's renewTime.
const leases = (nodes: Record<string, string>) =>
  JSON.stringify({
    items: Object.entries(nodes).map(([name, renewTime]) => ({
      metadata: { name },
      spec: { renewTime },
    })),
  });

// Answers in order, then keeps repeating the last, so a node that stops
// renewing stays stopped. An Error in the list is a failed read.
function reader(answers: Array<string | Error>) {
  const reads = { count: 0 };
  const read = () => {
    const answer = answers[Math.min(reads.count, answers.length - 1)];
    reads.count += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, reads };
}

const fast = { budgetMs: 200, intervalMs: 1 };

describe('waitForKubeletsRenewing', () => {
  it('settles once every node has renewed twice beyond the first read', async () => {
    const { read, reads } = reader([
      leases({ master: 't0', worker: 't0' }),
      leases({ master: 't1', worker: 't1' }),
      leases({ master: 't2', worker: 't2' }),
    ]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: true,
      pending: [],
    });
    expect(reads.count).toBe(3);
  });

  it('holds on a node that is still down while the others renew', async () => {
    const { read } = reader([
      leases({ master: 't0', worker: 'stale' }),
      leases({ master: 't1', worker: 'stale' }),
      leases({ master: 't2', worker: 'stale' }),
      leases({ master: 't3', worker: 'stale' }),
    ]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: false,
      pending: ['worker'],
    });
  });

  // A kubelet's first renewal can land within seconds of its start, before it
  // has told the API what became of its pods. That is the whole bug.
  it('does not settle on one renewal', async () => {
    const { read } = reader([leases({ worker: 'stale' }), leases({ worker: 'back' })]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: false,
      pending: ['worker'],
    });
  });

  it('counts a renewal once, however many reads see it', async () => {
    const { read, reads } = reader([
      leases({ worker: 't0' }),
      leases({ worker: 't1' }),
      leases({ worker: 't1' }),
      leases({ worker: 't1' }),
      leases({ worker: 't2' }),
    ]);
    const result = await waitForKubeletsRenewing({ readLeases: read, ...fast });
    expect(result.settled).toBe(true);
    expect(reads.count).toBe(5);
  });

  it('stops waiting for a node whose lease has gone', async () => {
    const { read } = reader([
      leases({ master: 't0', gone: 'stale' }),
      leases({ master: 't1' }),
      leases({ master: 't2' }),
    ]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: true,
      pending: [],
    });
  });

  it('holds a node that joins mid-wait to the same two renewals', async () => {
    const { read } = reader([
      leases({ master: 't0' }),
      leases({ master: 't1' }),
      leases({ master: 't2', fresh: 'a' }),
    ]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: false,
      pending: ['fresh'],
    });
  });

  it('keeps going through a failed read, which is the API coming back', async () => {
    const { read } = reader([
      new Error('ServiceUnavailable'),
      leases({ worker: 't0' }),
      new Error('ServiceUnavailable'),
      leases({ worker: 't1' }),
      leases({ worker: 't2' }),
    ]);
    const result = await waitForKubeletsRenewing({ readLeases: read, ...fast });
    expect(result.settled).toBe(true);
  });

  // An empty list proves nothing, so it must not read as every node healthy.
  it('does not settle on an empty lease list', async () => {
    const { read } = reader([leases({})]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: false,
      pending: [],
    });
  });

  it('never throws at the budget, because the pod wait reports the real state next', async () => {
    const { read } = reader([new Error('connection refused')]);
    await expect(waitForKubeletsRenewing({ readLeases: read, ...fast })).resolves.toEqual({
      settled: false,
      pending: [],
    });
  });
});
