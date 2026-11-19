import { describe, expect, it, vi } from 'vitest';
import {
  HARDWARE_COMMAND,
  hardwareVerdict,
  parseHardware,
  readHardware,
} from '../../e2e/utils/server-hardware.js';

const GIB = 1024 * 1024;
const small = { cpus: 2, memKiB: 4 * GIB - 200_000 };
const big = { cpus: 4, memKiB: 8 * GIB - 250_000 };

describe('parseHardware', () => {
  it('reads the vCPU count and MemTotal', () => {
    expect(parseHardware('2\n3989432\n')).toEqual({ cpus: 2, memKiB: 3989432 });
  });

  it('refuses anything that is not two positive whole numbers', () => {
    for (const out of ['', '2', 'x\n3989432', '2\n', '0\n3989432', '2\n3989432 kB']) {
      expect(parseHardware(out), JSON.stringify(out)).toBeNull();
    }
  });
});

describe('hardwareVerdict', () => {
  it('passes when every server is bigger after the scale', () => {
    expect(
      hardwareVerdict({ a: small, b: small, c: small }, { a: big, b: big, c: big }),
    ).toBeNull();
  });

  it('passes across replaced servers, whose addresses change', () => {
    expect(hardwareVerdict({ old1: small, old2: small }, { new1: big, new2: big })).toBeNull();
  });

  it('fails a partial scale and names the server left behind', () => {
    const why = hardwareVerdict({ a: small, b: small }, { a: big, b: small });
    expect(why).toMatch(/^not resized: b /);
  });

  it('fails when nothing changed, memory jitter between boots included', () => {
    const rebooted = { cpus: 2, memKiB: small.memKiB + 4096 };
    expect(hardwareVerdict({ a: small }, { a: rebooted })).toMatch(/^not resized: a /);
  });

  it('passes a rung that adds vCPUs while memory moves only by jitter', () => {
    expect(
      hardwareVerdict({ a: small }, { a: { cpus: 4, memKiB: small.memKiB - 4096 } }),
    ).toBeNull();
  });

  it('fails when a side could not be read at all', () => {
    expect(hardwareVerdict({}, { a: big })).toMatch(/could not read the servers' size over ssh/);
    expect(hardwareVerdict({ a: small }, {})).toMatch(/could not read the servers' size over ssh/);
  });
});

describe('readHardware', () => {
  const ok = (stdout: string) => ({ ok: true, status: 0, stdout, stderr: '', message: '' });
  const failed = { ok: false, status: 255, stdout: '', stderr: 'refused', message: 'ssh failed' };

  it('reads each server with the one command, and leaves out those that fail', () => {
    const run = vi.fn((ip: string) => (ip === 'b' ? failed : ok('4\n8000000')));
    expect(readHardware(['a', 'b'], '/k', run)).toEqual({ a: { cpus: 4, memKiB: 8000000 } });
    expect(run).toHaveBeenCalledWith('a', '/k', HARDWARE_COMMAND, 30_000);
  });

  it('reads nothing without a key', () => {
    const run = vi.fn();
    expect(readHardware(['a'], null, run)).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });
});
