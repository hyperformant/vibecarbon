/**
 * The "Next steps" boxes speak the same colour vocabulary as help EXAMPLES:
 * `vibecarbon <command>` cyan, `#` comments muted, the user's own shell
 * (`cd my-app`) and any args/flags left plain.
 */
import { describe, expect, it } from 'vitest';
import { formatCommandNote } from '../../../../src/lib/cli/help.js';

const CYAN = '\u001b[36m';
const GRAY = '\u001b[90m';
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('formatCommandNote', () => {
  it('colours vibecarbon invocations and mutes # comments', () => {
    const out = formatCommandNote(['# Run locally:', 'vibecarbon up']);
    expect(out.split('\n')[0]).toBe(`${GRAY}# Run locally:\u001b[0m`);
    expect(out).toContain(`${CYAN}vibecarbon\u001b[0m ${CYAN}up\u001b[0m`);
  });

  it("leaves the user's own shell command uncoloured", () => {
    expect(formatCommandNote(['cd demoapp'])).toBe('cd demoapp');
  });

  it('colours every invocation in a chain', () => {
    const out = formatCommandNote(['vibecarbon down && vibecarbon up']);
    expect(plain(out)).toBe('vibecarbon down && vibecarbon up');
    // Count the cyan starts by splitting on the literal escape: building a
    // RegExp from it needs the '[' escaped, and the single-occurrence
    // String.replace that does so reads as incomplete sanitization.
    expect(out.split(CYAN).length - 1).toBe(4);
  });

  it('mutes a trailing inline comment but not the command before it', () => {
    const out = formatCommandNote(['vibecarbon shell e1    # bash with KUBECONFIG set']);
    // The gap is preserved verbatim — these notes pad it to align the
    // comments into a column.
    expect(plain(out)).toBe('vibecarbon shell e1    # bash with KUBECONFIG set');
    expect(out).toContain(`${GRAY}# bash with KUBECONFIG set`);
    expect(out).toContain(`${CYAN}vibecarbon\u001b[0m ${CYAN}shell\u001b[0m e1`);
  });

  it('keeps a # that is part of a value inside the command', () => {
    expect(plain(formatCommandNote(['open http://localhost:5173/#/admin']))).toBe(
      'open http://localhost:5173/#/admin',
    );
  });

  it('preserves indentation and blank lines', () => {
    const out = formatCommandNote(['  vibecarbon up', '', 'cd x']);
    expect(out.split('\n')[0].startsWith('  ')).toBe(true);
    expect(out.split('\n')[1]).toBe('');
  });

  it('the note body reads correctly with colour stripped', () => {
    const body = ['# Change directory:', 'cd demoapp', '', '# Run locally:', 'vibecarbon up'];
    expect(plain(formatCommandNote(body))).toBe(body.join('\n'));
  });
});
