/**
 * The deploy log file is plain text: every escape the terminal got (SGR
 * color, cursor moves, and the OSC 8 hyperlinks link() prints) is stripped,
 * and a hyperlink keeps its visible text.
 */
import { describe, expect, it } from 'vitest';
import { link } from '../../../src/lib/colors.js';
import { stripTerminalEscapes } from '../../../src/lib/deploy-logger.js';

describe('stripTerminalEscapes', () => {
  it('strips color and cursor sequences and bare CRs', () => {
    expect(stripTerminalEscapes('\x1b[1m\x1b[36mhi\x1b[0m\r\x1b[2K')).toBe('hi');
  });

  it('strips an OSC 8 hyperlink down to its visible text', () => {
    const url = 'https://cloud.digitalocean.com/account/api/tokens';
    const linked = `Open: \x1b[4m${link(url, url, { stream: { isTTY: true }, env: { VTE_VERSION: '7600' } })}\x1b[0m.`;
    expect(linked).toContain('\x1b]8;;');
    expect(stripTerminalEscapes(linked)).toBe(`Open: ${url}.`);
    expect(stripTerminalEscapes(`\x1b]8;;${url}\x07text\x1b]8;;\x07`)).toBe('text');
  });
});
