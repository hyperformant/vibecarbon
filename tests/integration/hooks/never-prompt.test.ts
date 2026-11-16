// Both hooks run in the background, where nobody is watching for a prompt. A
// fetch whose login fails must fail quietly instead of asking for a password.
// The rig's remote is an ssh URL and `ssh` on PATH is a recorder that always
// fails, so each test reads the exact argv and environment git gave ssh.
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, makeRig, type Rig, readText, runHook } from './_repo.js';

const rigs: Rig[] = [];

afterEach(() => {
  for (const r of rigs.splice(0)) r.cleanup();
});

/** Point origin at an ssh URL and put a recording, always-failing ssh first on PATH. */
function sshRig(): { r: Rig; log: string; path: string } {
  const r = makeRig();
  rigs.push(r);
  const log = join(r.root, 'ssh-calls.log');
  const ssh = join(r.binDir, 'ssh');
  writeFileSync(
    ssh,
    [
      '#!/bin/sh',
      `{ printf 'argv=%s\\n' "$*"`,
      `  printf 'prompt=%s\\n' "\${GIT_TERMINAL_PROMPT-unset}"`,
      `  printf 'askpass=%s\\n' "\${GIT_ASKPASS-unset}"; } >> "${log}"`,
      'exit 255',
      '',
    ].join('\n'),
  );
  chmodSync(ssh, 0o755);
  git(r.repo, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/owner/repo.git');
  return { r, log, path: `${r.binDir}:${process.env.PATH ?? ''}` };
}

/** One record per ssh call the hook's git made. */
function sshCalls(log: string): Array<{ argv: string; prompt: string; askpass: string }> {
  if (!existsSync(log)) return [];
  const lines = readText(log).split('\n').filter(Boolean);
  const calls: Array<{ argv: string; prompt: string; askpass: string }> = [];
  for (let i = 0; i < lines.length; i += 3) {
    calls.push({
      argv: lines[i].replace(/^argv=/, ''),
      prompt: lines[i + 1].replace(/^prompt=/, ''),
      askpass: lines[i + 2].replace(/^askpass=/, ''),
    });
  }
  return calls;
}

// A caller that allows prompts: the hook has to turn them off itself.
const PROMPTING_ENV = { GIT_TERMINAL_PROMPT: '1', GIT_ASKPASS: '/usr/bin/some-gui-askpass' };

describe.each(['ff-main.sh', 'clean-merged.sh'])('%s never prompts', (script) => {
  it('runs ssh in batch mode with a connect timeout, and no terminal or askpass prompt', () => {
    const { r, log, path } = sshRig();
    const out = runHook(script, { cwd: r.repo, path, env: PROMPTING_ENV });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
    const calls = sshCalls(log);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.argv).toContain('-o BatchMode=yes');
      expect(c.argv).toContain('-o ConnectTimeout=10');
      expect(c.prompt).toBe('0');
      expect(c.askpass).toBe('true');
    }
  });

  it('keeps the options of a GIT_SSH_COMMAND that is already set', () => {
    const { r, log, path } = sshRig();
    const out = runHook(script, {
      cwd: r.repo,
      path,
      env: { ...PROMPTING_ENV, GIT_SSH_COMMAND: 'ssh -i /nonexistent/key -o ConnectTimeout=3' },
    });
    expect(out.status).toBe(0);
    const calls = sshCalls(log);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.argv).toContain('-i /nonexistent/key -o ConnectTimeout=3');
      expect(c.argv).toContain('-o BatchMode=yes');
    }
  });

  it('keeps the options of a core.sshCommand from git config', () => {
    const { r, log, path } = sshRig();
    git(r.repo, 'config', 'core.sshCommand', 'ssh -i /nonexistent/configured');
    const out = runHook(script, { cwd: r.repo, path, env: PROMPTING_ENV });
    expect(out.status).toBe(0);
    const calls = sshCalls(log);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.argv).toContain('-i /nonexistent/configured');
      expect(c.argv).toContain('-o BatchMode=yes');
    }
  });
});
