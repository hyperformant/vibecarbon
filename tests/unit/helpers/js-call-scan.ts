/**
 * A small JavaScript call scanner for source censuses.
 *
 * A census that greps line by line misses a call whose arguments span lines
 * (`writeComposeWalgRole({\n  ...,\n  role: 'standby',\n})`). This scanner
 * lexes the source once (comments, string and template text, regex literals,
 * with `${...}` interpolations kept as code), then finds calls by name and
 * reads their arguments by balancing brackets over code characters only. A
 * paren inside a string, a comment or a regex never unbalances it.
 *
 * It is a scanner, not a parser: good enough for this repo's own sources,
 * which biome formats, and every census that uses it carries a bite test.
 */

/** Per-character class of a source text. */
export const CODE = 1;
export const STRING = 2;
export const COMMENT = 0;

const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

/**
 * Classify every character: CODE, STRING (string, template and regex text,
 * delimiters included) or COMMENT. Template `${...}` bodies are CODE.
 */
export function lexMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length).fill(CODE);
  // Each frame is a template literal waiting for its closing backtick; `depth`
  // counts the braces opened inside its current `${...}` interpolation.
  const templates: Array<{ depth: number }> = [];
  let inTemplateText = false;
  let lastSignificant = '';
  let lastWordEnd = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inTemplateText) {
      mask[i] = STRING;
      if (c === '\\') {
        if (i + 1 < n) mask[i + 1] = STRING;
        i += 2;
        continue;
      }
      if (c === '`') {
        templates.pop();
        inTemplateText = false;
        lastSignificant = '`';
        i += 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        mask[i + 1] = STRING;
        inTemplateText = false;
        templates[templates.length - 1].depth = 0;
        lastSignificant = '{';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // code
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') mask[i++] = COMMENT;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) mask[i++] = COMMENT;
      continue;
    }
    if (c === "'" || c === '"') {
      mask[i++] = STRING;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') mask[i++] = STRING;
        if (i < n) mask[i++] = STRING;
      }
      if (i < n) mask[i++] = STRING;
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      mask[i++] = STRING;
      templates.push({ depth: 0 });
      inTemplateText = true;
      continue;
    }
    if (
      c === '/' &&
      (lastSignificant === '' ||
        REGEX_PREV.has(lastSignificant) ||
        REGEX_KEYWORDS.test(lastWordEnd))
    ) {
      mask[i++] = STRING;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        const r = text[i];
        mask[i++] = STRING;
        if (r === '\\') {
          if (i < n) mask[i++] = STRING;
          continue;
        }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      while (i < n && /[a-z]/.test(text[i])) mask[i++] = STRING;
      lastSignificant = '/';
      continue;
    }
    if (templates.length > 0 && !inTemplateText) {
      const frame = templates[templates.length - 1];
      if (c === '{') frame.depth += 1;
      else if (c === '}') {
        if (frame.depth === 0) {
          mask[i] = STRING;
          inTemplateText = true;
          i += 1;
          continue;
        }
        frame.depth -= 1;
      }
    }
    if (!/\s/.test(c)) {
      lastSignificant = c;
      lastWordEnd = /[\w$]/.test(c) ? `${lastWordEnd}${c}`.slice(-12) : '';
    }
    i += 1;
  }
  return mask;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);

