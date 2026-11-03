/**
 * Census: the wal-g role has one file, one parser, one writer module.
 *
 * The role is the one-word file WALG_ROLE_FILE (k8s: the role subPath of the
 * db volume; compose: `/opt/<project>/.vibecarbon-role`, bound read-only).
 *
 *   - One parser: WALG_ROLE_PARSE_SH (src/lib/deploy/walg-role.js) is the only
 *     text that turns the file into VC_WALG_ROLE. walg-env.sh (both copies)
 *     and tls-snapshot.sh carry it verbatim; every generated host script and
 *     e2e reader renders it through walgRoleReadFragment / walgRoleReadShell.
 *   - One writer module: role writes are spelled only in walg-role.js and in
 *     db-guard.sh's intent apply (both copies).
 *   - No env: nothing reads or writes a WALG_ROLE env, and no code path rolls
 *     the db (`kubectl set env`) to change its role.
 *   - No raw access: outside walg-role.js, a role path (the literal paths, the
 *     `walg-role` file name or the walg-role.js path constants) appears only as
 *     an argument of the parser renderers, the parser's own input line, a
 *     mount, db-guard.sh's writes, or message text. A read or write verb next
 *     to it, or a variable aliasing it, fails.
 *
 * Every census here runs over a directory walk, and each has a bite test
 * that plants a violation in a temp tree and proves the census fails on it.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WALG_ROLE_PARSE_SH } from '../../../src/lib/deploy/walg-role.js';
import { COMMENT, enclosingBracket, lex } from '../helpers/js-call-scan.js';

const REPO = join(__dirname, '../../..');
const ROOTS = [
  'src',
  'carbon/backup',
  'carbon/volumes/db',
  'carbon/k8s/base',
  'carbon/docker-compose.yml',
  'carbon/docker-compose.prod.yml',
  'tests/e2e',
];

/** Every file under each root (a root may be a file), relative to `root`. */
function walk(root: string, roots: string[]): string[] {
  const visit = (rel: string): string[] => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(root, rel));
    } catch {
      return [];
    }
    if (!st.isDirectory()) return [rel];
    return readdirSync(join(root, rel)).flatMap((n) => visit(join(rel, n)));
  };
  return roots.flatMap(visit);
}

/** Script sources the census reads as JavaScript. */
const JS_FILE = /\.(m|c)?[jt]s$/;

/** THE parser, matched verbatim under any uniform indent (a YAML block scalar indents it). */
const PARSER_INDENTED = new RegExp(
  `^( *)${WALG_ROLE_PARSE_SH.split('\n')
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\n\\1')}$`,
  'gm',
);

/** [start, end) of every copy of THE parser in a text, flush or uniformly indented. */
function parserRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(PARSER_INDENTED)].map((m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);
}

/** The census's view of one tree. */
function tree(root: string) {
  const files = walk(root, ROOTS).filter((f) => JS_FILE.test(f) || /\.(sh|ya?ml)$/.test(f));
  const text = (f: string) => readFileSync(join(root, f), 'utf-8');
  const code = (f: string) =>
    text(f)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l));
  /**
   * Does the file carry THE parser verbatim? A YAML block scalar indents its
   * script, so a ConfigMap carries it verbatim under one uniform indent.
   */
  const carriesParser = (f: string) =>
    text(f).includes(WALG_ROLE_PARSE_SH) ||
    (/\.ya?ml$/.test(f) && parserRanges(text(f)).length > 0);
  return { files, text, code, carriesParser };
}

// ---------------------------------------------------------------------------
// the censuses, each over a tree
// ---------------------------------------------------------------------------

/** Lines that read or write a WALG_ROLE env. */
function envRoleHits(root: string): string[] {
  const { files, code } = tree(root);
  return files.flatMap((f) =>
    code(f)
      .filter((l) =>
        /printenv WALG_ROLE|\$\{WALG_ROLE\b|name: WALG_ROLE\b|^\s*WALG_ROLE:|set env [^\n]*WALG_ROLE|'WALG_ROLE='|grep '\^WALG_ROLE=/.test(
          l,
        ),
      )
      .map((l) => `${f}: ${l.trim()}`),
  );
}

