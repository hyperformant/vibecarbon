import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Census: every DigitalOcean resource that makes DO run a droplet action gets
 * its `dropletId` through `waitForDropletIdle`.
 *
 * A droplet takes one action at a time, and the provider's droplet Create
 * returns at status `active`, before the `create` action completes. An assign,
 * attach, snapshot or resize that races it gets a 422 "Droplet already has a
 * pending event" (k8s-ha restore deploy, 2026-11-04). Firewall `dropletIds`
 * and project resources are not droplet actions and are not checked.
 */
const PROGRAMS = join(__dirname, '../../../src/lib/iac/programs');
const ACTION_TYPES = ['ReservedIpAssignment', 'VolumeAttachment', 'ReservedIp', 'Snapshot'];

/** Arguments text of each `new digitalocean.<Type>(` call, brace-balanced. */
function constructorArgs(src: string, type: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`new digitalocean\\.${type}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

describe('droplet-action resources wait for the droplet to be idle', () => {
  const files = readdirSync(PROGRAMS).filter((f) => /^digitalocean-.*\.js$/.test(f));

  it('finds the DO programs', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const src = readFileSync(join(PROGRAMS, file), 'utf8');
    for (const type of ACTION_TYPES) {
      for (const args of constructorArgs(src, type)) {
        if (!/\bdropletId\s*:/.test(args)) continue;
        it(`${file}: ${type} dropletId comes through waitForDropletIdle`, () => {
          const line = args.slice(args.search(/\bdropletId\s*:/));
          expect(line.split(/\n\s*\}\)/)[0]).toContain('waitForDropletIdle');
        });
      }
    }
  }

  it('covers at least the k8s ReservedIpAssignment', () => {
    const src = readFileSync(join(PROGRAMS, 'digitalocean-k8s.js'), 'utf8');
    expect(constructorArgs(src, 'ReservedIpAssignment').length).toBeGreaterThan(0);
  });
});
