import { describe, expect, it } from 'vitest';
import { COMMANDS, loadAllSpecs } from '../../../src/lib/cli/command-registry.js';
import { renderCommandList } from '../../../src/lib/cli/help.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const specs = await loadAllSpecs();
const rows = specs.map(({ entry, spec }) => ({ ...entry, summary: spec.summary }));
const out = strip(renderCommandList(rows));
const lines = out.split('\n');

const HEADINGS: Record<string, string> = {
  dev: 'DEV COMMANDS',
  deploy: 'DEPLOY COMMANDS',
  debug: 'DEBUG COMMANDS',
  license: 'LICENSE COMMANDS',
};

/** Lines belonging to a heading's section (until the next blank line). */
function section(heading: string): string[] {
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

describe('top-level help command list', () => {
  it('lists every registry command under its category with its summary', () => {
    for (const { entry, spec } of specs) {
      const body = section(HEADINGS[entry.category]).join('\n');
      expect(body).toMatch(new RegExp(`^  (\\S+ \\| )?${entry.name}( |$)`, 'm'));
      // Wrapped summaries are rejoined, so compare whitespace-normalized.
      const flat = body.replace(/\s+/g, ' ');
      expect(flat).toContain(String(spec.summary).replace(/\s+/g, ' '));
    }
  });

  it('puts ? and next on one line', () => {
    expect(lines.filter((l) => /^ {2}\? \| next( |$)/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('? | next'))).toHaveLength(1);
  });

  it('never passes 80 visible columns', () => {
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
  });

  it('wraps long summaries under the summary column instead of truncating', () => {
    const row = {
      name: 'long',
      category: 'dev',
      usage: '',
      summary: 'word '.repeat(40).trim(),
    };
    const rendered = strip(renderCommandList([row], { width: 40 })).split('\n');
    expect(rendered.length).toBeGreaterThan(3);
    for (const l of rendered) expect(l.length).toBeLessThanOrEqual(40);
    expect(rendered.join(' ').match(/word/g)).toHaveLength(40);
  });

  it('renders a fake extra registry entry (help is generated, not hand-written)', () => {
    const extra = {
      name: 'frobnicate',
      category: 'debug',
      usage: '[env]',
      summary: 'Frobnicate the widgets',
    };
    const text = strip(renderCommandList([...rows, extra]));
    expect(text).toMatch(/^ {2}frobnicate \[env\] +Frobnicate the widgets$/m);
    expect(COMMANDS.some((e) => e.name === 'frobnicate')).toBe(false);
  });
});
