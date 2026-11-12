/**
 * The Pulumi workspace directories a process makes (lib/iac/workspace-dir.js)
 * are gone once it exits, however it exits, in a real child process. The
 * first test opens a stack through the real Automation SDK and Pulumi CLI,
 * so it also proves the SDK runs in the directory it was given instead of
 * making its own `automation-*` one.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { statePassphraseFingerprint } from '../../../src/lib/state-passphrase.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const SRC = join(import.meta.dirname, '..', '..', '..', 'src');
const WORKSPACE_DIR = pathToFileURL(join(SRC, 'lib/iac/workspace-dir.js')).href;
const IAC = pathToFileURL(join(SRC, 'lib/iac/index.js')).href;
const PASSPHRASE = 'd29ya3NwYWNld29ya3NwYWNld29ya3NwYWNld29ya3Nw';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const root = createTempDir('vc-workspace-dir-exit-');

/**
 * Run `body` as an ES module in a new node process. It prints one JSON line
 * (`report`) before it ends the way the test asks.
 */
function runChild(body: string, env: Record<string, string> = {}) {
  const script = [
    `import { readdirSync } from 'node:fs';`,
    `const { makeWorkspaceDir, __workspaceDirsForTests } = await import(${JSON.stringify(WORKSPACE_DIR)});`,
    `const report = (o) => console.log(JSON.stringify(o));`,
    body,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
    // The child's temp dir is this file's, so the temp-dir census sees
    // whatever it leaves.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: tmpdir(), ...env },
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error(`child printed no report: ${result.stderr}`);
  return { status: result.status, report: JSON.parse(line), stderr: result.stderr };
}

/** Two directories, one holding what a workspace leaves: its project file and the stack's salt. */
const MAKE_TWO = `
const dirs = [makeWorkspaceDir(), makeWorkspaceDir()];
(await import('node:fs')).writeFileSync(dirs[0] + '/Pulumi.yaml', 'name: p\\n');
(await import('node:fs')).writeFileSync(dirs[0] + '/Pulumi.e1.yaml', 'encryptionsalt: v1:x\\n');
report({ dirs, files: dirs.map((d) => readdirSync(d).sort()) });
`;

describe('workspace directories are removed when the process exits', () => {
  it.runIf(hasPulumi || process.env.CI)(
    'a real stack open: every workspace ran in a directory of ours, and none is left after exit',
    () => {
      expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
      const projectDir = join(root, 'project');
      const backend = join(root, 'state');
      mkdirSync(projectDir);
      mkdirSync(backend);
      writeFileSync(
        join(projectDir, '.vibecarbon.json'),
        `${JSON.stringify({ stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } })}\n`,
      );
      const { status, report, stderr } = runChild(
        `
const { getOrCreateStack } = await import(${JSON.stringify(IAC)});
const stack = await getOrCreateStack('exit-e1', async () => ({}), {
  projectName: 'workspacedirtest',
  projectDir: ${JSON.stringify(projectDir)},
});
report({
  workDir: stack.workspace.workDir,
  files: readdirSync(stack.workspace.workDir).sort(),
  dirs: __workspaceDirsForTests(),
});
`,
        {
          PULUMI_BACKEND_URL: `file://${backend}`,
          // Pulumi records each workspace's selected stack under its home:
          // this test's records stay in its own.
          PULUMI_HOME: join(root, 'pulumi-home'),
          PULUMI_SKIP_UPDATE_CHECK: 'true',
          VIBECARBON_STATE_PASSPHRASE: PASSPHRASE,
        },
      );
      expect(status, stderr).toBe(0);
      // A first open: the select that found nothing, the listing that
      // corroborated it, and the create, each in its own directory.
      expect(report.dirs).toHaveLength(3);
      expect(report.dirs).toContain(report.workDir);
      expect(report.files).toEqual(['Pulumi.exit-e1.yaml', 'Pulumi.yaml']);
      for (const dir of report.dirs) {
        expect(basename(dir)).toMatch(/^vibecarbon-pulumi-/);
        expect(existsSync(dir), dir).toBe(false);
      }
      // And the SDK made none of its own in the temp dir the child shared.
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('automation-'))).toEqual([]);
    },
    60_000,
  );

  it('the event loop runs out', () => {
    const { status, report } = runChild(MAKE_TWO);
    expect(status).toBe(0);
    expect(report.files).toEqual([['Pulumi.e1.yaml', 'Pulumi.yaml'], []]);
    for (const dir of report.dirs) expect(existsSync(dir)).toBe(false);
  });

  it('process.exit with an error code, which it keeps', () => {
    const { status, report } = runChild(`${MAKE_TWO}\nprocess.exit(3);`);
    expect(status).toBe(3);
    for (const dir of report.dirs) expect(existsSync(dir)).toBe(false);
  });

  it('an uncaught throw', () => {
    const { status, report, stderr } = runChild(
      `${MAKE_TWO}\nsetTimeout(() => { throw new Error('boom'); }, 0);`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('boom');
    for (const dir of report.dirs) expect(existsSync(dir)).toBe(false);
  });

  it("Ctrl-C, through cli.js's SIGINT handler", () => {
    const { status, report } = runChild(
      // src/cli.js: process.on('SIGINT', () => process.exit(130)).
      `process.on('SIGINT', () => process.exit(130));\n${MAKE_TWO}\nsetInterval(() => {}, 1000);\nprocess.kill(process.pid, 'SIGINT');`,
    );
    expect(status).toBe(130);
    for (const dir of report.dirs) expect(existsSync(dir)).toBe(false);
  });
});
