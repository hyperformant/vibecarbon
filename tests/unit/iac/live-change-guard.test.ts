/**
 * The seal up's preview reads each engine event for a step that changes
 * something live (PR 2 final review C1(b), ruling R36,
 * src/lib/iac/live-change-guard.js): any change to the server, and a replace
 * or delete of anything else. tests/integration/iac/state-seal.test.ts (f)
 * runs it on the real engine.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';
import {
  describeLiveChanges,
  LiveChangeRefusedError,
  liveChangeOf,
} from '../../../src/lib/iac/live-change-guard.js';

const DROPLET = 'digitalocean:index/droplet:Droplet';
const IP = 'scaleway:instance/ip:Ip';
const FIREWALL = 'hcloud:index/firewall:Firewall';
const urnOf = (type: string, name: string) => `urn:pulumi:prod::myapp::${type}::${name}`;
const event = (op: string, type: string, name: string, inputs?: Record<string, unknown>) => ({
  resourcePreEvent: {
    metadata: { op, urn: urnOf(type, name), type, old: { inputs }, new: { inputs } },
  },
});
const change = (op: string, type: string, name: string, inputs?: Record<string, unknown>) =>
  liveChangeOf(event(op, type, name, inputs), SERVER_RESOURCE_TYPES);

describe('liveChangeOf: the server', () => {
  const ACTIONS: Record<string, string> = {
    // An in-place update such as a resize stops the server.
    update: 'update',
    replace: 'replace',
    'create-replacement': 'replace',
    'delete-replaced': 'replace',
    delete: 'delete',
    // The state lost the recorded server: the up would make a second one.
    create: 'create',
  };
  for (const [op, action] of Object.entries(ACTIONS)) {
    it(`a server step '${op}' is a live change (${action})`, () => {
      expect(change(op, DROPLET, 'server', { name: 'myapp-prod' })).toEqual({
        op,
        action,
        urn: urnOf(DROPLET, 'server'),
        type: DROPLET,
        kind: 'Droplet',
        name: 'myapp-prod',
        server: true,
      });
    });
  }

  it("any other op on a server counts too, under the op's own name", () => {
    expect(change('discard', DROPLET, 'server')).toMatchObject({ action: 'discard', server: true });
  });

  for (const op of ['same', 'read', 'refresh']) {
    it(`a server step '${op}' leaves it as it is`, () => {
      expect(change(op, DROPLET, 'server')).toBeNull();
    });
  }

  it("the name is the input the provider names the server by (Vultr's label), before any other", () => {
    expect(
      change('update', 'vultr:index/instance:Instance', 'server', {
        name: 'not-this',
        label: 'myapp-prod',
      }),
    ).toMatchObject({ kind: 'Instance', name: 'myapp-prod' });
  });

  it('a server the up would create is named by its new inputs, the only ones it has', () => {
    const created = {
      resourcePreEvent: {
        metadata: {
          op: 'create',
          urn: urnOf(DROPLET, 'server'),
          type: DROPLET,
          new: { inputs: { name: 'myapp-prod' } },
        },
      },
    };
    expect(liveChangeOf(created, SERVER_RESOURCE_TYPES)).toMatchObject({ name: 'myapp-prod' });
  });
});

describe('liveChangeOf: every other resource', () => {
  it("a Scaleway IP replaced is a live change: the server's public address changes", () => {
    expect(change('replace', IP, 'ip')).toMatchObject({
      action: 'replace',
      kind: 'Ip',
      name: 'ip',
      server: false,
    });
  });

  it('a firewall replaced or deleted is a live change: the server is open while it is gone', () => {
    for (const op of ['replace', 'create-replacement', 'delete-replaced', 'delete']) {
      expect(change(op, FIREWALL, 'firewall', { name: 'myapp-prod-fw' })).toMatchObject({
        kind: 'Firewall',
        name: 'myapp-prod-fw',
      });
    }
  });

  it("a firewall rule updated in place, an SSH key's label, a new resource: the seal may apply them", () => {
    expect(change('update', FIREWALL, 'firewall')).toBeNull();
    expect(change('update', 'digitalocean:index/sshKey:SshKey', 'key')).toBeNull();
    expect(change('create', 'hcloud:index/primaryIp:PrimaryIp', 'ip')).toBeNull();
    expect(change('same', IP, 'ip')).toBeNull();
  });

  it("Pulumi's own stack and provider resources hold nothing in the cloud", () => {
    expect(change('delete', 'pulumi:providers:digitalocean', 'default_4_40_0')).toBeNull();
    expect(change('replace', 'pulumi:providers:hcloud', 'default')).toBeNull();
    expect(change('update', 'pulumi:pulumi:Stack', 'myapp-prod')).toBeNull();
  });

  it("reads the type from the URN when the event carries none, a parent's included", () => {
    const urn = ['urn:pulumi:prod', 'myapp', `my:component$${DROPLET}`, 'server'].join('::');
    const bare = { resourcePreEvent: { metadata: { op: 'update', urn } } };
    expect(liveChangeOf(bare, SERVER_RESOURCE_TYPES)).toMatchObject({
      kind: 'Droplet',
      name: 'server',
      server: true,
    });
  });

  it('events with no step are not steps', () => {
    expect(liveChangeOf({}, SERVER_RESOURCE_TYPES)).toBeNull();
    expect(liveChangeOf({ resOutputsEvent: {} }, SERVER_RESOURCE_TYPES)).toBeNull();
    expect(liveChangeOf(undefined, SERVER_RESOURCE_TYPES)).toBeNull();
    expect(change('toString', 'x:y:Z', 'z')).toBeNull();
  });
});

describe('describeLiveChanges and LiveChangeRefusedError', () => {
  const replaced = ['replace', 'create-replacement', 'delete-replaced'].map((op) =>
    change(op, IP, 'ip'),
  );
  const resized = change('update', DROPLET, 'server', { name: 'myapp-prod' });

  it("names each change once: the type, the resource's name and what the plan would do", () => {
    expect(describeLiveChanges([resized, ...replaced])).toEqual([
      'Droplet myapp-prod (update)',
      'Ip ip (replace)',
    ]);
  });

  it('the error says what the up would change, and keeps every step', () => {
    const err = new LiveChangeRefusedError('prod', [resized, ...replaced]);
    expect(err.message).toMatch(
      /^The up for prod would change Droplet myapp-prod \(update\), Ip ip \(replace\), so it didn't run \(steps: update urn:/,
    );
    expect(err.message).toContain(`delete-replaced ${urnOf(IP, 'ip')}`);
    expect(err.changes).toHaveLength(4);
  });
});
