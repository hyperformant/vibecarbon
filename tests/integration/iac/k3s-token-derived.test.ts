/**
 * A first up that fails after it created a server, then its rerun, on the
 * real Pulumi engine: a file:// backend in a tmp dir and the fake cloud's
 * resource plugin (fakecloud/), whose cloud file records the user data each
 * server booted with.
 *
 * The program is shaped like the k8s programs where it matters: the k3s
 * token rides in the server's user data (a secret, ignored once the server
 * exists, create-timeout.js) and in a `k3sToken` stack output, it refuses to
 * build without a token (requireK3sToken), and an output waits on a resource
 * created after the server: a reserved IP's assignment, which fails while the
 * fake cloud has no such IP. So the first up creates the server, fails on the
 * assignment and records no outputs, as a real first k8s up that fails after
 * its servers leaves the stack.
 *
 * Both runs get their token from the deploy's own resolveStackK3sToken (the
 * real probe, classifier and derivation) and run the CLI's upStack with the
 * deploy's ledger. Pinned here:
 *   (a) the first run's probe answers `missing`, the rerun's `empty`, and both
 *       derive the same token, so the rerun records the token the server
 *       booted with and never replaces it;
 *   (b) the derived token and the passphrase never reach a pulumi argv (a
 *       PATH shim records every invocation), a log line, the deploy ledger or
 *       any backend file in plain text.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import * as pulumi from '@pulumi/pulumi';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStackK3sToken } from '../../../src/lib/deploy/k8s/k3s.js';
// @ts-expect-error: JS module without types
import { StateTracker } from '../../../src/lib/deploy/state.js';
import {
  __resetStateProbesForTests,
  getStackOutputs,
  upStack,
} from '../../../src/lib/iac/index.js';
import { deriveK3sToken, requireK3sToken } from '../../../src/lib/iac/k3s-token.js';
import {
  __resetStatePassphraseForTests,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';

const realPulumi = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v pulumi'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
})();
const hasPulumi = realPulumi !== null;

const PROJECT = 'tokentest';
const STACK = 'k1';
// Sentinel only: never a real passphrase.
const PASSPHRASE = 'c2VudGluZWwtazNzLXRva2VuLWRlcml2ZWQtcGFzc3BocmFzZQ';
const ADDRESS = '203.0.113.50';

const root = mkdtempSync(join(tmpdir(), 'vc-k3s-token-'));
const backend = join(root, 'state');
const cloudFile = join(root, 'cloud.json');
const projectDir = join(root, 'project');
const shimDir = join(root, 'shim');
const argvLog = join(root, 'pulumi-argv.log');
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');

class FakeServer extends pulumi.CustomResource {
  declare readonly ip: pulumi.Output<string>;
  constructor(
    name: string,
    args: { size: string; userData: pulumi.Input<string> },
    opts?: pulumi.CustomResourceOptions,
  ) {
    super('fakecloud:index:Server', name, { ...args, ip: undefined }, opts);
  }
}

class FakeIpAssignment extends pulumi.CustomResource {
  constructor(name: string, args: { ipAddress: string; serverId: pulumi.Input<string> }) {
    super('fakecloud:index:ReservedIpAssignment', name, args, {});
  }
}

/** A k8s-shaped program: the token in the server's user data and in the outputs. */
const program = (config: { k3sToken?: string }) => {
  const token = requireK3sToken(config, 'fakeK8sProgram');
  return async () => {
    const master = new FakeServer(
      'master',
      { size: 'small', userData: pulumi.secret(`#cloud-config\nk3s_token: ${token}\n`) },
      { ignoreChanges: ['userData'] },
    );
    const assignment = new FakeIpAssignment('master-ip', {
      ipAddress: ADDRESS,
      serverId: master.id,
    });
    return {
      masterIp: master.ip,
      assignment: assignment.id,
      k3sToken: pulumi.secret(token),
    };
  };
};

type Cloud = {
  next: number;
  servers: Record<string, { size: string; ip: string; bootedWith?: string }>;
  things: Record<string, Record<string, unknown>>;
};
const readCloud = (): Cloud => JSON.parse(readFileSync(cloudFile, 'utf8'));
const writeCloud = (c: Cloud) => writeFileSync(cloudFile, JSON.stringify(c));

/** The token a server's user data carries. */
const bootToken = (userData: string | undefined) => /k3s_token: (\S+)/.exec(userData ?? '')?.[1];

/** Every file under `dir`, with its text. */
const filesUnder = (dir: string): Array<[string, string]> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const path = join(d.parentPath, d.name);
      return [path.slice(dir.length + 1), readFileSync(path, 'utf8')];
    });

/** A ledger in the project dir, as the deploy's own (lib/deploy/state.js). */
function ledgerFor(environment: string) {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  try {
    return new StateTracker(PROJECT, environment);
  } finally {
    cwd.mockRestore();
  }
}

