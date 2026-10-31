/**
 * The runtime-reach walk: follow a value from where the CLI reads it to every
 * place under a source tree that USES it, through the objects it is passed on
 * in. Shared by the census tests that ask "does this setting reach the
 * runtime, or does it stop somewhere on the way?" (the deploy flag census,
 * and the backup-config census after it).
 *
 * A static walk over the source text, no parser. It masks comments, string
 * and regex contents first (template `${...}` expressions stay), then works
 * name by name from a worklist:
 *
 * - A READ of a tracked name is `<obj>.<name>` (or `<obj>?.<name>`) for one of
 *   the given objects, or a bare `<name>` inside a function whose first
 *   parameter destructures it (`function f({ name })`, `const f = ({ name }) =>`).
 * - A read that is the whole value of an object property (`key: options.name`,
 *   optionally `!!`-prefixed or `|| null`/`?? null`-suffixed, or the shorthand
 *   `{ name }`) is a FORWARD: the value travels on as `key`, which joins the
 *   worklist. Forwards are not uses.
 * - A read inside a function named in `nonRendering` (the input hash, a
 *   validation-only check) is EXCLUDED, with that entry's reason.
 * - Every other read is a USE: a call argument, a condition, a template, an
 *   assignment, a member access on it.
 *
 * Names are tracked globally by spelling, so a walk over-approximates (an
 * unrelated function destructuring the same name counts). The sites list is
 * returned whole so a failing census can show the path it walked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type ReachKind = 'use' | 'forward' | 'excluded';

export interface ReachSite {
  file: string;
  line: number;
  text: string;
  name: string;
  kind: ReachKind;
  /** forward: the key the value travels on as. */
  to?: string;
  /** excluded: why reads in this function do not count. */
  reason?: string;
}

export interface SourceFile {
  path: string;
  src: string;
}

export interface NonRenderingReader {
  file: string;
  fn: string;
  reason: string;
}

/** Every `.js` file under `dir`, paths relative to `root`. */
export function loadSourceTree(dir: string, root = process.cwd()): SourceFile[] {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : [],
    );
  return walk(join(root, dir))
    .sort()
    .map((abs) => ({ path: relative(root, abs), src: readFileSync(abs, 'utf8') }));
}

const REGEX_PRECEDERS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
]);

/**
 * The source with comments, string/regex contents and template text replaced
 * by spaces (newlines kept, so offsets and line numbers still match). Template
 * `${...}` expressions stay as code.
 */
export function maskSource(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const templateDepths: number[] = [];
  let depth = 0;
  let lastSig = '';
  let lastWord = '';
  let i = 0;

  // Scan template text from `from`; returns the index to resume code at.
  const scanTemplate = (from: number): number => {
    let j = from;
    while (j < n) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === '`') {
        blank(from, j);
        lastSig = '`';
        lastWord = '';
        return j + 1;
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        blank(from, j + 1);
        // The interpolation reads as a parenthesized expression, so a bare
        // name inside it is never taken for an object-literal shorthand.
        out[j + 1] = '(';
        templateDepths.push(depth);
        depth += 1;
        lastSig = '{';
        lastWord = '';
        return j + 2;
      }
      j += 1;
    }
    blank(from, n);
    return n;
  };

  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && nx === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastSig = '"';
      lastWord = '';
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(i + 1);
      continue;
    }
    if (ch === '/' && (REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSig = '"';
      lastWord = '';
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        out[i] = ')';
        i = scanTemplate(i + 1);
        continue;
      }
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      lastWord = src.slice(i, j);
      lastSig = 'w';
      i = j;
      continue;
    }
    lastSig = ch;
    lastWord = '';
    i += 1;
  }
  return out.join('');
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Index just past the bracket matching the opener at `open`. */
function matchBracket(code: string, open: number): number {
  let d = 0;
  for (let k = open; k < code.length; k++) {
    if (OPEN.has(code[k])) d += 1;
    else if (CLOSE[code[k]]) {
      d -= 1;
      if (d === 0) return k + 1;
    }
  }
  return code.length;
}

/** Top-level comma-separated parts of a destructuring pattern's content. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let d = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    if (OPEN.has(text[k])) d += 1;
    else if (CLOSE[text[k]]) d -= 1;
    else if (text[k] === ',' && d === 0) {
      parts.push(text.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return']);

interface FnInfo {
  name: string;
  /** destructured key -> local binding */
  bindings: Map<string, string>;
  bodyStart: number;
  bodyEnd: number;
}

