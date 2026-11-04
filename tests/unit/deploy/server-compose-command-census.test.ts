/**
 * Census: on a deployed server, Compose is run ONLY as `sh vc-compose <args>`
 * (VC_COMPOSE, src/lib/deploy/compose/command.js), never as a bare
 * `docker compose` and never with a `-f` list of its own.
 *
 * The class (2026-11-04, DO compose-ha scale): restoreCompose re-ran
 * app-migrate as a bare `docker compose run`, which reads docker-compose.yml
 * alone; there app-migrate is a build with no context on the server, so every
 * compose and compose-ha restore died at its migrate step. Before that the
 * same family showed up as hand-rolled `-f` lists that drifted from
 * reconcile's (scale's redis set without its .prod.yml half, compose-ha's
 * 3-file db recreate, the 2026-08-09 overlay-only service names), each
 * patched where it surfaced. vc-compose is rendered by the bundle with the
 * deploy's own set and adds the replication overlay at run time, so a call
 * cannot render a different stack from reconcile.sh's.
 *
 * Scope: every file under src/ (the CLI's remote commands, the scripts the
 * bundle renders) and carbon/backup/*.sh (run on the server by cron and over
 * ssh). Local Compose runs never spell `docker compose` as a string: they pass
 * argv to execFile, and those files are listed in LOCAL_ARGV_COMPOSE with why
 * they run locally, so a new argv caller is reviewed the day it appears.
 *
 * Each detector is bitten by a planted offender below, including the original
 * failure planted back into restoreCompose's real source.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The single source: the only file that spells `docker compose` for a server. */
const SINGLE_SOURCE = 'src/lib/deploy/compose/command.js';
/** The only file that knows the deploy's compose file list (composeFileFlags). */
const FILE_LIST_OWNER = 'src/lib/deploy/bundle.js';

/**
 * Bare `docker compose` lines that may stay, each with why. Keyed by file and
 * a fragment of the line, so a new line in the same file is still caught.
 */
const BARE_ALLOWED: { file: string; fragment: string; why: string }[] = [
  {
    file: 'src/lib/deploy/compose/db-ledger-preflight.js',
    fragment: 'docker compose up -d db',
    why:
      'the fallback half of `[ -f vc-compose ] && sh vc-compose up -d db || docker compose up -d db`, ' +
      'a hint for a server that may still hold a RETIRED stack (the preflight refuses before the ' +
      'bundle upload); that stack predates vc-compose, so its own compose files are all there is',
  },
];

/** Files that run Compose LOCALLY through an argv array, and why it is local. */
const LOCAL_ARGV_COMPOSE: Record<string, string> = {
  'src/up.js': 'reads the local dev stack status (`compose ps`) in the project dir',
  'src/down.js': 'stops a local stack by project name',
  'src/upgrade.js': 'reads the local dev stack status before an upgrade',
  'src/remove.js': 'stops a removed add-on service in the local dev stack',
  'src/lib/compose-project-name.js': 'takes down a local stack under its old project name',
  'src/lib/status/compose-ps.js': 'reads the local dev stack status for `vibecarbon status`',
};

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const read = (files: string[]) =>
  files.map((f) => ({ file: relative(ROOT, f), text: readFileSync(f, 'utf-8') }));

const SRC = read(walk(join(ROOT, 'src'), (f) => /\.(m?js)$/.test(f)));
const SERVER_SCRIPTS = read(walk(join(ROOT, 'carbon', 'backup'), (f) => f.endsWith('.sh')));

