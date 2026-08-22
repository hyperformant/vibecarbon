import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { type ExecStubs, installExecStubs } from './exec-stubs.js';

describe('installExecStubs', () => {
  let stubs: ExecStubs | undefined;
  afterEach(() => {
    stubs?.teardown();
    stubs = undefined;
  });

  it('records a call with full argv', () => {
    stubs = installExecStubs([{ command: 'fakebin', respond: { stdout: 'hello\n', exitCode: 0 } }]);
    execFileSync(`${stubs.binPath}/fakebin`, ['arg1', '--flag', 'value'], {
      encoding: 'utf-8',
    });
    const calls = stubs.callsTo('fakebin');
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(['arg1', '--flag', 'value']);
  });

  it('emits configured stdout and exit code', () => {
    stubs = installExecStubs([
      { command: 'fakebin', respond: { stdout: 'configured-output', exitCode: 0 } },
    ]);
    const out = execFileSync(`${stubs.binPath}/fakebin`, [], { encoding: 'utf-8' });
    expect(out).toBe('configured-output');
  });

  it('exit code propagates', () => {
    stubs = installExecStubs([{ command: 'fakebin', respond: { stdout: '', exitCode: 42 } }]);
    expect(() => execFileSync(`${stubs.binPath}/fakebin`, [])).toThrow();
  });

  it('matches the first regex match when multiple specs share a command', () => {
    stubs = installExecStubs([
      { command: 'fakebin', matches: /^foo/, respond: { stdout: 'first\n', exitCode: 0 } },
      { command: 'fakebin', matches: /^bar/, respond: { stdout: 'second\n', exitCode: 0 } },
    ]);
    const r1 = execFileSync(`${stubs.binPath}/fakebin`, ['foo', 'arg'], { encoding: 'utf-8' });
    const r2 = execFileSync(`${stubs.binPath}/fakebin`, ['bar', 'arg'], { encoding: 'utf-8' });
    expect(r1).toBe('first\n');
    expect(r2).toBe('second\n');
  });

  it('falls through to exit 0 when no matcher fires', () => {
    stubs = installExecStubs([
      { command: 'fakebin', matches: /^never/, respond: { stdout: 'x', exitCode: 1 } },
    ]);
    // Argv "anything" doesn't match /^never/ → falls to default exit 0
    const out = execFileSync(`${stubs.binPath}/fakebin`, ['anything'], { encoding: 'utf-8' });
    expect(out).toBe('');
  });

  it('callsTo filters by command', () => {
    stubs = installExecStubs([
      { command: 'foo', respond: { stdout: '', exitCode: 0 } },
      { command: 'bar', respond: { stdout: '', exitCode: 0 } },
    ]);
    execFileSync(`${stubs.binPath}/foo`, ['1']);
    execFileSync(`${stubs.binPath}/bar`, ['2']);
    execFileSync(`${stubs.binPath}/foo`, ['3']);
    expect(stubs.callsTo('foo')).toHaveLength(2);
    expect(stubs.callsTo('bar')).toHaveLength(1);
  });
});
