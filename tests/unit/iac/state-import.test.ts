/**
 * importStackState (lib/iac/index.js): the one way src imports a deployment.
 *
 * The SDK's Stack.importStack writes the whole deployment, secrets in plain
 * text, to `<os tmpdir>/automation-<6 digits>` readable by every local user,
 * and leaves it there whenever the import fails. The helper writes it to a
 * 0600 file in a 0700 directory inside the stack's own workspace directory,
 * and removes it whether the import works or not. The census below holds
 * every import in src to it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importStackState } from '../../../src/lib/iac/index.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const SENTINEL = 'SENTINEL-import-secret-5a1b';
const DEPLOYMENT = {
  version: 3,
  deployment: {
    resources: [
      {
        type: 'hcloud:index/server:Server',
        inputs: { userData: SENTINEL },
      },
    ],
  },
};

/** What the workspace's pulumi saw while the import ran. */
interface Seen {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  file: string;
  content: string;
  fileMode: number;
  dirMode: number;
}

function workspaceStack(answer: () => unknown = () => ({ code: 0 }), pulumiHome?: string) {
  const seen: Seen[] = [];
  const workDir = createTempDir('state-import-workdir-');
  const stack = {
    name: 'e1',
    workspace: {
      workDir,
      pulumiHome,
      envVars: { PULUMI_CONFIG_PASSPHRASE: 'pass', PULUMI_BACKEND_URL: 'file:///x' },
      pulumiCommand: {
        command: '/nonexistent/fake-pulumi',
        run: async (args: string[], cwd: string, env: Record<string, string | undefined>) => {
          const file = args[args.indexOf('--file') + 1];
          seen.push({
            args: [...args],
            cwd,
            env: { ...env },
            file,
            content: readFileSync(file, 'utf8'),
            fileMode: statSync(file).mode & 0o777,
            dirMode: statSync(dirname(file)).mode & 0o777,
          });
          return answer();
        },
      },
    },
  };
  return { stack, seen, workDir };
}

describe('importStackState', () => {
  it("runs `stack import --file` from a 0600 file in a 0700 dir in the stack's workspace", async () => {
    const { stack, seen, workDir } = workspaceStack(undefined, '/home/u/.pulumi-alt');

    await importStackState(stack as never, DEPLOYMENT);

    expect(seen).toHaveLength(1);
    const [run] = seen;
    expect(run.args).toEqual(['stack', 'import', '--file', run.file, '--stack', 'e1']);
    expect(dirname(dirname(run.file))).toBe(workDir);
    expect(run.fileMode).toBe(0o600);
    expect(run.dirMode).toBe(0o700);
    expect(JSON.parse(run.content)).toEqual(DEPLOYMENT);
    // The workspace's own command line: its directory and its environment.
    expect(run.cwd).toBe(workDir);
    expect(run.env).toEqual({
      PULUMI_HOME: '/home/u/.pulumi-alt',
      PULUMI_CONFIG_PASSPHRASE: 'pass',
      PULUMI_BACKEND_URL: 'file:///x',
    });
    // Nothing is left behind.
    expect(existsSync(dirname(run.file))).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('a failed import throws its own error and still leaves no file', async () => {
    const refusal = new Error('code: 255\n stdout: \n stderr: error: failed to encrypt');
    const { stack, seen, workDir } = workspaceStack(() => {
      throw refusal;
    });

    await expect(importStackState(stack as never, DEPLOYMENT)).rejects.toBe(refusal);

    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0].file)).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('the deployment never reaches the OS temp dir', async () => {
    const { stack, seen } = workspaceStack();
    await importStackState(stack as never, DEPLOYMENT);
    expect(seen[0].file.startsWith(join(tmpdir(), 'automation-'))).toBe(false);
    expect(seen[0].file.startsWith(stack.workspace.workDir)).toBe(true);
  });
});

const SRC = join(import.meta.dirname, '..', '..', '..', 'src');

/** `source` with comments blanked out, so prose cannot count as a call. */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const code = (file: string) => blankComments(readFileSync(file, 'utf8'));

const srcFiles = readdirSync(SRC, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.js'))
  .map((d) => join(d.parentPath, d.name));

/** The SDK's import, under any spelling: a call, a reference, a computed key. */
const SDK_IMPORT = /\bimportStack\b/;
/** `stack import` as argv: what importStackState runs. */
const IMPORT_ARGV = /['"`]stack['"`]\s*,\s*['"`]import['"`]/g;

describe('state import census', () => {
  it('each check finds what it is for', () => {
    expect(SDK_IMPORT.test(blankComments('await stack.importStack(state);'))).toBe(true);
    expect(SDK_IMPORT.test(blankComments("stack.workspace['importStack'](n, s);"))).toBe(true);
    expect(SDK_IMPORT.test(blankComments('// stack.importStack(state)\nconst x = 1;'))).toBe(false);
    const argv = "run(['stack', 'import', '--file', f]);";
    expect(blankComments(argv).match(IMPORT_ARGV)).toHaveLength(1);
  });

  it('no src code reaches the SDK import (stack.importStack or workspace.importStack)', () => {
    const offenders = srcFiles.filter((f) => SDK_IMPORT.test(code(f)));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
    // Sanity floor: the walk sees the iac layer.
    expect(srcFiles.map((f) => f.slice(SRC.length + 1))).toContain('lib/iac/index.js');
  });

  it('`stack import` is spelled once in src, inside importStackState', () => {
    const hits = srcFiles.flatMap((f) =>
      [...code(f).matchAll(IMPORT_ARGV)].map((m) => ({ file: f, index: m.index ?? 0 })),
    );
    expect(hits).toHaveLength(1);
    const [{ file, index }] = hits;
    expect(file.slice(SRC.length + 1)).toBe('lib/iac/index.js');
    const text = code(file);
    const start = text.indexOf('export async function importStackState(');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n}\n', start);
    expect(index).toBeGreaterThan(start);
    expect(index).toBeLessThan(end);
  });
});
