import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Census: every write to .vibecarbon.json is one locked read-modify-write
 * through updateProjectConfig, and no mutator writes back stale state
 * (backup/restore integrity M6).
 *
 * The old shape, `loadProjectConfig()` early, mutate, `saveProjectConfig(all)`
 * late, wrote the WHOLE file from a copy that could be minutes stale: a
 * failover journal, a write-fence marker or a scale's cutover journal saved by
 * another step (or another terminal) in between was silently dropped. The walk
 * covers every module under src/, so a writer added later is caught too. Each
 * rule is a function over (file, source) so the self-tests below can prove it
 * catches the shapes it exists for.
 */

const SRC = join(process.cwd(), 'src');
const CONFIG = join('lib', 'config.js');

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

type Source = { rel: string; text: string };

const sources: Source[] = jsFiles(SRC).map((file) => ({
  rel: relative(SRC, file),
  text: readFileSync(file, 'utf-8'),
}));

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const codeLines = (text: string) =>
  text.split('\n').flatMap((line, i) => (isComment(line) ? [] : [{ line, n: i + 1 }]));

/**
 * Where the bare file name may still appear as a string of its own, outside
 * config.js. Each is a read or a label, never a path anything opens or writes.
 */
const LITERAL_ALLOWLIST: Record<string, string> = {
  [join('lib', 'deploy', 'delta.js')]:
    'read-only: classifies a changed repo path as the config file, never opens it',
  [join('lib', 'deploy', 'prompts.js')]:
    'a label: names where an object-storage credential came from in a log line',
};

/**
 * The file name as its own string token, or a path ending in it. (Inside
 * prose, as in a help line's `.vibecarbon.json`, it is a label.)
 */
const LITERAL = /(['"])\.vibecarbon\.json\1|[/\\]\.vibecarbon\.json\b/;

function literalOffenders({ rel, text }: Source): string[] {
  if (rel === CONFIG || rel in LITERAL_ALLOWLIST) return [];
  return codeLines(text)
    .filter(({ line }) => LITERAL.test(line))
    .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
}

/** Any fs call that writes, renames, copies or streams into a file. */
const FS_WRITE =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|copyFileSync|copyFile|cpSync|createWriteStream|truncateSync|truncate)\s*\(/;

/** A module that names the config file may not write any file at all. */
function writeOffenders({ rel, text }: Source): string[] {
  if (rel === CONFIG || !/\bCONFIG_FILE\b/.test(text)) return [];
  return codeLines(text)
    .filter(({ line }) => FS_WRITE.test(line))
    .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
}

/** Skip a string or template literal starting at i; returns the index after it. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) {
    if (text[j] === '\\') j += 2;
    else if (quote === '`' && text[j] === '$' && text[j + 1] === '{')
      j = matchClose(text, j + 1) + 1;
    else j += 1;
  }
  return j + 1;
}

/** Index of the bracket closing the one at `open`. */
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[text[open]]];
  let i = open + 1;
  while (i < text.length && stack.length > 0) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return text.length;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 2;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return i - 1;
}

type Mutator = { at: string; param: string | null; body: string; inline: boolean };

/** Every `updateProjectConfig(<mutator>, ...)` call's mutator. */
function mutators({ rel, text }: Source): Mutator[] {
  const out: Mutator[] = [];
  const call = /\bupdateProjectConfig\(/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, open);
    const args = text.slice(open + 1, close);
    const at = `${rel}:${text.slice(0, m.index).split('\n').length}`;
    const arrow = /^\s*(?:\(\s*([A-Za-z_$][\w$]*)?\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*/.exec(args);
    if (!arrow) {
      out.push({ at, param: null, body: args, inline: false });
      continue;
    }
    const param = arrow[1] ?? arrow[2] ?? null;
    let body = args.slice(arrow[0].length);
    if (body.startsWith('{') || body.startsWith('(')) {
      body = body.slice(0, matchClose(body, 0) + 1);
    }
    out.push({ at, param, body, inline: true });
  }
  return out;
}

/** An identifier holding a whole project config loaded earlier. */
const STALE_CONFIG = /\.\.\.\s*((?:ctx\.)?[A-Za-z_$]*[Pp]rojectConfig)\b/g;

/** Whole-env write by assignment: `environments[x] = <rhs>`. */
const ENV_ASSIGN = /environments\s*(?:\?\.)?\[[^\]]+\]\s*=(?!=)\s*(.*)/;
/** A computed key, `[env]: <rhs>`, at the top of an `environments` object literal. */
const COMPUTED_KEY = /^\s*\[\s*[A-Za-z_$][\w$.]*\s*\]\s*:\s*(.*)/;

