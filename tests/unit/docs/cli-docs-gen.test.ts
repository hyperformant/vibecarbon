import { describe, expect, it } from 'vitest';
import {
  generateAll,
  renderAgentsBlock,
  renderCommandTable,
  renderFlagTable,
  replaceRegion,
} from '../../../src/lib/cli/docs-gen.js';

const SPEC = {
  summary: 'Do a thing',
  flags: [
    { name: 'h', boolean: true, description: 'Show help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip prompts' },
    { name: 'env', value: '<name>', description: 'Environment seed' },
    { name: 'source', value: '<a|b>', description: 'Pick one: `a` or `b`' },
  ],
};

const rows = [
  {
    entry: { name: 'next', aliases: ['?'], category: 'dev', usage: '' },
    spec: { summary: 'What next', flags: [] },
  },
  {
    entry: { name: 'down', category: 'dev', usage: '' },
    spec: {
      summary: 'Stop it',
      flags: [
        { name: 'orphans', boolean: true, featured: true, description: 'Remove strays' },
        { name: 'y', boolean: true, description: 'Skip' },
      ],
    },
  },
  {
    entry: { name: 'deploy', category: 'deploy', usage: '[env]' },
    spec: { summary: 'Ship it', flags: [] },
  },
];

describe('renderFlagTable', () => {
  it('renders value and no-value flags, excluding h and v', () => {
    const out = renderFlagTable(SPEC);
    expect(out).toBe(
      [
        '| Flag | Description |',
        '|------|-------------|',
        '| `-y` | Skip prompts |',
        '| `-env <name>` | Environment seed |',
        '| `-source <a\\|b>` | Pick one: `a` or `b` |',
      ].join('\n'),
    );
  });

  it('escapes backslashes before pipes, so a literal \\| cannot end the cell early', () => {
    const out = renderFlagTable({
      flags: [{ name: 'path', value: '<dir>', description: 'Windows style: C:\\| works' }],
    });
    expect(out).toContain('| Windows style: C:\\\\\\| works |');
  });

  it('renders a placeholder when there are no flags beyond h and v', () => {
    expect(renderFlagTable({ flags: SPEC.flags.slice(0, 2) })).toBe('_No flags beyond -h and -v._');
    expect(renderFlagTable({})).toBe('_No flags beyond -h and -v._');
  });
});

describe('renderCommandTable', () => {
  it('renders one category with alias and featured rows', () => {
    const out = renderCommandTable(rows, 'dev');
    expect(out).toContain('| Command | What it does |');
    expect(out).toContain('| **`?`** / **`next`** | What next |');
    expect(out).toContain('| **`down`** | Stop it |');
    expect(out).toContain('| **`down -orphans`** | Remove strays |');
    expect(out).not.toContain('down -y');
    expect(out).not.toContain('deploy');
  });

  it('puts usage after the name', () => {
    expect(renderCommandTable(rows, 'deploy')).toContain('| **`deploy [env]`** | Ship it |');
  });
});

describe('renderAgentsBlock', () => {
  it('renders a fenced bash block with an aligned comment column', () => {
    const out = renderAgentsBlock(rows);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```bash');
    expect(lines.at(-1)).toBe('```');
    const body = lines.slice(1, -1);
    expect(body.some((l) => l.startsWith('vibecarbon down -orphans'))).toBe(true);
    const cols = body.map((l) => l.indexOf('# '));
    expect(new Set(cols).size).toBe(1);
    expect(body.find((l) => l.startsWith('vibecarbon deploy [env]'))).toMatch(/# Ship it$/);
  });
});

describe('replaceRegion', () => {
  const md = 'intro\n\n<!-- BEGIN GENERATED: x -->\nold\n<!-- END GENERATED: x -->\n\noutro  \n';
  const mdx =
    'intro\n{/* BEGIN GENERATED: flags up */}\nold\n{/* END GENERATED: flags up */}\ntail';

  it('swaps only the region body and keeps surrounding bytes (md)', () => {
    const out = replaceRegion(md, 'x', 'NEW', 'md');
    expect(out).toBe(
      'intro\n\n<!-- BEGIN GENERATED: x -->\nNEW\n<!-- END GENERATED: x -->\n\noutro  \n',
    );
  });

  it('swaps only the region body (mdx)', () => {
    expect(replaceRegion(mdx, 'flags up', 'A\nB', 'mdx')).toBe(
      'intro\n{/* BEGIN GENERATED: flags up */}\nA\nB\n{/* END GENERATED: flags up */}\ntail',
    );
  });

  it('is idempotent', () => {
    const once = replaceRegion(md, 'x', 'NEW', 'md');
    expect(replaceRegion(once, 'x', 'NEW', 'md')).toBe(once);
  });

  it('throws on missing markers', () => {
    expect(() => replaceRegion('nothing', 'x', 'B', 'md')).toThrow(/x/);
    expect(() => replaceRegion('<!-- BEGIN GENERATED: x -->\n', 'x', 'B', 'md')).toThrow(/x/);
  });

  it('throws on duplicate markers', () => {
    expect(() => replaceRegion(`${md}${md}`, 'x', 'B', 'md')).toThrow(/duplicate|more than once/i);
  });
});

describe('determinism', () => {
  it('gives identical output on repeated runs', () => {
    expect(renderCommandTable(rows, 'dev')).toBe(renderCommandTable(rows, 'dev'));
    expect(renderAgentsBlock(rows)).toBe(renderAgentsBlock(rows));
    expect(renderFlagTable(SPEC)).toBe(renderFlagTable(SPEC));
  });
});

describe('pipe escaping in command names', () => {
  it('escapes a pipe in the usage column so the table stays valid', () => {
    const out = renderCommandTable(
      [
        {
          entry: { name: 'telemetry', category: 'dev', usage: '[on|off]' },
          spec: { summary: 'x', flags: [] },
        },
      ],
      'dev',
    );
    expect(out).toContain('| **`telemetry [on\\|off]`** | x |');
  });
});

describe('generateAll missing marker', () => {
  it('names the file and how to add the marker pair', async () => {
    const files = { 'carbon/content/docs/cli.mdx': '# nothing here' };
    await expect(generateAll(files, rows)).rejects.toThrow(
      /carbon\/content\/docs\/cli\.mdx[\s\S]*BEGIN GENERATED: global-flags[\s\S]*END GENERATED: global-flags/,
    );
  });
});
