/**
 * Docs generator: renders command and flag docs from each command's SPEC.
 *
 * Pure functions (plus `generateAll`, which loads the registry). Generated
 * regions sit between marker comments in cli.mdx, README.md and AGENTS.md;
 * everything outside the markers is left byte-for-byte alone. Output is
 * deterministic: registry order for commands, `SPEC.flags` order for flags.
 *
 * Run via `pnpm docs:cli`; `tests/unit/docs/cli-docs-generated.test.ts`
 * fails when any region is stale.
 */

import { loadAllSpecs } from './command-registry.js';

/** Files that carry generated regions, relative to the repo root. */
export const DOC_TARGETS = ['carbon/content/docs/cli.mdx', 'README.md', 'AGENTS.md'];

const UNIVERSAL = new Set(['h', 'v']);
const NO_FLAGS = '_No flags beyond -h and -v._';

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
const flagLabel = (f) => (f.value ? `-${f.name} ${f.value}` : `-${f.name}`);
const ownFlags = (spec) => (spec?.flags ?? []).filter((f) => !UNIVERSAL.has(f.name));

/** Flag table for one command. `h` and `v` live in the shared global note. */
export function renderFlagTable(spec) {
  const flags = ownFlags(spec);
  if (flags.length === 0) return NO_FLAGS;
  return [
    '| Flag | Description |',
    '|------|-------------|',
    ...flags.map((f) => `| \`${cell(flagLabel(f))}\` | ${cell(f.description)} |`),
  ].join('\n');
}

/** The shared `-h` / `-v` note for the top of cli.mdx. */
export function renderGlobalFlags() {
  return [
    '| Flag | Description |',
    '|------|-------------|',
    '| `-h` | Show help |',
    '| `-v` | Show version number |',
  ].join('\n');
}

const nameWithUsage = (entry) => (entry.usage ? `${entry.name} ${entry.usage}` : entry.name);

/** README-style command table for one category. */
export function renderCommandTable(rows, category) {
  const lines = ['| Command | What it does |', '| :------ | :----------- |'];
  for (const { entry, spec } of rows) {
    if (entry.category !== category) continue;
    const first = entry.aliases?.length
      ? `${entry.aliases.map((a) => `**\`${a}\`**`).join(' / ')} / **\`${entry.name}\`**`
      : `**\`${cell(nameWithUsage(entry))}\`**`;
    lines.push(`| ${first} | ${cell(spec.summary)} |`);
    for (const f of ownFlags(spec).filter((x) => x.featured)) {
      lines.push(`| **\`${entry.name} ${flagLabel(f)}\`** | ${cell(f.description)} |`);
    }
  }
  return lines.join('\n');
}

/** AGENTS.md fenced command list: every command, plus featured flags. */
export function renderAgentsBlock(rows) {
  const items = [];
  for (const { entry, spec } of rows) {
    const head = entry.aliases?.length
      ? `vibecarbon ${entry.aliases[0]}  /  vibecarbon ${entry.name}`
      : `vibecarbon ${nameWithUsage(entry)}`;
    items.push([head, spec.summary]);
    for (const f of ownFlags(spec).filter((x) => x.featured)) {
      items.push([`vibecarbon ${entry.name} ${flagLabel(f)}`, f.description]);
    }
  }
  const width = Math.max(...items.map(([h]) => h.length)) + 2;
  return ['```bash', ...items.map(([h, c]) => `${h.padEnd(width)}# ${c}`), '```'].join('\n');
}

const MARKERS = {
  md: (kind, id) => `<!-- ${kind} GENERATED: ${id} -->`,
  mdx: (kind, id) => `{/* ${kind} GENERATED: ${id} */}`,
};

function countOf(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Replace the body between a region's BEGIN and END markers. Throws when a
 * marker is missing or appears more than once.
 */
export function replaceRegion(text, id, body, style) {
  const begin = MARKERS[style]('BEGIN', id);
  const end = MARKERS[style]('END', id);
  for (const m of [begin, end]) {
    const n = countOf(text, m);
    if (n === 0) throw new Error(`generated region marker missing: ${m}`);
    if (n > 1) throw new Error(`generated region marker duplicate (appears more than once): ${m}`);
  }
  const b = text.indexOf(begin) + begin.length;
  const e = text.indexOf(end);
  if (e < b) throw new Error(`generated region END precedes BEGIN: ${id}`);
  return `${text.slice(0, b)}\n${body}\n${text.slice(e)}`;
}

/**
 * Regenerate every region in the target files.
 * @param {Map<string,string> | Record<string,string>} files - path to current text
 * @param {Array<{entry: object, spec: object}>} [rows] - defaults to the registry
 * @returns {Promise<Map<string,string>>} path to regenerated text
 */
export async function generateAll(files, rows) {
  const specs = rows ?? (await loadAllSpecs());
  const input = files instanceof Map ? files : new Map(Object.entries(files));
  const out = new Map();
  for (const [path, text] of input) {
    let next = text;
    if (path.endsWith('cli.mdx')) {
      next = replaceRegion(next, 'global-flags', renderGlobalFlags(), 'mdx');
      for (const { entry, spec } of specs) {
        next = replaceRegion(next, `flags ${entry.name}`, renderFlagTable(spec), 'mdx');
      }
    } else if (path.endsWith('README.md')) {
      for (const cat of ['dev', 'deploy', 'debug', 'license']) {
        next = replaceRegion(next, `commands ${cat}`, renderCommandTable(specs, cat), 'md');
      }
    } else if (path.endsWith('AGENTS.md')) {
      next = replaceRegion(next, 'commands', renderAgentsBlock(specs), 'md');
    }
    out.set(path, next);
  }
  return out;
}