/** Files whose code spells the role file's atomic-write temp name. */
function roleTmpWriters(root: string): string[] {
  const { files, code } = tree(root);
  return files.filter((f) => code(f).some((l) => l.includes('walg-role.tmp'))).sort();
}

/** Files that `cat` the role file, and those of them that do not carry THE parser. */
function roleFileReaders(root: string): { readers: string[]; withoutParser: string[] } {
  const { files, text, carriesParser } = tree(root);
  const readers = files
    .filter((f) => /\bcat\b[^\n]*vc_walg_role_file|\bcat\b[^\n]*walg-role\b/.test(text(f)))
    .sort();
  const withoutParser = readers.filter(
    (f) => f !== 'src/lib/deploy/walg-role.js' && !carriesParser(f),
  );
  return { readers, withoutParser };
}

const RENDERED_READERS = [
  'src/lib/deploy/bundle.js',
  'src/lib/services/addon-start.js',
  'tests/e2e/checks/ha-integrity.ts',
];

/** The host and e2e readers that do not render the role read from walg-role.js. */
function unrenderedReaders(root: string): string[] {
  const { text } = tree(root);
  return RENDERED_READERS.filter(
    (f) =>
      !/walgRoleReadFragment|walgRoleReadShell/.test(text(f)) ||
      /\.vibecarbon-role\/walg-role[^\n]*\bcat\b|\bcat\b[^\n]*\.vibecarbon-role/.test(text(f)),
  );
}

/** src/ lines that roll the db to change its env. */
function dbEnvRolls(root: string): string[] {
  const { files, code } = tree(root);
  return files
    .filter((f) => f.startsWith('src/'))
    .flatMap((f) => code(f).filter((l) => /'set',\s*'env'|set env statefulset\/db/.test(l)));
}

/** A role path: the literal paths and file name, and (JS) walg-role.js's path constants. */
const ROLE_PATH =
  /\/var\/lib\/vibecarbon\/role|\.vibecarbon-role|(?<![\w[-])walg-role(?![\w\]-]|\.js)/g;
