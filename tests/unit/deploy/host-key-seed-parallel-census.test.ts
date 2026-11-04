/**
 * Census: when a deploy pins the host keys of several servers, it scans them
 * together, never one after another.
 *
 * seedKnownHosts is one ssh-keyscan per server (with its own short retry for
 * a server whose sshd is not up yet). Run in series, a k3s cluster paid one
 * round trip per node: about 13 s for the two nodes of the DO tor1 standby on
 * an evening path, against about 2.5 s for three sfo3 nodes. Run together,
 * the cluster pays for its slowest node. Concurrent seeds of one file are
 * safe: each one's read-merge-write runs after its own scan with no await
 * inside it (host-keys.test.ts proves every host survives out-of-order scans).
 *
 * The rule, over src/: no `await seedKnownHosts(` inside a loop body, and no
 * two `await seedKnownHosts(` statements back to back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

const SEED = /\bawait seedKnownHosts\(/;
const LOOP = /^\s*for\s*\(.*\)\s*\{?\s*$/;

/** Serial seeds in `text`: a seed inside a `for` body, or two seeds in a row. */
function serialSeeds(file: string, text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!SEED.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    const prev = lines
      .slice(0, i)
      .reverse()
      .find((l) => l.trim() !== '' && !/^\s*(\/\/|\*)/.test(l));
    if (prev && (SEED.test(prev) || LOOP.test(prev))) out.push(`${file}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe('host-key seeds of several servers run together', () => {
  it('no serial seedKnownHosts in src/', () => {
    const files = walk(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((f) =>
      serialSeeds(relative(ROOT, f), readFileSync(f, 'utf-8')),
    );
    expect(
      offenders,
      'scan the servers together: await Promise.all(ips.map((ip) => seedKnownHosts(khPath, ip)))',
    ).toEqual([]);
  });

  it('the k3s deploy seeds master, db and every worker together', () => {
    const k3s = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(k3s).toMatch(
      /Promise\.all\(\s*\[masterIp, dbIp, \.\.\.\(workerIps \?\? \[\]\)\]\s*\.filter\(Boolean\)\s*\.map\(\(ip\) => seedKnownHosts\(khPath, ip\)\),?\s*\)/,
    );
  });

  it('bites: a loop of seeds and two seeds in a row are both flagged', () => {
    const loop = 'for (const ip of ips) {\n  await seedKnownHosts(khPath, ip);\n}\n';
    const pair = 'await seedKnownHosts(kh, a);\nawait seedKnownHosts(kh, b);\n';
    const ok = 'await Promise.all([a, b].map((ip) => seedKnownHosts(kh, ip)));\n';
    expect(serialSeeds('x.js', loop)).toHaveLength(1);
    expect(serialSeeds('x.js', pair)).toHaveLength(1);
    expect(serialSeeds('x.js', ok)).toEqual([]);
    // A single seed is not serial.
    expect(serialSeeds('x.js', 'const kh = p;\nawait seedKnownHosts(kh, a);\n')).toEqual([]);
  });
});
