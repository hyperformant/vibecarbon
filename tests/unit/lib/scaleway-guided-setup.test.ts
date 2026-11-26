import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({
    fns: ['note'],
    log: ['info', 'warn', 'success'],
    with: { isCancel: vi.fn(() => false) },
  });
});
vi.mock('@clack/prompts', () => clackMock);

import { displayApiTokenGuide } from '../../../src/lib/scaleway-guided-setup.js';

describe('displayApiTokenGuide', () => {
  it('names the three permission sets Kubernetes needs, and why', () => {
    displayApiTokenGuide('my-project');
    const text = stripVTControlCharacters(clackMock.note.mock.calls[0][0]);
    expect(text).toContain('PrivateNetworksFullAccess');
    expect(text).toContain('VPCFullAccess');
    expect(text).toContain('IPAMReadOnly');
    expect(text).toContain(
      'the cluster gets its own Private Network and its nodes read their addresses',
    );
    const policyLine = text.split('\n').find((l) => l.includes('PrivateNetworksFullAccess')) ?? '';
    expect(policyLine).not.toMatch(/[\u2013\u2014]/);
  });
});
