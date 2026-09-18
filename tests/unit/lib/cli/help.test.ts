import { describe, expect, it } from 'vitest';
import { formatExampleCommand, renderHelp } from '../../../../src/lib/cli/help.js';

// Strip ANSI escapes so assertions on text content don't depend on
// terminal-specific color codes leaking into snapshots.
function strip(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping is intentional.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderHelp', () => {
  it('renders title, usage, flags, and examples for a basic command', () => {
    const out = strip(
      renderHelp({
        name: 'backup',
        summary: 'Create or manage database backups',
        positional: [{ name: 'env', optional: true, description: 'Environment seed' }],
        flags: [
          { name: 'h', boolean: true, description: 'Show help' },
          { name: 'l', boolean: true, description: 'List backups' },
          { name: 'env', value: '<name>', description: 'Environment seed' },
          {
            name: 'action',
            value: '<verb>',
            enum: ['create', 'list', 'download'],
            description: 'Action seed',
          },
        ],
        examples: [
          { command: 'vibecarbon backup', description: 'prompts for env and action' },
          { command: 'vibecarbon backup prod -l', description: 'list prod backups' },
        ],
      }),
    );

    // Title.
    expect(out).toContain('Vibecarbon Backup - Create or manage database backups');
    // Usage.
    expect(out).toContain('vibecarbon backup [env] [flags]');
    // Argument table (positional shows up as [optional]).
    expect(out).toContain('[env]');
    // Flag table — single-dash forms only, never double-dash.
    expect(out).toContain('-h');
    expect(out).toContain('-l');
    expect(out).toContain('-env <name>');
    // Enum values surface in the description.
    expect(out).toContain('(create|list|download)');
    // Examples.
    expect(out).toContain('vibecarbon backup');
    expect(out).toContain('# prompts for env and action');
    expect(out).toContain('# list prod backups');
  });

  it('NEVER renders double-dash flag forms', () => {
    const out = strip(
      renderHelp({
        name: 'add',
        flags: [
          { name: 'h', boolean: true, description: 'Show help' },
          { name: 'online', boolean: true, description: 'Fetch the latest bundles from GitHub' },
        ],
      }),
    );
    expect(out).not.toMatch(/--/);
  });

  it('omits sections that have no content', () => {
    const out = strip(renderHelp({ name: 'simple', summary: 'no flags or args' }));
    expect(out).toContain('Vibecarbon Simple - no flags or args');
    expect(out).toContain('USAGE');
    expect(out).toContain('vibecarbon simple');
    expect(out).not.toContain('ARGUMENTS');
    expect(out).not.toContain('FLAGS');
    expect(out).not.toContain('EXAMPLES');
  });

  it('formats required vs optional positionals distinctly', () => {
    const required = strip(renderHelp({ name: 'x', positional: [{ name: 'feature' }] }));
    expect(required).toContain('vibecarbon x <feature>');
    expect(required).toContain('<feature>');

    const optional = strip(
      renderHelp({ name: 'x', positional: [{ name: 'env', optional: true }] }),
    );
    expect(optional).toContain('vibecarbon x [env]');
    expect(optional).toContain('[env]');
  });

  it('formats variadic positionals with ellipsis', () => {
    const out = strip(
      renderHelp({
        name: 'add',
        positional: [{ name: 'features', variadic: true, optional: true }],
      }),
    );
    expect(out).toContain('vibecarbon add [features...]');
  });

  it('renders trailing newline so the output is terminal-clean', () => {
    const out = renderHelp({ name: 'x' });
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('formatExampleCommand', () => {
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[0m';

  it('colours `vibecarbon <command>` cyan and leaves the rest plain', () => {
    expect(formatExampleCommand('vibecarbon backup prod -l')).toBe(
      `${CYAN}vibecarbon${RESET} ${CYAN}backup${RESET} prod -l`,
    );
  });

  it('colours a bare `vibecarbon <command>`', () => {
    expect(formatExampleCommand('vibecarbon up')).toBe(
      `${CYAN}vibecarbon${RESET} ${CYAN}up${RESET}`,
    );
  });

  it('leaves a non-vibecarbon line untouched', () => {
    expect(formatExampleCommand('cd my-app')).toBe('cd my-app');
  });

  it('leaves a bare `vibecarbon` with no command untouched except the word itself', () => {
    expect(formatExampleCommand('vibecarbon')).toBe(`${CYAN}vibecarbon${RESET}`);
  });
});

describe('renderHelp EXAMPLES colouring', () => {
  it('renders example commands via formatExampleCommand and comments in gray', () => {
    const out = renderHelp({
      name: 'backup',
      summary: 'x',
      examples: [{ command: 'vibecarbon backup prod -l', description: 'list prod backups' }],
    });
    expect(out).toContain(formatExampleCommand('vibecarbon backup prod -l'));
    expect(out).toContain('\x1b[90m# list prod backups\x1b[0m');
    expect(out).not.toContain('\x1b[2m# list prod backups');
  });
});
