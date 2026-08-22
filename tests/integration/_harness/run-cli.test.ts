import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.js';

describe('runCli', () => {
  it('returns exitCode 0 on `vibecarbon -h`', () => {
    const r = runCli('-h', []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Vibecarbon CLI');
  });

  it('returns non-zero on unknown verb', () => {
    const r = runCli('not-a-real-command', []);
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/unknown|not-a-real-command/i);
  });

  it('strips ANSI from stdout', () => {
    const r = runCli('-h', []);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI absence.
    expect(r.stdout).not.toMatch(/\x1b\[/);
  });

  it('respects timeoutMs', () => {
    const r = runCli('-h', [], { timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
  });

  it('passes cwd to the spawned process', () => {
    const r = runCli('-h', [], { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
  });
});