/** The right-hand sides of every whole-env write in a mutator body. */
function wholeEnvWrites(body: string): { line: string; rhs: string }[] {
  const out: { line: string; rhs: string }[] = [];
  for (const line of body.split('\n')) {
    const m = ENV_ASSIGN.exec(line);
    if (m) out.push({ line, rhs: m[1] });
  }
  const literal = /\benvironments\s*[:=]\s*\{/g;
  for (let m = literal.exec(body); m; m = literal.exec(body)) {
    const open = m.index + m[0].length - 1;
    const inner = body.slice(open + 1, matchClose(body, open));
    for (const line of inner.split('\n')) {
      const k = COMPUTED_KEY.exec(line);
      if (k) out.push({ line, rhs: k[1] });
    }
  }
  return out;
}

function mutatorOffenders(src: Source): string[] {
  return mutators(src).flatMap(({ at, param, body, inline }) => {
    if (!inline) return [`${at}: the mutator is not an inline arrow function`];
    const problems: string[] = [];
    if (!param) problems.push(`${at}: the mutator takes no config argument`);
    else if (!new RegExp(`\\b${param.replace(/\$/g, '\\$')}\\b`).test(body)) {
      problems.push(`${at}: the mutator ignores its config argument (${param})`);
    }
    for (const m of body.matchAll(STALE_CONFIG)) {
      const name = m[1];
      const declared = new RegExp(`\\b(const|let|var)\\s+${name.replace(/[.$]/g, '\\$&')}\\b`);
      if (name !== param && !declared.test(body)) {
        problems.push(`${at}: the mutator spreads ${name}, a config loaded outside the lock`);
      }
    }
    for (const { line, rhs } of wholeEnvWrites(body)) {
      if (!/^preserveSafetyFields\(/.test(rhs)) {
        problems.push(`${at}: whole-env write not through preserveSafetyFields: ${line.trim()}`);
      }
    }
    return problems;
  });
}

const all = (rule: (s: Source) => string[]) => sources.flatMap(rule);
const lines = (pattern: RegExp, exempt: string[] = []) =>
  sources
    .filter(({ rel }) => !exempt.includes(rel))
    .flatMap(({ rel, text }) =>
      codeLines(text)
        .filter(({ line }) => pattern.test(line))
        .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`),
    );

describe('.vibecarbon.json has one writer', () => {
  it('no module outside lib/config.js calls or imports saveProjectConfig', () => {
    expect(
      lines(/\bsaveProjectConfig\b/, [CONFIG]),
      'Use updateProjectConfig((config) => { ...patch... }): it reloads the file under ' +
        'the lock, so a field another step saved meanwhile is kept, not overwritten.',
    ).toEqual([]);
  });

  it('lib/config.js keeps saveProjectConfig internal and exports CONFIG_FILE', () => {
    const config = sources.find(({ rel }) => rel === CONFIG)?.text ?? '';
    expect(config).not.toMatch(/export\s+function\s+saveProjectConfig\b/);
    expect(config).toContain("export const CONFIG_FILE = '.vibecarbon.json';");
  });

  it('the manifest half writes through updateProjectConfig too (no saveManifest)', () => {
    expect(lines(/\bsaveManifest\b/)).toEqual([]);
  });

  it('the file name appears outside lib/config.js only where allowlisted, with a reason', () => {
    expect(all(literalOffenders), 'build the path with CONFIG_FILE inside lib/config.js').toEqual(
      [],
    );
    for (const [rel, reason] of Object.entries(LITERAL_ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(10);
      // An allowlist entry that no longer matches anything is stale: drop it.
      const src = sources.find((s) => s.rel === rel);
      expect(src && LITERAL.test(src.text), `${rel} no longer needs its allowlist entry`).toBe(
        true,
      );
    }
  });

  it('no module that names CONFIG_FILE writes, renames, copies or streams a file', () => {
    expect(all(writeOffenders)).toEqual([]);
  });

  it('every mutator uses its fresh argument, spreads no stale config, and keeps safety fields', () => {
    expect(all(mutatorOffenders)).toEqual([]);
  });

  it('the walk sees the writers it guards', () => {
    const calls = sources.flatMap(mutators);
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.every((c) => c.inline)).toBe(true);
    // The whole-env writers really are matched (guards WHOLE_ENV).
    const wholeEnv = calls.filter((c) => wholeEnvWrites(c.body).length > 0);
    expect(wholeEnv.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the census catches the shapes it exists for', () => {
  const src = (text: string, rel = join('lib', 'example.js')): Source => ({ rel, text });

  it('a hand-built path to the file, in either style', () => {
    expect(
      literalOffenders(src("fs.writeFileSync(join(process.cwd(), '.vibecarbon.json'), x);")),
    ).toHaveLength(1);
    expect(
      literalOffenders(src(['const p = `$', '{cwd}/.vibecarbon.json`;'].join(''))),
    ).toHaveLength(1);
    expect(literalOffenders(src("p.log.info('edit .vibecarbon.json and rerun');"))).toEqual([]);
  });

  it('a write through a path variable in a module that names CONFIG_FILE', () => {
    const text = 'const configPath = join(cwd, CONFIG_FILE);\nwriteFileSync(configPath, x);';
    expect(writeOffenders(src(text))).toHaveLength(1);
  });

  it('fs/promises writeFile and copyFileSync', () => {
    expect(
      writeOffenders(src('import { CONFIG_FILE } from "./config.js";\nawait writeFile(p, x);')),
    ).toHaveLength(1);
    expect(writeOffenders(src('const f = CONFIG_FILE;\ncopyFileSync(a, b);'))).toHaveLength(1);
  });

  it('a mutator that spreads a stale config or ignores its argument', () => {
    expect(
      mutatorOffenders(src('updateProjectConfig((config) => ({ ...config, ...projectConfig }));')),
    ).toEqual([expect.stringMatching(/spreads projectConfig/)]);
    expect(
      mutatorOffenders(src('updateProjectConfig((_c) => ({ ...ctx.loadedProjectConfig }));')),
    ).toEqual([
      expect.stringMatching(/ignores its config argument/),
      expect.stringMatching(/spreads ctx\.loadedProjectConfig/),
    ]);
    expect(mutatorOffenders(src('updateProjectConfig(() => staleWhole);'))).toEqual([
      expect.stringMatching(/takes no config argument/),
    ]);
    expect(mutatorOffenders(src('updateProjectConfig(mutate, cwd);'))).toEqual([
      expect.stringMatching(/not an inline arrow/),
    ]);
  });

  it('a whole-env write that skips preserveSafetyFields', () => {
    const bad = `updateProjectConfig((config) => {
  config.environments[environment] = { ...envEntry };
});`;
    expect(mutatorOffenders(src(bad))).toEqual([expect.stringMatching(/whole-env write/)]);
    const literal = `updateProjectConfig((config) => {
  config.environments = {
    ...config.environments,
    [environment]: envEntry,
  };
});`;
    expect(mutatorOffenders(src(literal))).toEqual([expect.stringMatching(/whole-env write/)]);
    const good = `updateProjectConfig((config) => {
  config.environments[environment] = preserveSafetyFields(config.environments[environment], e);
});`;
    expect(mutatorOffenders(src(good))).toEqual([]);
  });
});