/** Index of the bracket that closes the one at `open` (code characters only), or -1. */
export function matchBracket(text: string, mask: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (mask[i] !== CODE) continue;
    const c = text[i];
    if (c in OPEN) depth += 1;
    else if (CLOSE.has(c)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `text.slice(from, to)` on top-level commas; returns trimmed pieces. */
function splitArgs(text: string, mask: Uint8Array, from: number, to: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (mask[i] !== CODE) continue;
    const c = text[i];
    if (c in OPEN) depth += 1;
    else if (CLOSE.has(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start, to).trim();
  if (last) out.push(last);
  return out;
}

/** A named function's body range: [start of the name, closing brace]. */
export interface FunctionRange {
  name: string;
  start: number;
  end: number;
}

/**
 * Every named function with a block body: `function name(...) {`, `name =
 * (async) (...) => {`, `name: (async) (...) => {` and method shorthand
 * `(async) name(...) {`.
 */
export function functionRanges(text: string, mask: Uint8Array): FunctionRange[] {
  const out: FunctionRange[] = [];
  const bodyAfterParams = (paren: number, arrow: boolean): number => {
    const close = matchBracket(text, mask, paren);
    if (close === -1) return -1;
    const rest = text.slice(close + 1);
    const m = (arrow ? /^\s*=>\s*\{/ : /^\s*\{/).exec(rest);
    return m ? close + m[0].length : -1;
  };
  const patterns: Array<[RegExp, boolean]> = [
    [/\bfunction\s*\*?\s*([\w$]+)\s*\(/g, false],
    [/([\w$]+)\s*[:=]\s*(?:async\s*)?\(/g, true],
    [/(?:^|[\s;{}])(?:async\s+)?([\w$]+)\s*\((?=[^)]*\)\s*\{)/gm, false],
  ];
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);
  for (const [re, arrow] of patterns) {
    for (const m of text.matchAll(re)) {
      const nameAt = (m.index ?? 0) + m[0].indexOf(m[1]);
      if (mask[nameAt] !== CODE || KEYWORDS.has(m[1])) continue;
      const paren = (m.index ?? 0) + m[0].length - 1;
      const brace = bodyAfterParams(paren, arrow);
      if (brace === -1 || mask[brace] !== CODE) continue;
      const end = matchBracket(text, mask, brace);
      if (end === -1) continue;
      if (!out.some((r) => r.start === nameAt)) out.push({ name: m[1], start: nameAt, end });
    }
  }
  return out;
}

/** The innermost named function containing `at`, or `<module>`. */
export function enclosingFunctionName(ranges: FunctionRange[], at: number): string {
  let best: FunctionRange | undefined;
  for (const r of ranges) {
    if (r.start <= at && at <= r.end && (!best || r.start > best.start)) best = r;
  }
  return best?.name ?? '<module>';
}

/** One call site: `name(args...)`. */
export interface CallSite {
  name: string;
  /** offset of the name */
  at: number;
  /** 1-based line of the name */
  line: number;
  /** the whole call text, `name(` through `)` */
  text: string;
  /** top-level argument texts, trimmed */
  args: string[];
  /** innermost named function containing the call */
  fn: string;
}

/**
 * Every call of one of `names` in code (not in a comment or string text; a
 * `${...}` interpolation is code). A declaration `function name(` is not a call.
 */
export function findCalls(text: string, names: readonly string[]): CallSite[] {
  const mask = lexMask(text);
  const ranges = functionRanges(text, mask);
  const re = new RegExp(`(?<![\\w$.])(${names.join('|')})\\s*\\(`, 'g');
  const out: CallSite[] = [];
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (mask[at] !== CODE) continue;
    if (/\bfunction\s*\*?\s*$/.test(text.slice(Math.max(0, at - 20), at))) continue;
    const paren = at + m[0].length - 1;
    const close = matchBracket(text, mask, paren);
    if (close === -1) continue;
    out.push({
      name: m[1],
      at,
      line: text.slice(0, at).split('\n').length,
      text: text.slice(at, close + 1),
      args: splitArgs(text, mask, paren + 1, close),
      fn: enclosingFunctionName(ranges, at),
    });
  }
  return out;
}

/**
 * The innermost `(...)` or `[...]` around `at`: its opening offset and source
 * text, or null when the nearest unclosed bracket is a `{` block (or there is
 * none).
 */
export function enclosingBracket(
  text: string,
  mask: Uint8Array,
  at: number,
): { open: number; text: string } | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (mask[i] !== CODE) continue;
    const c = text[i];
    if (CLOSE.has(c)) depth += 1;
    else if (c in OPEN) {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      if (c === '{') return null;
      const end = matchBracket(text, mask, i);
      return end === -1 ? null : { open: i, text: text.slice(i, end + 1) };
    }
  }
  return null;
}