/** Functions whose first parameter is an object pattern, plus every named function's range. */
function scanFunctions(code: string): {
  destructuring: FnInfo[];
  ranges: Map<string, [number, number]>;
} {
  const destructuring: FnInfo[] = [];
  const ranges = new Map<string, [number, number]>();
  const heads =
    /(?:\bfunction\s*\*?\s*([\w$]+)?\s*\(|\b([\w$]+)\s*=\s*(?:async\s*)?\(|^\s*(?:async\s+)?([\w$]+)\s*\((?=[^)]*\)\s*\{))/gm;
  for (const m of code.matchAll(heads)) {
    const name = m[1] ?? m[2] ?? m[3] ?? '';
    if (CONTROL_WORDS.has(name)) continue;
    const paren = (m.index ?? 0) + m[0].length - 1;
    const paramsEnd = matchBracket(code, paren);
    let k = paramsEnd;
    while (k < code.length && /\s/.test(code[k])) k += 1;
    if (code.startsWith('=>', k)) {
      k += 2;
      while (k < code.length && /\s/.test(code[k])) k += 1;
    }
    if (code[k] !== '{') continue;
    const bodyEnd = matchBracket(code, k);
    if (name && !ranges.has(name)) ranges.set(name, [k, bodyEnd]);
    let p = paren + 1;
    while (p < paramsEnd && /\s/.test(code[p])) p += 1;
    if (code[p] !== '{') continue;
    const patternEnd = matchBracket(code, p);
    const bindings = new Map<string, string>();
    for (const part of splitTopLevel(code.slice(p + 1, patternEnd - 1))) {
      if (part.startsWith('...')) continue;
      const pm = /^([\w$]+)\s*(?::\s*([\w$]+))?\s*(?:=[\s\S]*)?$/.exec(part);
      if (pm) bindings.set(pm[1], pm[2] ?? pm[1]);
    }
    destructuring.push({ name, bindings, bodyStart: k, bodyEnd });
  }
  return { destructuring, ranges };
}

const FORWARD_TAIL = /^\s*(?:(?:\|\||\?\?)\s*(?:null|undefined|''|""|false|0|\[\]|\{\}))?\s*[,}]/;

/** The innermost unclosed bracket before `pos`, with its offset. */
function enclosingAt(code: string, pos: number): { ch: string; at: number } {
  let pending = 0;
  for (let k = pos - 1; k >= 0; k--) {
    const ch = code[k];
    if (CLOSE[ch]) pending += 1;
    else if (OPEN.has(ch)) {
      if (pending === 0) return { ch, at: k };
      pending -= 1;
    }
  }
  return { ch: '', at: -1 };
}

/**
 * Where a read at [s, e) forwards its value: the property key it is the
 * whole value of, and the function the object literal is the first argument
 * of (`fn({ key: read })`), if any. Null when the read is not a forward.
 */
function forwardOf(
  code: string,
  s: number,
  e: number,
  shorthandKey: string | null,
): { key: string; callee: string | null } | null {
  const open = enclosingAt(code, s);
  if (open.ch !== '{') return null;
  let key = shorthandKey;
  if (!key) {
    if (!FORWARD_TAIL.test(code.slice(e))) return null;
    const before = code.slice(0, s).replace(/!!\s*$/, '');
    const km = /([{,])\s*([\w$]+)\s*:\s*$/.exec(before);
    if (!km) return null;
    key = km[2];
  }
  const cm = /([\w$]+)\s*\(\s*$/.exec(code.slice(0, open.at));
  return { key, callee: cm && !CONTROL_WORDS.has(cm[1]) ? cm[1] : null };
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset; k++) if (src[k] === '\n') line += 1;
  return line;
}

/**
 * What the walk follows: a member name read off one of the objects anywhere
 * (`options.restore`), or one function's destructured parameter key
 * (`applyK3sManifests({ restore })`). A value forwarded into a call enters
 * only THAT function's parameter, so a function that destructures the same
 * name but is never handed the value is not reached.
 */
type Tracked = { kind: 'member'; name: string } | { kind: 'param'; fn: string; key: string };

/**
 * Walk from `start` names through `files`. `objects` are the identifiers whose
 * member reads count (`args.restore`, `options.restore`).
 */
export function walkRuntimeReach({
  files,
  start,
  objects = ['args', 'options'],
  nonRendering = [],
}: {
  files: SourceFile[];
  start: string[];
  objects?: string[];
  nonRendering?: NonRenderingReader[];
}): { names: string[]; sites: ReachSite[] } {
  const prepared = files.map((f) => {
    const code = maskSource(f.src);
    const { destructuring, ranges } = scanFunctions(code);
    const excluded = nonRendering
      .filter((r) => r.file === f.path)
      .map((r) => {
        const range = ranges.get(r.fn);
        if (!range) {
          throw new Error(
            `runtime-reach walk: ${r.file} has no function ${r.fn} (stale nonRendering entry)`,
          );
        }
        return { range, reason: r.reason };
      });
    return { ...f, code, lines: f.src.split('\n'), destructuring, excluded };
  });
  const destructures = (fn: string, key: string) =>
    prepared.some((f) => f.destructuring.some((d) => d.name === fn && d.bindings.has(key)));
  const isDestructuring = (fn: string) =>
    prepared.some((f) => f.destructuring.some((d) => d.name === fn));

  const seen = new Set<string>();
  const idOf = (t: Tracked) => (t.kind === 'member' ? `.${t.name}` : `${t.fn}(${t.key})`);
  const queue: Tracked[] = start.map((name) => ({ kind: 'member', name }));
  const sites: ReachSite[] = [];
  const recorded = new Set<string>();
  const enqueue = (t: Tracked) => {
    if (!seen.has(idOf(t))) queue.push(t);
  };

  const record = (
    f: (typeof prepared)[number],
    name: string,
    s: number,
    e: number,
    shorthandKey: string | null,
  ) => {
    const id = `${f.path}:${s}`;
    if (recorded.has(id)) return;
    recorded.add(id);
    const line = lineOf(f.src, s);
    const text = f.lines[line - 1].trim();
    const ex = f.excluded.find(({ range }) => s >= range[0] && s < range[1]);
    if (ex) {
      sites.push({ file: f.path, line, text, name, kind: 'excluded', reason: ex.reason });
      return;
    }
    const fwd = forwardOf(f.code, s, e, shorthandKey);
    if (fwd) {
      sites.push({
        file: f.path,
        line,
        text,
        name,
        kind: 'forward',
        to: fwd.callee ? `${fwd.callee}({ ${fwd.key} })` : fwd.key,
      });
      if (fwd.callee && isDestructuring(fwd.callee)) {
        // Handed to a function that names its parameters: the value lives on
        // only if it names this key.
        if (destructures(fwd.callee, fwd.key))
          enqueue({ kind: 'param', fn: fwd.callee, key: fwd.key });
      } else {
        // An options bag (or a callee outside the tree): read as a member.
        enqueue({ kind: 'member', name: fwd.key });
      }
      return;
    }
    sites.push({ file: f.path, line, text, name, kind: 'use' });
  };

  while (queue.length > 0) {
    const t = queue.shift() as Tracked;
    if (seen.has(idOf(t))) continue;
    seen.add(idOf(t));
    for (const f of prepared) {
      if (t.kind === 'member') {
        const member = new RegExp(
          `\\b(?:${objects.join('|')})\\s*\\??\\.\\s*${t.name}(?![\\w$])`,
          'g',
        );
        for (const m of f.code.matchAll(member)) {
          const s = m.index ?? 0;
          const e = s + m[0].length;
          if (/^\s*(?:=(?!=)|\+=|\|\|=|\?\?=|&&=)/.test(f.code.slice(e))) continue;
          record(f, t.name, s, e, null);
        }
        continue;
      }
      for (const fn of f.destructuring) {
        if (fn.name !== t.fn) continue;
        const local = fn.bindings.get(t.key);
        if (!local) continue;
        const bare = new RegExp(
          `(?<![\\w$.])${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`,
          'g',
        );
        const body = f.code.slice(fn.bodyStart, fn.bodyEnd);
        for (const m of body.matchAll(bare)) {
          const s = fn.bodyStart + (m.index ?? 0);
          const e = s + local.length;
          const after = f.code.slice(e);
          const before = f.code.slice(0, s);
          const inObject = enclosingAt(f.code, s).ch === '{';
          const keyPosition = /[{,]\s*$/.test(before);
          // `{ local: value }`: a property key, not a read.
          if (inObject && keyPosition && /^\s*:/.test(after)) continue;
          // A redeclaration (`const local =`) is not a read.
          if (/\b(?:const|let|var)\s+$/.test(before)) continue;
          const shorthand = inObject && keyPosition && /^\s*[,}]/.test(after);
          record(f, local, s, e, shorthand ? local : null);
        }
      }
    }
  }
  return { names: [...seen], sites };
}

/** One line per site, for a census failure message. */
export function formatReachSites(sites: ReachSite[]): string {
  return sites
    .map(
      (s) =>
        `  ${s.kind.padEnd(8)} ${s.file}:${s.line}  ${s.text}` +
        (s.to ? `  -> ${s.to}` : '') +
        (s.reason ? `  (${s.reason})` : ''),
    )
    .join('\n');
}
