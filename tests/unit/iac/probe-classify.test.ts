import { describe, expect, it } from 'vitest';
import { classifyK3sTokenProbe } from '../../../src/lib/iac/index.js';

// classifyK3sTokenProbe is the seam that decides what `vibecarbon scale`
// (k8s mode) does after probing the prior stack outputs for a recoverable
// k3sToken. The probe-and-replay path was added in PR 1AM to keep
// userData hashes stable across deploy/scale; HA initially regressed
// (see /tmp/k8s-ha-matrix.log) because the probe path silently returned
// no token and the master-replace defense had to catch it. This file
// pins the three observable outcomes so a future "tighten the catch"
// edit doesn't quietly turn `errored` into `empty` (or vice versa).
describe('classifyK3sTokenProbe', () => {
  it('recovered: outputs has a non-empty k3sToken — caller replays it', () => {
    const probe = classifyK3sTokenProbe({
      outputs: { k3sToken: 'deadbeef'.repeat(8), masterIp: '1.2.3.4' },
    });
    expect(probe.status).toBe('recovered');
    expect(probe.priorK3sToken).toBe('deadbeef'.repeat(8));
  });

  it('empty: outputs is null/undefined — fresh stack with no prior up', () => {
    const probeFromNull = classifyK3sTokenProbe({ outputs: null });
    const probeFromUndef = classifyK3sTokenProbe({});
    expect(probeFromNull.status).toBe('empty');
    expect(probeFromUndef.status).toBe('empty');
    // No priorK3sToken field — caller must mint a fresh one.
    expect(probeFromNull.priorK3sToken).toBeUndefined();
    expect(probeFromUndef.priorK3sToken).toBeUndefined();
  });

  it('empty: outputs is {} — Pulumi created the stack but no successful up landed', () => {
    const probe = classifyK3sTokenProbe({ outputs: {} });
    expect(probe.status).toBe('empty');
    expect(probe.priorK3sToken).toBeUndefined();
    // Reason must surface "fresh stack" so an operator triaging logs can
    // tell this from a deploy that wrote outputs but lost k3sToken.
    expect(probe.reason).toMatch(/fresh stack|empty/i);
  });

  it('empty: outputs has other keys but no k3sToken — schema drift, surface the keys', () => {
    const probe = classifyK3sTokenProbe({
      outputs: { masterIp: '1.2.3.4', floatingIp: '5.6.7.8' },
    });
    expect(probe.status).toBe('empty');
    expect(probe.priorK3sToken).toBeUndefined();
    // Reason must list the keys we DID see so an operator can spot a
    // missing-output bug at a glance.
    expect(probe.reason).toContain('masterIp');
    expect(probe.reason).toContain('floatingIp');
  });

  it('empty: k3sToken is the empty string — treat as missing, not recovered', () => {
    // Hetzner's stack output deserializer can return '' for a key that
    // serialized to `null`/`undefined` upstream. Replaying '' would
    // produce userData drift identical to "minted a fresh token", so
    // we explicitly fall through to the empty branch.
    const probe = classifyK3sTokenProbe({ outputs: { k3sToken: '' } });
    expect(probe.status).toBe('empty');
    expect(probe.priorK3sToken).toBeUndefined();
  });

  it('empty: k3sToken is a non-string (number, object) — defensive, treat as missing', () => {
    expect(classifyK3sTokenProbe({ outputs: { k3sToken: 42 } }).status).toBe('empty');
    expect(classifyK3sTokenProbe({ outputs: { k3sToken: { foo: 'bar' } } }).status).toBe('empty');
  });

  it('errored: error object with a multi-line message — first line surfaces in reason', () => {
    const err = new Error('S3 backend unreachable\n  retry attempt 3 failed\n  giving up');
    const probe = classifyK3sTokenProbe({ error: err });
    expect(probe.status).toBe('errored');
    // Reason must include only the first line of the error to keep the
    // CLI log on one line — full traces blow out the spinner UI.
    expect(probe.reason).toContain('S3 backend unreachable');
    expect(probe.reason).not.toContain('retry attempt 3');
  });

  it('errored: non-Error thrown value still surfaces a reason', () => {
    // Pulumi's CLI shell-out occasionally rejects with a plain string when
    // the underlying child process aborts. The classifier shouldn't crash.
    const probe = classifyK3sTokenProbe({ error: new Error(String('boom')) });
    expect(probe.status).toBe('errored');
    expect(probe.reason).toContain('boom');
  });

  it('error wins over outputs: if both are set, classify as errored (defensive)', () => {
    // Shouldn't happen in practice, but if a future caller passes both
    // (e.g., partial result before throw), we err on the side of "loud".
    const probe = classifyK3sTokenProbe({
      outputs: { k3sToken: 'abc' },
      error: new Error('partial state'),
    });
    expect(probe.status).toBe('errored');
    expect(probe.priorK3sToken).toBeUndefined();
  });
});
