/**
 * PATH-based exec stubbing for child processes spawned by the CLI.
 *
 * The CLI under test runs in a separate Node process — globalThis
 * patches in the harness can't reach it. To intercept calls to ssh,
 * docker, kubectl, helm, pulumi (etc.), we write a temp dir of
 * executable shell scripts (one per stubbed command name), prepend that
 * dir to PATH in the spawned CLI's env, and have each script:
 *
 *   1. Append a JSON line describing the invocation to a shared log file.
 *   2. Find the first matching stub spec (by argv pattern) and emit its
 *      stdout/stderr + exit code. Falls back to exit 0 + empty output.
 *
 * Tests use `runCli({ env: { PATH: stubs.binPath + ':' + process.env.PATH } })`
 * (or pass through the convenience wrapper) and then read stubs.calls()
 * to assert the CLI invoked the expected commands with expected args.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ExecStubSpec {
  /** Command name as it appears on PATH (e.g. "ssh", "docker", "kubectl"). */
  command: string;
  /**
   * Optional regex matched against the joined argv. If multiple stubs
   * share a command name, the FIRST matching one wins.
   */
  matches?: RegExp;
  /** Default response if the matcher fires (or there's no matcher). */
  respond: { stdout?: string; stderr?: string; exitCode?: number };
}

export interface ExecCall {
  command: string;
  argv: string[];
  /** ISO timestamp of the call. */
  ts: string;
}

export interface ExecStubs {
  /** Directory to prepend to PATH. */
  binPath: string;
  /** Read all calls recorded so far. */
  calls(): ExecCall[];
  /** Helper: filter calls by command name. */
  callsTo(command: string): ExecCall[];
  /** Tear down the temp dir. */
  teardown(): void;
}

/**
 * Install stubs for a set of commands.
 *
 *     const stubs = installExecStubs([
 *       { command: 'ssh', respond: { stdout: 'ok\n' } },
 *       { command: 'docker', matches: /^compose up/, respond: { stdout: 'started\n' } },
 *     ]);
 *     const r = runCli('up', [], { cwd: fix, env: { PATH: `${stubs.binPath}:${process.env.PATH}` } });
 *     expect(stubs.callsTo('docker')[0].argv).toContain('up');
 *     stubs.teardown();
 */
export function installExecStubs(specs: ExecStubSpec[]): ExecStubs {
  const dir = mkdtempSync(join(tmpdir(), 'vibecarbon-exec-stubs-'));
  const binDir = join(dir, 'bin');
  const logPath = join(dir, 'calls.jsonl');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logPath, '');

  // Group specs by command name.
  const byCommand = new Map<string, ExecStubSpec[]>();
  for (const spec of specs) {
    const list = byCommand.get(spec.command) ?? [];
    list.push(spec);
    byCommand.set(spec.command, list);
  }

  // Write one wrapper script per unique command. The script logs its
  // invocation, then walks the stub list looking for a regex match.
  for (const [command, commandSpecs] of byCommand) {
    const script = renderWrapperScript(command, commandSpecs, logPath);
    const path = join(binDir, command);
    writeFileSync(path, script, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  return {
    binPath: binDir,
    calls(): ExecCall[] {
      const raw = readFileSync(logPath, 'utf-8');
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ExecCall);
    },
    callsTo(command: string): ExecCall[] {
      return this.calls().filter((c) => c.command === command);
    },
    teardown(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function renderWrapperScript(command: string, specs: ExecStubSpec[], logPath: string): string {
  // We use Node for the wrapper (always available, cross-platform).
  // The shebang points to /usr/bin/env node.
  const specsJson = JSON.stringify(
    specs.map((s) => ({
      pattern: s.matches?.source ?? null,
      flags: s.matches?.flags ?? '',
      stdout: s.respond.stdout ?? '',
      stderr: s.respond.stderr ?? '',
      exitCode: s.respond.exitCode ?? 0,
    })),
  );
  return [
    '#!/usr/bin/env node',
    '"use strict";',
    'const fs = require("fs");',
    `const command = ${JSON.stringify(command)};`,
    `const logPath = ${JSON.stringify(logPath)};`,
    `const specs = ${specsJson};`,
    'const argv = process.argv.slice(2);',
    'const joined = argv.join(" ");',
    'const call = { command, argv, ts: new Date().toISOString() };',
    'fs.appendFileSync(logPath, JSON.stringify(call) + "\\n");',
    'for (const spec of specs) {',
    '  let match = true;',
    '  if (spec.pattern) {',
    '    try { match = new RegExp(spec.pattern, spec.flags).test(joined); } catch { match = false; }',
    '  }',
    '  if (match) {',
    '    if (spec.stdout) process.stdout.write(spec.stdout);',
    '    if (spec.stderr) process.stderr.write(spec.stderr);',
    '    process.exit(spec.exitCode);',
    '  }',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
}
