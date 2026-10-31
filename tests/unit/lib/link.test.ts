/**
 * link(): a printed URL is an OSC 8 hyperlink on a terminal that supports
 * them, and plain text everywhere else.
 *
 * Why it exists: clack hard-wraps note and log text at the terminal width, so
 * a plain URL in a narrow terminal is split across two box lines with border
 * characters between the halves, and clicking either half opens a broken
 * URL. Clack keeps an OSC 8 span whole (it is one word to the wrapper), and a
 * supporting terminal opens the full target even when the line soft-wraps on
 * screen.
 */
import { Writable } from 'node:stream';
import * as p from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { c, link, supportsHyperlinks } from '../../../src/lib/colors.js';

const ESC = '\x1b';
const OSC8_SPAN = new RegExp(
  `${ESC}\\]8;;([^${ESC}]*)${ESC}\\\\([^]*?)${ESC}\\]8;;${ESC}\\\\`,
  'g',
);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const URL_ = 'https://cloud.digitalocean.com/account/api/tokens';

const tty = { isTTY: true };
const VTE = { VTE_VERSION: '7600' };

/** A fake TTY stream clack can render into, `columns` wide. */
function fakeTty(columns: number) {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  Object.assign(out, { isTTY: true, columns, rows: 40 });
  return { out, text: () => chunks.join('') };
}

describe('supportsHyperlinks', () => {
  it('is on for a TTY in a terminal known to render OSC 8', () => {
    for (const env of [
      { VTE_VERSION: '7600' },
      { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' },
      { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.95.0' },
      { TERM_PROGRAM: 'WezTerm' },
      { TERM_PROGRAM: 'ghostty' },
      { WT_SESSION: 'abc' },
      { TERM: 'xterm-kitty' },
      { TERM: 'alacritty' },
      { KONSOLE_VERSION: '230800' },
    ]) {
      expect(supportsHyperlinks({ stream: tty, env, platform: 'linux' }), JSON.stringify(env)).toBe(
        true,
      );
    }
  });

  it('is off when piped, under NO_COLOR or FORCE_COLOR=0, in CI, or on a dumb terminal', () => {
    expect(supportsHyperlinks({ stream: {}, env: VTE, platform: 'linux' })).toBe(false);
    expect(supportsHyperlinks({ stream: undefined, env: VTE, platform: 'linux' })).toBe(false);
    for (const extra of [
      { NO_COLOR: '1' },
      { FORCE_COLOR: '0' },
      { FORCE_COLOR: 'false' },
      { CI: 'true' },
      { GITHUB_ACTIONS: 'true' },
      { VIBECARBON_PLAIN: '1' },
      { TERM: 'dumb' },
    ]) {
      expect(
        supportsHyperlinks({ stream: tty, env: { ...VTE, ...extra }, platform: 'linux' }),
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('is off for a terminal it does not know, or one too old to render OSC 8', () => {
    for (const env of [
      {},
      { TERM: 'xterm-256color' },
      { TERM_PROGRAM: 'Apple_Terminal' },
      { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.0.15' },
      { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.71.2' },
      { VTE_VERSION: '4802' },
    ]) {
      expect(supportsHyperlinks({ stream: tty, env, platform: 'linux' }), JSON.stringify(env)).toBe(
        false,
      );
    }
  });

  it('FORCE_HYPERLINK overrides detection either way', () => {
    expect(
      supportsHyperlinks({ stream: {}, env: { FORCE_HYPERLINK: '1' }, platform: 'linux' }),
    ).toBe(true);
    expect(
      supportsHyperlinks({ stream: tty, env: { ...VTE, FORCE_HYPERLINK: '0' }, platform: 'linux' }),
    ).toBe(false);
  });
});

describe('link', () => {
  it('wraps the text in an OSC 8 span when the terminal supports it', () => {
    expect(link(URL_, URL_, { stream: tty, env: VTE })).toBe(
      `${ESC}]8;;${URL_}${ESC}\\${URL_}${ESC}]8;;${ESC}\\`,
    );
    expect(link(URL_, 'the tokens page', { stream: tty, env: VTE })).toBe(
      `${ESC}]8;;${URL_}${ESC}\\the tokens page${ESC}]8;;${ESC}\\`,
    );
  });

  it('is the bare URL when piped, under NO_COLOR, or on an unsupported terminal', () => {
    expect(link(URL_, URL_, { stream: {}, env: VTE })).toBe(URL_);
    expect(link(URL_, URL_, { stream: tty, env: { ...VTE, NO_COLOR: '1' } })).toBe(URL_);
    expect(link(URL_, URL_, { stream: tty, env: { TERM: 'xterm' } })).toBe(URL_);
    expect(link(URL_)).toBe(URL_); // vitest's own stdout is not a TTY
  });

  it('keeps the URL visible when a label stands in for it on plain output', () => {
    expect(link(URL_, 'the tokens page', { stream: {}, env: {} })).toBe(
      `the tokens page (${URL_})`,
    );
  });
});

describe('a link inside a 40-column p.note', () => {
  /** Every OSC 8 span in `text`, with SGR styling removed from its visible part. */
  const spans = (text: string) =>
    [...text.matchAll(OSC8_SPAN)].map((m) => ({ target: m[1], visible: m[2].replace(SGR, '') }));

  it('a plain URL is broken across box lines (the bug)', () => {
    const { out, text } = fakeTty(40);
    p.note(`Generate a token: ${c.boldCyanUnderline(URL_)} now`, 'DigitalOcean', { output: out });
    const lines = text().replace(SGR, '').split('\n');
    expect(lines.some((l) => l.includes(URL_))).toBe(false);
  });

  it('keeps each linked URL whole in one OSC 8 span', () => {
    const { out, text } = fakeTty(40);
    const projects = 'https://cloud.digitalocean.com/projects/new';
    const opts = { stream: tty, env: VTE };
    p.note(
      [
        `1. Create a project: ${c.boldCyanUnderline(link(projects, projects, opts))}`,
        `2. Generate a token: ${c.boldCyanUnderline(link(URL_, URL_, opts))} → Generate New Token`,
      ].join('\n'),
      'DigitalOcean',
      { output: out },
    );
    const found = spans(text());
    expect(found.map((s) => s.target)).toEqual([projects, URL_]);
    for (const s of found) {
      expect(s.visible).toBe(s.target);
      expect(s.visible).not.toContain('\n');
    }
  });

  describe('the real DigitalOcean token guide', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('prints every URL as one unbroken OSC 8 span', async () => {
      vi.stubEnv('FORCE_HYPERLINK', '1');
      const chunks: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
      const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
      try {
        const { displayApiTokenGuide } = await import(
          '../../../src/lib/digitalocean-guided-setup.js'
        );
        displayApiTokenGuide('demo');
      } finally {
        if (columns) Object.defineProperty(process.stdout, 'columns', columns);
        else delete (process.stdout as { columns?: number }).columns;
      }
      const found = spans(chunks.join(''));
      expect(found.map((s) => s.target)).toEqual([
        'https://cloud.digitalocean.com/projects/new',
        URL_,
      ]);
      for (const s of found) expect(s.visible).toBe(s.target);
    });
  });
});