describe.runIf(hasPulumi || process.env.CI)(
  'a failed first k8s up and its rerun agree on the k3s token (real engine)',
  () => {
    let logged: string[];

    beforeAll(() => {
      mkdirSync(backend);
      mkdirSync(projectDir);
      mkdirSync(shimDir);
      writeFileSync(
        join(projectDir, '.vibecarbon.json'),
        `${JSON.stringify({ stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } })}\n`,
      );
      // No reserved IP yet: the first up's assignment fails after the server.
      writeCloud({ next: 1, servers: {}, things: {} });
      // Every pulumi invocation, by argv, then the real CLI.
      const shim = join(shimDir, 'pulumi');
      writeFileSync(
        shim,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${realPulumi}' "$@"\n`,
      );
      chmodSync(shim, 0o755);
    });
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });
    // Each test, not once: tests/setup/global-setup.ts resets process.env after
    // every test, and the iac layer hands its workspaces process.env.
    beforeEach(() => {
      expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
      process.env.PULUMI_BACKEND_URL = `file://${backend}`;
      process.env.FAKECLOUD_FILE = cloudFile;
      process.env.PATH = `${shimDir}:${PLUGIN_DIR}:${process.env.PATH}`;
      process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
      delete process.env.PULUMI_CONFIG_PASSPHRASE;
      delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
      __resetStatePassphraseForTests();
      __resetStateProbesForTests();
      logged = [];
      const keep = (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      };
      vi.spyOn(console, 'error').mockImplementation(keep);
      vi.spyOn(console, 'log').mockImplementation(keep);
      for (const level of ['info', 'warn', 'error', 'message', 'step', 'success'] as const) {
        vi.spyOn(p.log, level).mockImplementation(keep);
      }
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('the rerun records the token the server booted with, and neither secret leaks', async () => {
      const opts = { projectName: PROJECT, projectDir, log: (m: string) => logged.push(m) };
      const programConfig = { projectName: PROJECT, environment: STACK };
      const expected = deriveK3sToken({
        passphrase: PASSPHRASE,
        projectName: PROJECT,
        stackName: STACK,
      });

      // First run: no stack yet. The up creates the server, then fails.
      const first = await resolveStackK3sToken(programConfig, opts);
      expect(first).toEqual({ k3sToken: expected, k3sTokenReplayed: false });
      expect(logged.join('\n')).toContain('k3s token probe: missing');
      await expect(
        upStack(STACK, program(first), {
          projectName: PROJECT,
          projectDir,
          ledger: ledgerFor(STACK),
        }),
      ).rejects.toThrow(/no reserved IP/);

      const afterFirst = readCloud();
      const servers = Object.entries(afterFirst.servers);
      expect(servers).toHaveLength(1);
      const [serverId, server] = servers[0];
      expect(bootToken(server.bootedWith)).toBe(expected);
      // The failed up recorded no outputs: the rerun cannot replay a token.
      __resetStateProbesForTests();
      const recorded = await getStackOutputs(STACK, async () => ({}), {
        projectName: PROJECT,
        projectDir,
      });
      expect(recorded).not.toHaveProperty('k3sToken');

      // The cause is fixed (the IP exists now) and the deploy runs again.
      afterFirst.things['fakecloud:index:ReservedIp'] = { [ADDRESS]: { name: 'ip' } };
      writeCloud(afterFirst);
      __resetStateProbesForTests();
      const mark = logged.length;
      const rerun = await resolveStackK3sToken(programConfig, opts);
      expect(logged.slice(mark).join('\n')).toContain('k3s token probe: empty');
      expect(rerun).toEqual({ k3sToken: expected, k3sTokenReplayed: false });
      const { outputs } = await upStack(STACK, program(rerun), {
        projectName: PROJECT,
        projectDir,
        ledger: ledgerFor(STACK),
      });

      // (a) The stack records the token the server booted with, and the
      // server is the same one.
      expect(outputs.k3sToken).toBe(bootToken(server.bootedWith));
      const afterRerun = readCloud();
      expect(Object.keys(afterRerun.servers)).toEqual([serverId]);

      // A later deploy replays it.
      __resetStateProbesForTests();
      const replay = await resolveStackK3sToken(programConfig, opts);
      expect(replay).toEqual({ k3sToken: expected, k3sTokenReplayed: true });

      // (b) Neither secret in a pulumi argv, a log line, the ledger or the
      // backend's files. Non-vacuous: the shim saw the ups, the backend holds
      // the stack.
      const argv = readFileSync(argvLog, 'utf8');
      expect(argv).toMatch(/^up\b/m);
      const ledgerFiles = existsSync(join(projectDir, '.vibecarbon'))
        ? filesUnder(join(projectDir, '.vibecarbon'))
        : [];
      const backendFiles = filesUnder(backend);
      expect(backendFiles.map(([f]) => f)).toContain(`.pulumi/stacks/${PROJECT}/${STACK}.json`);
      for (const secret of [expected, PASSPHRASE]) {
        expect(argv).not.toContain(secret);
        expect(logged.join('\n')).not.toContain(secret);
        for (const [file, text] of [...ledgerFiles, ...backendFiles]) {
          expect(text.includes(secret), `${file} holds a secret in plain text`).toBe(false);
        }
      }
    });
  },
);
