/**
 * The seal up's preview reads each engine event for a step that removes a
 * server (PR 2 final review C1(b), src/lib/iac/server-replace-guard.js).
 * tests/integration/iac/state-seal.test.ts (f) runs it on the real engine.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';
import {
  ServerReplaceRefusedError,
  serverRemovalOf,
} from '../../../src/lib/iac/server-replace-guard.js';

const DROPLET = 'digitalocean:index/droplet:Droplet';
const URN = `urn:pulumi:prod::myapp::${DROPLET}::server`;
const event = (op: string, type = DROPLET, urn = URN, inputs = { name: 'myapp-prod' }) => ({
  resourcePreEvent: { metadata: { op, urn, type, old: { inputs }, new: { inputs } } },
});

describe('serverRemovalOf', () => {
  const ACTIONS: Record<string, string> = {
    replace: 'replace',
    'create-replacement': 'replace',
    'delete-replaced': 'replace',
    delete: 'delete',
    // The state lost the recorded server: the up would make a second one.
    create: 'create',
  };
  for (const [op, action] of Object.entries(ACTIONS)) {
    it(`a server step '${op}' leaves the recorded server behind (${action})`, () => {
      expect(serverRemovalOf(event(op), SERVER_RESOURCE_TYPES)).toEqual({
        op,
        action,
        urn: URN,
        noun: 'droplet',
        name: 'myapp-prod',
      });
    });
  }

  for (const op of ['same', 'update', 'read', 'refresh', 'toString', 'constructor']) {
    it(`a server step '${op}' keeps it`, () => {
      expect(serverRemovalOf(event(op), SERVER_RESOURCE_TYPES)).toBeNull();
    });
  }

  it("another resource's replacement is not a server's (the DigitalOcean SshKey)", () => {
    const keyUrn = 'urn:pulumi:prod::myapp::digitalocean:index/sshKey:SshKey::key';
    expect(
      serverRemovalOf(
        event('replace', 'digitalocean:index/sshKey:SshKey', keyUrn),
        SERVER_RESOURCE_TYPES,
      ),
    ).toBeNull();
  });

  it('reads the type from the URN when the event carries none, and the name from it last', () => {
    const bare = { resourcePreEvent: { metadata: { op: 'delete', urn: URN } } };
    expect(serverRemovalOf(bare, SERVER_RESOURCE_TYPES)).toMatchObject({
      noun: 'droplet',
      name: 'server',
    });
  });

  it('events with no step metadata are not steps', () => {
    expect(serverRemovalOf({}, SERVER_RESOURCE_TYPES)).toBeNull();
    expect(serverRemovalOf({ resOutputsEvent: {} }, SERVER_RESOURCE_TYPES)).toBeNull();
    expect(serverRemovalOf(undefined, SERVER_RESOURCE_TYPES)).toBeNull();
  });
});

describe('ServerReplaceRefusedError', () => {
  it('names the stack, what the up would do to which server, and every step', () => {
    const err = new ServerReplaceRefusedError('prod', [
      { op: 'replace', action: 'replace', urn: URN, noun: 'droplet', name: 'myapp-prod' },
      { op: 'delete-replaced', action: 'replace', urn: URN, noun: 'droplet', name: 'myapp-prod' },
    ]);
    expect(err.message).toBe(
      `The up for prod would replace droplet myapp-prod, so it didn't run (replace ${URN}, delete-replaced ${URN})`,
    );
    expect(
      new ServerReplaceRefusedError('prod', [
        { ...err.removals[0], op: 'delete', action: 'delete' },
      ]).message,
    ).toMatch(/^The up for prod would delete droplet myapp-prod,/);
  });
});
