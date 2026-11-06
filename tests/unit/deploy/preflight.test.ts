import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkDeployPrerequisites } from '../../../src/lib/deploy/preflight.js';
import { readSshVersion } from '../../../src/lib/runtime-floors.js';

// A stub PATH-lookup: present unless listed in `absent`.
const has = (absent: string[]) => (bin: string) => !absent.includes(bin);
// k8s tiers read the Pulumi version; never shell out from a unit test.
const pulumiVersion = () => '3.273.0';

describe('checkDeployPrerequisites', () => {
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha']) {
    it(`throws a pulumi-install hint when pulumi is missing (${tier})`, () => {
      expect(() => checkDeployPrerequisites(tier, { has: has(['pulumi']), pulumiVersion })).toThrow(
        /pulumi/,
      );
      expect(() => checkDeployPrerequisites(tier, { has: has(['pulumi']), pulumiVersion })).toThrow(
        /get\.pulumi\.com/,
      );
    });

    it(`does not throw when pulumi + ssh are present (${tier})`, () => {
      expect(() => checkDeployPrerequisites(tier, { has: has([]), pulumiVersion })).not.toThrow();
    });
  }

  it('names ssh when ssh is missing', () => {
    expect(() => checkDeployPrerequisites('compose', { has: has(['ssh']) })).toThrow(/ssh/);
  });

  it('lists every missing tool at once', () => {
    let message = '';
    try {
      checkDeployPrerequisites('k8s', { has: has(['pulumi', 'ssh']), pulumiVersion });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/pulumi/);
    expect(message).toMatch(/ssh/);
  });

  it('does not raise an ENOENT-style error (message is human-readable)', () => {
    expect(() => checkDeployPrerequisites('compose', { has: has(['pulumi']) })).toThrow(
      /Missing host-side tools/,
    );
  });
});

describe('the OpenSSH floor at deploy preflight', () => {
  const ok = { has: has([]), pulumiVersion };

  it('refuses a client under the floor, with what was found, needed and what to do', () => {
    const run = () =>
      checkDeployPrerequisites('compose', {
        ...ok,
        sshVersion: () => 'OpenSSH_7.5p1-hpn14v4, LibreSSL 2.5.5',
      });
    expect(run).toThrow(/OpenSSH 7\.5\.0 is too old/);
    expect(run).toThrow(/7\.6\.0 or newer/);
    expect(run).toThrow(/accept-new/);
    expect(run).toThrow(/then deploy again/);
  });

  it('passes the floor and newer', () => {
    for (const v of ['OpenSSH_7.6p1 Ubuntu-4ubuntu0.7', 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.20']) {
      expect(() =>
        checkDeployPrerequisites('compose', { ...ok, sshVersion: () => v }),
      ).not.toThrow();
    }
  });

  it('an ssh it cannot read warns and the deploy continues', () => {
    const warn = vi.fn();
    expect(() =>
      checkDeployPrerequisites('compose', { ...ok, sshVersion: () => 'Sun_SSH_1.1', warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Could not read the OpenSSH version.*Continuing/);
  });

  it('a Pulumi it cannot read warns too', () => {
    const warn = vi.fn();
    checkDeployPrerequisites('k8s', { has: has([]), pulumiVersion: () => null, warn });
    expect(warn.mock.calls[0][0]).toMatch(/Could not read the Pulumi version.*Continuing/);
  });

  it('readSshVersion reads stderr, where ssh -V prints, and never throws', () => {
    const spawn = vi.fn(() => ({ stdout: '', stderr: 'OpenSSH_9.6p1\n' }));
    expect(readSshVersion({ spawn: spawn as never })).toBe('OpenSSH_9.6p1');
    const boom = () => {
      throw new Error('ENOENT');
    };
    expect(readSshVersion({ spawn: boom as never })).toBeNull();
  });

  it('the deploy path passes the reader in', () => {
    const text = readFileSync(join(process.cwd(), 'src/lib/deploy/orchestrator.js'), 'utf8');
    expect(text).toMatch(/checkDeployPrerequisites\(tier, \{[^}]*sshVersion: readSshVersion/);
  });

  it('a deploy never reads the local Compose: only `up` runs it', () => {
    const text = readFileSync(join(process.cwd(), 'src/lib/deploy/preflight.js'), 'utf8');
    expect(text).not.toMatch(/'compose', 'version'/);
  });
});
