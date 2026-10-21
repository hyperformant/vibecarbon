import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { progressLog } from '../../../src/lib/cli/progress.js';
import {
  buildImageCopyScript,
  copyAppImageToStandby,
  firstCauseLine,
} from '../../../src/lib/deploy/k8s/ha/image-copy.js';
import { MANIFEST_ACCEPT } from '../../../src/lib/deploy/k8s/image-delivery.js';

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

const base = {
  primaryRef: '10.0.1.1:5000/quorum:t1',
  primaryIp: 'P',
  standbyIp: 'S',
  primaryMasterPrivateIp: '10.0.1.1',
  standbyMasterPrivateIp: '10.0.1.1',
  standbyDbIp: 'SDB',
  sshKeyPath: '/k',
  relay: async (_a: unknown, fn: () => Promise<unknown>) => fn(),
};
const stderrErr = (stderr: string) =>
  Object.assign(new Error('Command failed: ssh -i /k root@SDB sh -s'), { stderr });

describe('buildImageCopyScript', () => {
  const s = buildImageCopyScript({
    srcRef: '10.99.0.1:15000/quorum:t1',
    dstRef: '10.0.1.1:5000/quorum:t1',
  });
  it('pulls through the relay and pushes remote-first, in the copy namespace only', () => {
    expect(s).toContain('images pull --plain-http --all-platforms 10.99.0.1:15000/quorum:t1');
    expect(s).toContain(
      'images push --plain-http 10.0.1.1:5000/quorum:t1 10.99.0.1:15000/quorum:t1',
    );
    expect(s).toContain('-n vibecarbon-imgcopy');
    expect(s).not.toContain('-n k8s.io');
    expect(s).toMatch(/trap '.*images rm/);
    expect(s).toContain(MANIFEST_ACCEPT);
    expect(s.indexOf('SKIPPED=1')).toBeLessThan(s.indexOf('images pull'));
  });
  it('never writes to the primary registry', () => {
    expect(s).not.toMatch(/push[^\n]*10\.99\.0\.1:15000\/quorum:t1 10\.0\.1\.1/);
    expect(s).not.toMatch(/curl[^\n]*-X/);
  });
  it('refuses a ref that is not shell-safe', () => {
    expect(() =>
      buildImageCopyScript({ srcRef: '10.99.0.1:15000/q;rm:t', dstRef: '10.0.1.1:5000/q:t' }),
    ).toThrow(/not an image ref/);
    expect(() =>
      buildImageCopyScript({ srcRef: '10.99.0.1:15000/quorum:t1', dstRef: '10.0.1.1:5000/quorum' }),
    ).toThrow(/not an image ref/);
  });
});

describe('firstCauseLine', () => {
  it('prefers the ERR= payload', () => {
    expect(firstCauseLine(stderrErr('Warning: x\nnoise\nERR=boom\n'))).toBe('boom');
  });
  it('skips ssh warnings and blank lines', () => {
    expect(firstCauseLine(stderrErr("Warning: Permanently added 'h'\n\n  real cause  \n"))).toBe(
      'real cause',
    );
  });
  it('falls back to the first line of the message', () => {
    expect(firstCauseLine(new Error('one\ntwo'))).toBe('one');
    expect(firstCauseLine(stderrErr('Warning: only\n'))).toBe(
      'Command failed: ssh -i /k root@SDB sh -s',
    );
  });
  it('reads a Buffer stderr', () => {
    expect(firstCauseLine(stderrErr(Buffer.from('ctr: nope\n') as unknown as string))).toBe(
      'ctr: nope',
    );
  });
});

describe('copyAppImageToStandby', () => {
  it('skips on equal digests without pulling', async () => {
    const run = vi.fn(async () => 'SRC_DIGEST=sha256:aa\nDST_DIGEST=sha256:aa\nSKIPPED=1');
    await expect(copyAppImageToStandby({ ...base, run })).resolves.toEqual({
      digest: 'sha256:aa',
      skipped: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(progressLog).toHaveBeenCalledWith('[image-copy] standby already has sha256:aa');
  });
  it('reports a copy', async () => {
    const run = vi.fn(async () => 'SRC_DIGEST=sha256:aa\nDST_DIGEST=\nCOPIED=1');
    await expect(copyAppImageToStandby({ ...base, run })).resolves.toEqual({
      digest: 'sha256:aa',
      skipped: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(progressLog).toHaveBeenCalledWith('[image-copy] copied quorum:t1 (sha256:aa)');
  });
  it('output without a verdict is a failure, not a success', async () => {
    const run = vi.fn(async () => 'SRC_DIGEST=sha256:aa\nDST_DIGEST=');
    await expect(copyAppImageToStandby({ ...base, run })).rejects.toThrow(
      /^standby image copy failed: the copy script reported neither SKIPPED nor COPIED$/,
    );
  });
  it('a digest mismatch fails with exactly one line', async () => {
    const run = vi.fn(async () => {
      throw stderrErr('ERR=digest mismatch: primary sha256:aa, standby sha256:bb\nmore\n');
    });
    const err = await copyAppImageToStandby({ ...base, run }).catch((e) => e);
    expect(err.message).toBe(
      'standby image copy failed: digest mismatch: primary sha256:aa, standby sha256:bb',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('any other failure reports the first real stderr line, never the ssh argv', async () => {
    const run = vi.fn(async () => {
      throw stderrErr(
        "Warning: Permanently added 'SDB'\n\nctr: failed to resolve reference\nsecond\n",
      );
    });
    const err = await copyAppImageToStandby({ ...base, run }).catch((e) => e);
    expect(err.message).toBe('standby image copy failed: ctr: failed to resolve reference');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('a relay failure is the copy failure', async () => {
    const run = vi.fn();
    const relay = async () => {
      throw new Error('registry relay not ready on the primary: timed out');
    };
    await expect(copyAppImageToStandby({ ...base, run, relay })).rejects.toThrow(
      /^standby image copy failed: registry relay not ready on the primary: timed out$/,
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('a relay failure stays one line even when the relay explains itself', async () => {
    const relay = async () => {
      throw new Error('registry relay not ready on the primary: timed out\npod phase: Pending');
    };
    const err = await copyAppImageToStandby({ ...base, run: vi.fn(), relay }).catch((e) => e);
    expect(err.message).toBe(
      'standby image copy failed: registry relay not ready on the primary: timed out',
    );
    expect(progressLog).toHaveBeenCalledWith('[image-copy] pod phase: Pending');
  });
  it('hands the relay the primary-side args', async () => {
    const relay = vi.fn(async (_a: unknown, fn: () => Promise<unknown>) => fn());
    const run = vi.fn(async () => 'SRC_DIGEST=sha256:aa\nDST_DIGEST=sha256:aa\nSKIPPED=1');
    await copyAppImageToStandby({ ...base, run, relay });
    expect(relay).toHaveBeenCalledWith(
      { primaryIp: 'P', standbyIp: 'S', primaryMasterPrivateIp: '10.0.1.1', sshKeyPath: '/k' },
      expect.any(Function),
    );
  });
  it('runs the script on the standby DB node against the standby master registry', async () => {
    let seen = '';
    const run = vi.fn(async (script: string) => {
      seen = script;
      return 'SRC_DIGEST=sha256:aa\nDST_DIGEST=sha256:aa\nSKIPPED=1';
    });
    await copyAppImageToStandby({ ...base, standbyMasterPrivateIp: '10.120.0.3', run });
    expect(seen).toContain('10.120.0.3:5000/quorum:t1');
    expect(seen).toContain('10.99.0.1:15000/quorum:t1');
  });
});

describe('the copy script runs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  // curl answers a HEAD by host: SRC for the relay, DST for the standby
  // registry (DST_AFTER once k3s has pushed). k3s only logs (and marks a push).
  function runScript({ src, dst, dstAfter }: { src: string; dst: string; dstAfter: string }) {
    dir = mkdtempSync(join(tmpdir(), 'imgcopy-stub-'));
    const log = join(dir, 'log');
    const pushed = join(dir, 'pushed');
    const hdr = (d: string) =>
      d ? `printf 'HTTP/1.1 200 OK\\r\\nDocker-Content-Digest: ${d}\\r\\n'` : 'exit 22';
    writeFileSync(
      join(dir, 'curl'),
      `#!/bin/sh
echo "curl $*" >> '${log}'
for a; do url="$a"; done
case "$url" in
  http://10.99.0.1:15000/*) ${hdr(src)} ;;
  *) if [ -e '${pushed}' ]; then ${hdr(dstAfter)}; else ${hdr(dst)}; fi ;;
esac
`,
    );
    writeFileSync(
      join(dir, 'k3s'),
      `#!/bin/sh
echo "k3s $*" >> '${log}'
case "$*" in *"images push"*) : > '${pushed}' ;; esac
exit 0
`,
    );
    chmodSync(join(dir, 'curl'), 0o755);
    chmodSync(join(dir, 'k3s'), 0o755);
    const r = spawnSync('sh', ['-s'], {
      input: buildImageCopyScript({
        srcRef: '10.99.0.1:15000/quorum:t1',
        dstRef: '10.0.1.1:5000/quorum:t1',
      }),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const k3s = lines.filter((l) => l.startsWith('k3s ')).map((l) => l.slice(4));
    return { ...r, k3s };
  }

  it('equal digests: skips without touching k3s', () => {
    const r = runScript({ src: 'sha256:aa', dst: 'sha256:aa', dstAfter: 'sha256:aa' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SKIPPED=1');
    expect(r.stdout).toContain('SRC_DIGEST=sha256:aa');
    expect(r.k3s).toEqual([]);
  });
  it('a fresh copy pulls, pushes, verifies and cleans up', () => {
    const r = runScript({ src: 'sha256:aa', dst: '', dstAfter: 'sha256:aa' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('COPIED=1');
    expect(r.k3s).toEqual([
      'ctr -n vibecarbon-imgcopy images pull --plain-http --all-platforms 10.99.0.1:15000/quorum:t1',
      'ctr -n vibecarbon-imgcopy images push --plain-http 10.0.1.1:5000/quorum:t1 10.99.0.1:15000/quorum:t1',
      'ctr -n vibecarbon-imgcopy images rm 10.99.0.1:15000/quorum:t1',
    ]);
  });
  it('a destination digest that differs after the push: exit 4, and the trap still removes the copy', () => {
    const r = runScript({ src: 'sha256:aa', dst: '', dstAfter: 'sha256:bb' });
    expect(r.status).toBe(4);
    expect(r.stderr.split('\n')[0]).toBe(
      'ERR=digest mismatch: primary sha256:aa, standby sha256:bb',
    );
    expect(r.k3s.at(-1)).toBe('ctr -n vibecarbon-imgcopy images rm 10.99.0.1:15000/quorum:t1');
  });
  it('an empty source digest: exit 3 naming the missing tag', () => {
    const r = runScript({ src: '', dst: '', dstAfter: '' });
    expect(r.status).toBe(3);
    expect(r.stderr.split('\n')[0]).toBe('ERR=primary registry has no quorum:t1');
    expect(r.k3s).toEqual([]);
  });
});
