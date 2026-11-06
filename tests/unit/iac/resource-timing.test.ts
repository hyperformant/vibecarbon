import { describe, expect, it } from 'vitest';
import { createResourceTimer } from '../../../src/lib/iac/resource-timing.js';

const URN = (type: string, name: string, parent = '') =>
  `urn:pulumi:dev::proj::${parent}${type}::${name}`;

const pre = (op: string, urn: string, type: string) => ({
  resourcePreEvent: { metadata: { op, urn, type } },
});
const out = (op: string, urn: string, type: string) => ({
  resOutputsEvent: { metadata: { op, urn, type } },
});

function harness() {
  let t = 1000;
  const lines: [string, number][] = [];
  const timer = createResourceTimer({
    stem: 'deploy.iac.upStack',
    now: () => t,
    record: (name, ms) => lines.push([name, ms]),
  });
  return { timer, lines, tick: (ms: number) => (t += ms) };
}

describe('createResourceTimer', () => {
  it('pairs pre and outputs by URN into one resource line', () => {
    const { timer, lines, tick } = harness();
    const urn = URN('hcloud:index/server:Server', 'web');
    timer.begin();
    timer.onEvent(pre('create', urn, 'hcloud:index/server:Server'));
    tick(700);
    timer.onEvent(out('create', urn, 'hcloud:index/server:Server'));
    expect(lines).toContainEqual(['deploy.iac.upStack.resource.Server.web', 700]);
  });

  it('emits firstEvent once, from begin to the first engine event', () => {
    const { timer, lines, tick } = harness();
    timer.begin();
    tick(40);
    timer.onEvent({ preludeEvent: {} });
    tick(10);
    timer.onEvent({ summaryEvent: {} });
    expect(lines.filter(([n]) => n.endsWith('.resource.firstEvent'))).toEqual([
      ['deploy.iac.upStack.resource.firstEvent', 40],
    ]);
  });

  it('only create, update, replace and create-replacement count', () => {
    const { timer, lines } = harness();
    timer.begin();
    for (const op of ['same', 'delete', 'read', 'refresh']) {
      const urn = URN('x:y:T', op);
      timer.onEvent(pre(op, urn, 'x:y:T'));
      timer.onEvent(out(op, urn, 'x:y:T'));
    }
    for (const op of ['create', 'update', 'replace', 'create-replacement']) {
      const urn = URN('x:y:T', op);
      timer.onEvent(pre(op, urn, 'x:y:T'));
      timer.onEvent(out(op, urn, 'x:y:T'));
    }
    const names = lines.map(([n]) => n).filter((n) => !n.endsWith('firstEvent'));
    expect(names).toEqual([
      'deploy.iac.upStack.resource.T.create',
      'deploy.iac.upStack.resource.T.update',
      'deploy.iac.upStack.resource.T.replace',
      'deploy.iac.upStack.resource.T.create-replacement',
    ]);
  });

  it('skips the stack resource', () => {
    const { timer, lines } = harness();
    const urn = 'urn:pulumi:dev::proj::pulumi:pulumi:Stack::proj-dev';
    timer.begin();
    timer.onEvent(pre('create', urn, 'pulumi:pulumi:Stack'));
    timer.onEvent(out('create', urn, 'pulumi:pulumi:Stack'));
    expect(lines.filter(([n]) => n.includes('.resource.Stack.'))).toEqual([]);
  });

  it('takes the last type segment, alphanumerics only, nested parents included', () => {
    const { timer, lines, tick } = harness();
    const urn = URN('hcloud:index/firewall:Firewall', 'fw', 'my:comp$');
    timer.begin();
    timer.onEvent(pre('create', urn, 'hcloud:index/firewall:Firewall'));
    tick(5);
    timer.onEvent(out('create', urn, 'hcloud:index/firewall:Firewall'));
    expect(lines).toContainEqual(['deploy.iac.upStack.resource.Firewall.fw', 5]);
    const weird = URN('a:b:Odd-Type_1', 'n');
    timer.onEvent(pre('create', weird, 'a:b:Odd-Type_1'));
    timer.onEvent(out('create', weird, 'a:b:Odd-Type_1'));
    expect(lines.map(([n]) => n)).toContain('deploy.iac.upStack.resource.OddType1.n');
  });

  it('a retry re-pairs from the new pre-event and never double-emits', () => {
    const { timer, lines, tick } = harness();
    const urn = URN('hcloud:index/server:Server', 'web');
    timer.begin();
    timer.onEvent(pre('create', urn, 'hcloud:index/server:Server'));
    tick(900);
    timer.begin(); // attempt 2
    timer.onEvent(pre('create', urn, 'hcloud:index/server:Server'));
    tick(100);
    timer.onEvent(out('create', urn, 'hcloud:index/server:Server'));
    timer.onEvent(out('create', urn, 'hcloud:index/server:Server'));
    const res = lines.filter(([n]) => n.endsWith('Server.web'));
    expect(res).toEqual([['deploy.iac.upStack.resource.Server.web', 100]]);
    expect(lines.filter(([n]) => n.endsWith('firstEvent')).length).toBe(1);
  });

  it('an unpaired pre-event or outputs event emits nothing and does not throw', () => {
    const { timer, lines } = harness();
    timer.begin();
    expect(() => {
      timer.onEvent(pre('create', URN('a:b:T', 'lonely'), 'a:b:T'));
      timer.onEvent(out('create', URN('a:b:T', 'orphan'), 'a:b:T'));
    }).not.toThrow();
    expect(lines.filter(([n]) => n.includes('.resource.T.'))).toEqual([]);
  });

  it('a throwing record or a malformed event never escapes', () => {
    const timer = createResourceTimer({
      stem: 's',
      now: () => 0,
      record: () => {
        throw new Error('stderr closed');
      },
    });
    timer.begin();
    const urn = URN('a:b:T', 'n');
    expect(() => {
      timer.onEvent(pre('create', urn, 'a:b:T'));
      timer.onEvent(out('create', urn, 'a:b:T'));
      timer.onEvent(null as never);
      timer.onEvent({ resourcePreEvent: {} } as never);
    }).not.toThrow();
  });
});