/** JS comment lines, and shell comment lines (also inside rendered scripts). */
const isComment = (line: string) => /^\s*(\/\/|\*(\s|\/|$)|\/\*|#)/.test(line);

/**
 * Physical lines joined across a trailing `+` string continuation
 * (`docker ` + newline + `compose run`), so a command split over two string
 * literals reads as one line. The joined line keeps the first line's number.
 */
function logicalLines(text: string): { line: string; n: number }[] {
  const physical = text.split('\n');
  const out: { line: string; n: number }[] = [];
  for (let i = 0; i < physical.length; i++) {
    let line = physical[i];
    const n = i + 1;
    while (
      i + 1 < physical.length &&
      /['"`]\s*\+\s*$/.test(line) &&
      !isComment(line) &&
      !isComment(physical[i + 1])
    ) {
      line = line.replace(/['"`]\s*\+\s*$/, '') + physical[i + 1].replace(/^\s*['"`]/, '');
      i++;
    }
    out.push({ line, n });
  }
  return out;
}
const codeLines = (text: string) => logicalLines(text).filter(({ line }) => !isComment(line));

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** (a) A Compose invocation spelled out: `docker compose` or the v1 `docker-compose` binary. */
const BARE =
  /\bdocker\s+compose\b|\bdocker-compose\s+(-f|-p|up|down|exec|run|ps|logs|stop|start|restart|pull|config)\b/;
function bareCompose(file: string, text: string): string[] {
  if (file === SINGLE_SOURCE) return [];
  return codeLines(text)
    .filter(({ line }) => BARE.test(line))
    .filter(({ line }) => !BARE_ALLOWED.some((a) => a.file === file && line.includes(a.fragment)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

/**
 * (b) A `-f` list of its own: a `-f`/`--file` naming a compose file (a file
 * test such as `[ -f docker-compose.replication.yml ]` is not one), the
 * base-file constants or composeFileFlags outside their owner, reconcile.sh's
 * flags read back out of it, or the set rebuilt from a container's
 * config_files label.
 */
const OWN_LIST = [
  // vc-compose already carries the full list: any -f/--file after it doubles a file or names a missing one.
  /(?:\bvc-compose|\bVC_COMPOSE\}?)\s+(?:-f|--file)\b/,
  /(?<!\[\s{0,3}|\btest\s{0,3})(?:^|[\s'"`(=])(?:-f|--file)[\s=]+['"]?docker-compose[\w.-]*\.ya?ml/,
  /\bCOMPOSE_BASE_FILES\b|\bCOMPOSE_OPTIONAL_FILES\b|\bcomposeFileFlags\s*\(/,
  /sed -n [^|]*reconcile\.sh|RECONCILE_FLAGS_SED/,
  /com\.docker\.compose\.project\.config_files/,
];
/** Files that may name a compose file list's pieces, and why it is not a -f list. */
const OWN_LIST_ALLOWED: Record<string, string> = {
  'src/lib/local-stacks.js':
    'reads the config_files label of the operator machine own stacks to find orphaned ones; ' +
    'nothing is passed to -f',
};
function ownFileList(file: string, text: string): string[] {
  if (file === SINGLE_SOURCE || file === FILE_LIST_OWNER || file in OWN_LIST_ALLOWED) return [];
  return codeLines(text)
    .filter(({ line }) => OWN_LIST.some((re) => re.test(line)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

/** (c) Compose as an argv array: `'compose'` followed by a subcommand or flag. */
const ARGV =
  /['"]compose['"]\s*,\s*['"](?:-f|-p|ps|up|down|exec|run|logs|stop|start|restart|pull|config|rm)['"]/;
function argvCompose(file: string, text: string): string[] {
  if (file in LOCAL_ARGV_COMPOSE) return [];
  return codeLines(text)
    .filter(({ line }) => ARGV.test(line))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

describe('server-side Compose runs only through vc-compose', () => {
  it('sanity: the walk sees the files that run Compose on a server', () => {
    const files = SRC.map((s) => s.file);
    for (const f of [
      SINGLE_SOURCE,
      FILE_LIST_OWNER,
      'src/lib/deploy/compose/index.js',
      'src/lib/deploy/compose/ha.js',
      'src/scale.js',
    ]) {
      expect(files).toContain(f);
    }
    expect(SERVER_SCRIPTS.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'carbon/backup/compose-backup.sh',
        'carbon/backup/tls-snapshot.sh',
        'carbon/backup/tls-retry.sh',
      ]),
    );
  });

  it('no file spells a bare `docker compose` outside the single source', () => {
    const offenders = [...SRC, ...SERVER_SCRIPTS].flatMap(({ file, text }) =>
      bareCompose(file, text),
    );
    expect(
      offenders,
      'A server-side Compose call reads its own file list (a bare one reads docker-compose.yml ' +
        'alone). Run it as `sh vc-compose <args>` (VC_COMPOSE) from the project dir (src/lib/deploy/compose/command.js).',
    ).toEqual([]);
  });

  it('no file builds a -f list of its own', () => {
    const offenders = [...SRC, ...SERVER_SCRIPTS].flatMap(({ file, text }) =>
      ownFileList(file, text),
    );
    expect(
      offenders,
      'The deploy -f set is composeFileFlags (bundle.js), rendered once into vc-compose. ' +
        'Anything else that names compose files to `-f` drifts from it.',
    ).toEqual([]);
  });

  it('argv Compose runs only in the files that run it locally', () => {
    const offenders = SRC.flatMap(({ file, text }) => argvCompose(file, text));
    expect(
      offenders,
      'A new argv `compose` call: if it runs on a server, send `sh vc-compose <args>` (VC_COMPOSE) instead; ' +
        'if it runs on the operator machine, add the file to LOCAL_ARGV_COMPOSE with why.',
    ).toEqual([]);
  });

  it('every allowance still matches a line (a stale entry is removed, not kept)', () => {
    for (const a of BARE_ALLOWED) {
      const text = SRC.find((s) => s.file === a.file)?.text ?? '';
      expect(text.includes(a.fragment), `${a.file}: ${a.fragment}`).toBe(true);
    }
    for (const file of Object.keys(LOCAL_ARGV_COMPOSE)) {
      const text = SRC.find((s) => s.file === file)?.text ?? '';
      expect(
        codeLines(text).some(({ line }) => ARGV.test(line)),
        file,
      ).toBe(true);
    }
  });

  it('composeFileFlags is defined once and called only to render the bundle', () => {
    const defs = SRC.filter(({ text }) => /function composeFileFlags\s*\(/.test(text));
    expect(defs.map((d) => d.file)).toEqual([FILE_LIST_OWNER]);
    const callers = SRC.filter(({ text }) =>
      codeLines(text).some(
        ({ line }) =>
          /\bcomposeFileFlags\s*\(/.test(line) && !/function composeFileFlags/.test(line),
      ),
    );
    expect(callers.map((c) => c.file)).toEqual([FILE_LIST_OWNER]);
  });
});

// ---------------------------------------------------------------------------
// Bite tests: each detector catches a planted offender
// ---------------------------------------------------------------------------

/** Source text containing template placeholders, written as `#{...}`. */
const tpl = (s: string) => s.replaceAll('#{', '$' + '{');

describe('the detectors bite', () => {
  it('(a) the original failure, planted back into restoreCompose, is caught', () => {
    const real = SRC.find((s) => s.file === 'src/lib/deploy/compose/index.js')?.text ?? '';
    const migrate = tpl('`cd #{remoteDir} && #{VC_COMPOSE} run --rm --no-deps app-migrate`');
    expect(real.includes(migrate), 'the real migrate line moved').toBe(true);
    const planted = real.replace(
      migrate,
      tpl('`cd #{remoteDir} && docker compose run --rm --no-deps app-migrate`'),
    );
    const found = bareCompose('src/lib/deploy/compose/index.js', planted);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/docker compose run --rm --no-deps app-migrate/);
  });

  it('(a) catches remote strings and server scripts, skips comments and vc-compose', () => {
    for (const bad of [
      tpl('await sshRunAsync(ip, key, `cd #{remoteDir} && docker compose exec -T db psql`);'),
      "const cmd = 'docker compose stop db';",
      tpl('`cd /opt/#{projectName} && docker-compose -f docker-compose.yml up -d`'),
      'traefik="$(docker compose ps -q traefik 2>/dev/null)"',
      // docker and compose split over a `+` string continuation
      tpl('`cd #{remoteDir} && docker ` +\n  `compose run --rm app-migrate`'),
      // a bare call inside a rendered shell case arm (starts with `*)`, not a comment)
      '    *) docker compose up -d ;;',
      // two spaces between the words
      'docker  compose up -d db',
    ]) {
      expect(bareCompose('src/x.js', bad), bad).toHaveLength(1);
    }
    for (const fine of [
      '// a bare `docker compose run` reads docker-compose.yml alone',
      ' * `docker compose exec` into the live db container',
      '# docker compose restart traefik, by hand',
      tpl('`cd #{remoteDir} && #{VC_COMPOSE} exec -T db psql`'),
      'traefik="$(sh vc-compose ps -q traefik 2>/dev/null)"',
      'sh vc-compose up -d db',
      ' * docker compose run, in a JSDoc comment',
      ' */',
    ]) {
      expect(bareCompose('src/x.js', fine), fine).toEqual([]);
    }
    expect(bareCompose(SINGLE_SOURCE, 'exec docker compose -f a.yml "$@"')).toEqual([]);
  });

  it('(b) catches a -f list, the base-file constants, the reconcile.sh read-back and the label rebuild', () => {
    for (const bad of [
      "const FLAGS = '-f docker-compose.yml -f docker-compose.prod.yml';",
      tpl('`#{VC_COMPOSE} -f docker-compose.replication.yml up -d db`'),
      tpl('`cd #{remoteDir} && #{VC_COMPOSE} -f #{COMPOSE_REPLICATION_OVERLAY} up -d db`'),
      tpl('`cd #{remoteDir} && #{VC_COMPOSE} -f #{DNS01_OVERRIDE_FILE} up -d db`'),
      'sh vc-compose --file extra.yml up -d db',
      tpl('const base = COMPOSE_BASE_FILES.map((f) => `-f #{f}`);'),
      'const flags = composeFileFlags(options);',
      "`FLAGS=$(sed -n '...' reconcile.sh | tail -1)`",
      `FILES="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"`,
    ]) {
      expect(ownFileList('src/x.js', bad), bad).toHaveLength(1);
    }
    for (const fine of [
      'if [ -f docker-compose.replication.yml ]; then',
      'test -f docker-compose.replication.yml && echo overlay',
      "`cat > /opt/#{projectName}/docker-compose.replication.yml << 'REPL'`",
      'sh vc-compose up -d db',
      'docker rm -f "$container_id"',
      'docker inspect -f \'{{.State.Running}}\' "$c"',
    ]) {
      expect(ownFileList('src/x.js', fine), fine).toEqual([]);
    }
    expect(ownFileList(FILE_LIST_OWNER, 'const flags = composeFileFlags(options);')).toEqual([]);
  });

  it('(c) catches an argv compose call outside the local inventory', () => {
    const bad = "await sshRun(ip, key, ['docker', 'compose', 'exec', '-T', 'db', 'psql']);";
    expect(argvCompose('src/lib/deploy/new-thing.js', bad)).toHaveLength(1);
    expect(argvCompose('src/up.js', bad)).toEqual([]);
    // Deploy-mode names are not invocations.
    expect(argvCompose('src/x.js', "static SUPPORTED_TIERS = ['compose', 'compose-ha'];")).toEqual(
      [],
    );
  });
});