const ROLE_PATH_JS = new RegExp(
  `${ROLE_PATH.source}|(?<![\\w'"])(?:WALG_ROLE_FILE|WALG_ROLE_DIR|COMPOSE_WALG_ROLE_HOST_DIR)(?![\\w='"])`,
  'g',
);
const READ_VERB =
  /\bcat\s|['"]cat['"]|\bhead\s|\btail\s|readFile|\$\(<|\bsed\s|\bgrep\s|['"]grep['"]|\bawk\s|\bsource\s/;
const WRITE_VERB =
  /writeFile|appendFile|copyFile|\brename\w*\(|unlink|\bmv\s|['"]mv['"]|\bcp\s|['"]cp['"]|\btee\s|\brm\s|['"]rm['"]|\bln\s|\btouch\s|\bchmod\s|\binstall\s|printf[^\n]*>(?!&)/;

/** The module that owns the role: its constants, the parser and the writers. */
const ROLE_MODULE = 'src/lib/deploy/walg-role.js';
/** db-guard.sh's intent apply writes the role file; its ConfigMap copy is byte-identical. */
const DB_GUARD = 'carbon/volumes/db/db-guard.sh';
const DB_GUARD_COPY = 'carbon/k8s/base/backup/configmap-walg.yaml';

/**
 * `file:line: text` for every raw role read or write: a role path used other
 * than through the parser renderers, the parser's own input, a mount,
 * db-guard.sh's writes, or message text.
 */
function rawRoleAccess(root: string): string[] {
  const { files, text, carriesParser } = tree(root);
  const out: string[] = [];
  const guardLines = new Set(
    (statSync(join(root, DB_GUARD), { throwIfNoEntry: false })
      ? text(DB_GUARD).split('\n')
      : []
    ).map((l) => l.trim()),
  );

  for (const f of files) {
    if (f === ROLE_MODULE) continue;
    const src = text(f);
    const lines = src.split('\n');
    const report = (n: number) => out.push(`${f}:${n + 1}: ${lines[n].trim()}`);

    if (JS_FILE.test(f)) {
      const { mask, errors } = lex(src);
      // Fail closed: a source the lexer misreads could hide a raw access.
      if (errors.length > 0) throw new Error(`${f}: cannot scan soundly: ${errors[0]}`);
      const imports = [...src.matchAll(/^import\s[^;]*?\sfrom\s*['"][^'"]+['"];?/gm)].map((m) => [
        m.index ?? 0,
        (m.index ?? 0) + m[0].length,
      ]);
      const flagged = new Set<number>();
      for (const m of src.matchAll(ROLE_PATH_JS)) {
        const at = m.index ?? 0;
        if (mask[at] === COMMENT) continue;
        if (imports.some(([a, b]) => a <= at && at < b)) continue;
        const n = src.slice(0, at).split('\n').length - 1;
        if (flagged.has(n)) continue;
        const line = lines[n];
        const span = enclosingBracket(src, mask, at);
        const bad = (() => {
          if (
            span &&
            /\b(walgRoleReadFragment|walgRoleReadShell)\s*$/.test(src.slice(0, span.open))
          )
            return false; // rendered through the one parser
          if (!span && /\b(const|let|var)\s+[\w$]+\s*=/.test(line)) return true; // an alias
          const callee = span ? (/[\w$.]*$/.exec(src.slice(0, span.open))?.[0] ?? '') : '';
          const scope = span ? `${callee}${span.text}` : line;
          return READ_VERB.test(scope) || WRITE_VERB.test(scope);
        })();
        if (bad) {
          flagged.add(n);
          report(n);
        }
      }
      continue;
    }

    // shell and yaml: line by line
    const parser = carriesParser(f);
    lines.forEach((line, n) => {
      if (/^\s*#/.test(line) || !new RegExp(ROLE_PATH.source).test(line)) return;
      const t = line.trim();
      if (parser && /^vc_walg_role_file=/.test(t)) return; // the parser's input
      if (/^mountPath:\s*\/var\/lib\/vibecarbon\/role$/.test(t)) return;
      if (/^-\s*\.\/\.vibecarbon-role:\/var\/lib\/vibecarbon\/role(:[\w,]+)?$/.test(t)) return;
      if (/^echo\s+"/.test(t) && !READ_VERB.test(t) && !/>(?!&)/.test(t)) return; // a message
      const guard = f === DB_GUARD || (f === DB_GUARD_COPY && guardLines.has(t));
      if (guard && !READ_VERB.test(t)) return; // db-guard.sh's intent apply
      report(n);
    });
  }
  return out.sort();
}

/**
 * `file:line: text` for every shell or YAML assignment `VC_WALG_ROLE=` that is
 * not inside a copy of THE parser: the parser is the only text that sets it.
 */
function roleAssignmentsOutsideParser(root: string): string[] {
  const { files, text } = tree(root);
  return files
    .filter((f) => /\.(sh|ya?ml)$/.test(f))
    .flatMap((f) => {
      const src = text(f);
      const ranges = parserRanges(src);
      const lines = src.split('\n');
      return [...src.matchAll(/(?<![\w$])VC_WALG_ROLE=/g)]
        .map((m) => m.index ?? 0)
        .filter((at) => !ranges.some(([a, b]) => a <= at && at < b))
        .map((at) => src.slice(0, at).split('\n').length - 1)
        .filter((n) => !/^\s*#/.test(lines[n]))
        .map((n) => `${f}:${n + 1}: ${lines[n].trim()}`);
    });
}

// ---------------------------------------------------------------------------
// the repo
// ---------------------------------------------------------------------------

describe('census: the wal-g role has one file, one parser, one writer module', () => {
  it('walks real trees', () => {
    const { files } = tree(REPO);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('carbon/docker-compose.prod.yml');
    expect(files).toContain('tests/e2e/checks/ha-integrity.ts');
  });

  it('nothing reads or writes a WALG_ROLE env any more', () => {
    expect(envRoleHits(REPO)).toEqual([]);
  });

  it('only walg-role.js and db-guard.sh (both copies) write the role file', () => {
    expect(roleTmpWriters(REPO)).toEqual(
      [
        'carbon/k8s/base/backup/configmap-walg.yaml',
        'carbon/volumes/db/db-guard.sh',
        'src/lib/deploy/walg-role.js',
      ].sort(),
    );
  });

  it('every file that reads the role file carries THE parser verbatim, or renders it from walg-role.js', () => {
    const { readers, withoutParser } = roleFileReaders(REPO);
    expect(withoutParser).toEqual([]);
    expect(readers).toEqual(
      [
        'carbon/backup/tls-snapshot.sh',
        'carbon/k8s/base/backup/configmap-walg.yaml',
        'carbon/volumes/db/walg-env.sh',
        'src/lib/deploy/walg-role.js',
      ].sort(),
    );
  });

  it('host and e2e readers render the role read from walg-role.js (C6)', () => {
    expect(unrenderedReaders(REPO)).toEqual([]);
  });

  it('no code path rolls the db to change its role', () => {
    expect(dbEnvRolls(REPO)).toEqual([]);
  });

  it('no raw role parse or write outside the parser and the named writers', () => {
    expect(rawRoleAccess(REPO)).toEqual([]);
  });

  it('only THE parser assigns VC_WALG_ROLE in shell and YAML', () => {
    expect(roleAssignmentsOutsideParser(REPO)).toEqual([]);
    // the census sees the three parser copies it lets through
    const { files, text } = tree(REPO);
    expect(
      files.filter((f) => /\.(sh|ya?ml)$/.test(f) && parserRanges(text(f)).length > 0).sort(),
    ).toEqual(
      [
        'carbon/backup/tls-snapshot.sh',
        'carbon/k8s/base/backup/configmap-walg.yaml',
        'carbon/volumes/db/walg-env.sh',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// bites: each census fails on a planted violation
// ---------------------------------------------------------------------------

describe('census bites', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A temp tree holding the repo's census-relevant files, plus `files` on top. */
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-role-census-'));
    dirs.push(dir);
    const keep = [
      ROLE_MODULE,
      DB_GUARD,
      DB_GUARD_COPY,
      'carbon/volumes/db/walg-env.sh',
      'carbon/backup/tls-snapshot.sh',
      ...RENDERED_READERS,
    ];
    for (const f of keep) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), readFileSync(join(REPO, f), 'utf-8'));
    }
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), t);
    }
    return dir;
  };

  it('the copied tree is clean', () => {
    const dir = fixture({});
    expect(envRoleHits(dir)).toEqual([]);
    expect(roleTmpWriters(dir)).toHaveLength(3);
    expect(roleFileReaders(dir).withoutParser).toEqual([]);
    expect(unrenderedReaders(dir)).toEqual([]);
    expect(dbEnvRolls(dir)).toEqual([]);
    expect(rawRoleAccess(dir)).toEqual([]);
    expect(roleAssignmentsOutsideParser(dir)).toEqual([]);
  });

  it('a ConfigMap whose indented parser differs by one character is a reader without THE parser', () => {
    const yaml = readFileSync(join(REPO, DB_GUARD_COPY), 'utf-8');
    const changed = yaml.replace(
      'primary) VC_WALG_ROLE=primary ;;',
      'primary) VC_WALG_ROLE=primarY ;;',
    );
    expect(changed).not.toBe(yaml);
    const dir = fixture({ [DB_GUARD_COPY]: changed });
    expect(roleFileReaders(dir).withoutParser).toEqual([DB_GUARD_COPY]);
    expect(roleAssignmentsOutsideParser(dir)).toEqual([
      expect.stringMatching(
        /^carbon\/k8s\/base\/backup\/configmap-walg\.yaml:\d+: VC_WALG_ROLE=""$/,
      ),
      expect.stringMatching(/: primary\) VC_WALG_ROLE=primarY ;;$/),
      expect.stringMatching(/: standby\) VC_WALG_ROLE=standby ;;$/),
    ]);
  });

  it('a VC_WALG_ROLE assignment outside the parser is caught, in shell and in YAML', () => {
    const dir = fixture({
      'carbon/backup/stray.sh': 'VC_WALG_ROLE=primary\n',
      'carbon/k8s/base/stray.yaml': 'data:\n  s: |\n    export VC_WALG_ROLE=standby\n',
    });
    expect(roleAssignmentsOutsideParser(dir)).toEqual([
      'carbon/backup/stray.sh:1: VC_WALG_ROLE=primary',
      'carbon/k8s/base/stray.yaml:3: export VC_WALG_ROLE=standby',
    ]);
  });

  it('a JS source the lexer misreads fails the raw-access census loudly', () => {
    const dir = fixture({ 'src/misread.cjs': 'if (x) /\\(/.test(WALG_ROLE_FILE);\n' });
    expect(() => rawRoleAccess(dir)).toThrow(/src\/misread\.cjs: cannot scan soundly/);
  });

  it('a WALG_ROLE env read is caught', () => {
    const dir = fixture({ 'carbon/volumes/db/stray.sh': 'r=$(printenv WALG_ROLE)\n' });
    expect(envRoleHits(dir)).toEqual(['carbon/volumes/db/stray.sh: r=$(printenv WALG_ROLE)']);
  });

  it('a third role writer is caught', () => {
    const dir = fixture({
      'src/stray.js': "export const w = 'cd /x && mv -f walg-role.tmp walg-role';\n",
    });
    expect(roleTmpWriters(dir)).toContain('src/stray.js');
  });

  it('a reader without THE parser is caught', () => {
    const dir = fixture({
      'carbon/backup/stray.sh':
        'vc_walg_role_file=.vibecarbon-role/walg-role\nrole=$(cat "$vc_walg_role_file")\n',
    });
    expect(roleFileReaders(dir).withoutParser).toEqual(['carbon/backup/stray.sh']);
  });

  it('a host reader that cats the role file itself is caught', () => {
    const dir = fixture({
      'src/lib/deploy/bundle.js': 'export const s = `cat .vibecarbon-role/walg-role`;\n',
    });
    expect(unrenderedReaders(dir)).toEqual(['src/lib/deploy/bundle.js']);
  });

  it('a db roll to change the role is caught', () => {
    const dir = fixture({
      'src/stray.js': "await kubectl(ip, ['set', 'env', 'statefulset/db', 'X=1']);\n",
    });
    expect(dbEnvRolls(dir)).toHaveLength(1);
  });

  it('raw role reads and writes are caught, multi-line and aliased ones included', () => {
    const dir = fixture({
      'src/a.js': [
        "import { WALG_ROLE_FILE } from './walg-role.js';",
        'export async function a(ip) {',
        '  return kubectl(ip, [',
        "    'exec',",
        "    'db-0',",
        "    'cat',",
        '    WALG_ROLE_FILE,',
        '  ]);',
        '}',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text for the scanner
        "export const b = (dir) => writeFileSync(`${dir}/walg-role`, 'primary');",
        'const p = WALG_ROLE_FILE;',
        '',
      ].join('\n'),
      'tests/e2e/c.ts':
        "export const c = (ip) => ssh(ip, 'cat /opt/app/.vibecarbon-role/walg-role');\n",
      'carbon/backup/d.sh': 'role=$(head -1 /var/lib/vibecarbon/role/walg-role)\n',
      'carbon/volumes/db/e.sh': "printf 'standby\\n' > /var/lib/vibecarbon/role/walg-role\n",
    });
    expect(rawRoleAccess(dir)).toEqual([
      'carbon/backup/d.sh:1: role=$(head -1 /var/lib/vibecarbon/role/walg-role)',
      "carbon/volumes/db/e.sh:1: printf 'standby\\n' > /var/lib/vibecarbon/role/walg-role",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text for the scanner
      "src/a.js:10: export const b = (dir) => writeFileSync(`${dir}/walg-role`, 'primary');",
      'src/a.js:11: const p = WALG_ROLE_FILE;',
      'src/a.js:7: WALG_ROLE_FILE,',
      "tests/e2e/c.ts:1: export const c = (ip) => ssh(ip, 'cat /opt/app/.vibecarbon-role/walg-role');",
    ]);
  });

  it('lets the renderers, mounts, messages and the parser input through', () => {
    const dir = fixture({
      'src/ok.js': [
        "import { WALG_ROLE_DIR, walgRoleReadShell } from './walg-role.js';",
        'export const r = walgRoleReadShell(WALG_ROLE_DIR);',
        'export const f = () => walgRoleReadFragment(`.vibecarbon-role/walg-role`);',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text for the scanner
        'throw new Error(`no ${WALG_ROLE_DIR} mount on db-0; run a deploy`);',
        '',
      ].join('\n'),
      'carbon/k8s/base/ok.yaml':
        '        - name: role\n          mountPath: /var/lib/vibecarbon/role\n',
      'carbon/backup/ok.sh':
        'echo "backup refused: no wal-g role in /var/lib/vibecarbon/role/walg-role" >&2\n',
    });
    expect(rawRoleAccess(dir)).toEqual([]);
  });
});
