/**
 * Structural pins for the x86-64 standardization (owner decision 2026-07-30):
 * **vibecarbon is amd64-only; multi-architecture support is dropped.**
 *
 * The behavioral guards live next to each unit — the build argv in
 * image.test.ts / remote-build.test.ts, the option lists in
 * lib/server-types.test.ts + deploy/tier-routing.test.ts, the resolver and the
 * type guard in providers/hetzner.test.ts. What those CANNOT catch is a *new*
 * `docker build` call site, or a new command that takes a server type from the
 * operator, silently skipping the invariant. This file is the recall net for
 * exactly that: it reads the source tree and fails when a build site or a
 * type entry point appears without opting in.
 *
 * A failure here is not necessarily a bug — it means a new site exists and has
 * to be either pinned (add the platform flag / the guard) or registered below
 * with a reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AMD64_BUILD_HINT,
  PLATFORM_BUILD_FLAG,
  TARGET_PLATFORM,
} from '../../../src/lib/deploy/platform.js';

const SRC_ROOT = join(process.cwd(), 'src');

function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkJsFiles(full));
    else if (st.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

const SRC_FILES = walkJsFiles(SRC_ROOT).map((path) => ({
  path,
  rel: path.slice(SRC_ROOT.length + 1).replaceAll('\\', '/'),
  src: readFileSync(path, 'utf-8'),
}));

/** Source of `src/<rel>`; throws (rather than silently passing) if it moved. */
function sourceOf(rel: string): string {
  const file = SRC_FILES.find((f) => f.rel === rel);
  if (!file) throw new Error(`amd64-only pin: src/${rel} not found — did it move or get renamed?`);
  return file.src;
}

describe('platform constants', () => {
  it('targets linux/amd64', () => {
    expect(TARGET_PLATFORM).toBe('linux/amd64');
    expect(PLATFORM_BUILD_FLAG).toBe('--platform=linux/amd64');
  });

  it('the build hint names the pin AND how to fix an arm64 host', () => {
    // An operator whose Docker lacks amd64 emulation now gets a hard build
    // failure instead of a silently wrong-arch image. That is the intended
    // trade, but BuildKit's own error ("exec format error") gives them nothing
    // to act on — the hint has to.
    expect(AMD64_BUILD_HINT).toContain('linux/amd64');
    expect(AMD64_BUILD_HINT).toContain('exec format error');
    expect(AMD64_BUILD_HINT).toContain('binfmt');
  });
});

describe('every docker-build site in the deploy path pins the platform', () => {
  // A `docker build` argv, however it is spelled: `['docker', 'build', ...]`
  // (remote-build, orchestrator) or `['build', ...]` later prefixed with
  // 'docker' (image.js). Whitespace-tolerant so a prettier-wrapped multi-line
  // argv still matches — the orchestrator's is exactly that shape.
  const DOCKER_BUILD_ARGV = /\[\s*(?:'docker',\s*)?'build',/;

  // The other way a build can be spelled: as a SHELL COMMAND rather than an
  // argv. `docker buildx` is deliberately included — buildx honours --platform
  // too.
  //
  // This is matched per LINE, not per string literal, and that is the whole
  // point. A single-line `runCommand('docker build …')` is not the realistic
  // shape here: check-shell-safety.js already bans
  // `runCommand`/`runCommandAsync` with a template literal, and the argv form
  // is what the codebase uses everywhere else. The shape that IS reachable is a
  // multi-line bash script handed to `runShellScript` (src/lib/command.js) or
  // `sshRunScript` (src/lib/ssh.js) — the sanctioned escape hatch for genuine
  // shell pipelines, with live call sites in backup.js, scale.js and
  // compose/index.js. Inside one of those, a build sits on its own line with no
  // quote character anywhere near it:
  //
  //     await sshRunScript(ip, key, `
  //       set -euo pipefail
  //       docker build -t ${tag} .        <-- no quote on this line
  //     `);
  //
  // An earlier version of this scan required a quote/backtick earlier on the
  // SAME line, which made it structurally incapable of seeing that — i.e. it
  // reported green over its own blind spot while mostly re-covering ground lint
  // already holds. Per-line, comment-stripped, quote-agnostic sees it.
  const DOCKER_BUILD_SHELL = /\bdocker\s+build(x)?\b/;

  // Registered build sites. Each must import PLATFORM_BUILD_FLAG so the pin
  // travels with the argv rather than being retyped per call site.
  const REGISTERED = [
    'lib/deploy/image.js', // operator-side build (compose sideload + k8s buildAppImage)
    'lib/deploy/orchestrator.js', // compose-single local build, inlined in the orchestrator
    'lib/deploy/remote-build.js', // buildRemote: compose-ha fan, direct mode, scale
  ];

  // Comments legitimately discuss `docker build` (error-message context, RCA
  // notes, this very file's neighbours), so the shell scan runs on code with
  // comments stripped. Shared shape with the provider-SKU scan further down.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** Comment-stripped lines of `src` that read as a shell-form docker build. */
  const shellBuildLines = (src: string): string[] =>
    stripComments(src)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => DOCKER_BUILD_SHELL.test(line));

  it('finds no unregistered docker-build call site', () => {
    const found = SRC_FILES.filter((f) => DOCKER_BUILD_ARGV.test(f.src)).map((f) => f.rel);
    expect(found.sort()).toEqual([...REGISTERED].sort());
  });

  // A recall net whose matcher silently matches nothing is worse than no net at
  // all — it reports green forever. Pin both directions on samples.
  it('the shell-form matcher catches a build inside a multi-line bash script', () => {
    // THE case this scan exists for, and the one the previous same-line-quote
    // version could not express: a build line inside a bash script string,
    // where the nearest quote is lines away.
    const script = [
      'await sshRunScript(ip, sshKeyPath, `',
      '  set -euo pipefail',
      '  cd /opt/app',
      '  docker build -t "$TAG" .',
      '`);',
    ].join('\n');
    expect(shellBuildLines(script)).toEqual(['docker build -t "$TAG" .']);

    // Same for the local variant, and for a heredoc body.
    expect(
      shellBuildLines('runShellScript(`\ncat <<EOF\nEOF\ndocker buildx build --push .\n`)'),
    ).toEqual(['docker buildx build --push .']);
  });

  it('the shell-form matcher matches single-line string builds too', () => {
    for (const sample of [
      `runCommand('docker build -t x .')`,
      'runCommand(`docker build -t app .`)',
      `sshRun(ip, "docker build .")`,
      `run('docker buildx build --push .')`,
    ]) {
      expect(DOCKER_BUILD_SHELL.test(sample), sample).toBe(true);
    }
  });

  it('the shell-form matcher does not match argv builds, identifiers, or comments', () => {
    for (const sample of [
      `const argv = ['docker', 'build', '-t', tag];`,
      `const argv = ['build', '-t', tag];`,
      `await dockerBuild(tag, context);`,
      `const cmd = ['docker', 'buildx', 'build'];`,
    ]) {
      expect(DOCKER_BUILD_SHELL.test(sample), sample).toBe(false);
    }
    // Prose is exempt because comments are stripped first, not because the
    // matcher is clever — pin that, since the stripper is what carries it.
    for (const sample of [
      `// docker build is pinned to linux/amd64\nconst x = 1;`,
      `/**\n * Every \`docker build\` passes PLATFORM_BUILD_FLAG.\n */\nconst y = 2;`,
      `const argv = [\n  'docker',\n  'build',\n];`,
    ]) {
      expect(shellBuildLines(sample), sample).toEqual([]);
    }
    // Known over-match, and why the scan excludes REGISTERED files: prose
    // inside a STRING (an error message) reads the same as a shell-out. That
    // is the safe direction for a recall net — a new unregistered file
    // mentioning `docker build` in an error costs one line in REGISTERED,
    // whereas a missed build site ships a wrong-arch image.
    expect(DOCKER_BUILD_SHELL.test('throw new Error(`docker build failed`)')).toBe(true);
  });

  it('finds no shell-form `docker build` anywhere in src', () => {
    // A new site here is not automatically wrong — it just cannot be pinned by
    // the argv convention, so it has to either adopt the argv shape or
    // interpolate PLATFORM_BUILD_FLAG and be registered above.
    const found = SRC_FILES.filter((f) => {
      // A registered site may legitimately carry `docker build` inside an error
      // string; only flag one that looks like an actual shell-out.
      return shellBuildLines(f.src).length > 0 && !REGISTERED.includes(f.rel);
    }).map((f) => ({ rel: f.rel, lines: shellBuildLines(f.src) }));
    expect(found).toEqual([]);
  });

  it.each(REGISTERED)('%s imports and uses PLATFORM_BUILD_FLAG', (rel) => {
    const src = sourceOf(rel);
    expect(src).toMatch(/from '.*platform\.js'/);
    expect(src).toContain('PLATFORM_BUILD_FLAG');
  });
});

describe('every operator-supplied server type is guarded', () => {
  // The catalogs and option builders keep ARM out of anything the CLI
  // *presents*. These are the paths where a type arrives as raw text instead —
  // a flag, or a hand-edited .vibecarbon.json — so they must call the guard.
  const GUARDED_ENTRY_POINTS = [
    ['scale.js', '-type'],
    ['failover.js', '-server-type'],
    ['lib/deploy/prompts.js', '.vibecarbon.json'],
  ] as const;

  it.each(GUARDED_ENTRY_POINTS)('%s calls assertAmd64ServerType (%s)', (rel, label) => {
    const src = sourceOf(rel);
    expect(src).toContain('assertAmd64ServerType');
    expect(src).toContain(label);
  });
});

describe('no provider SKU literals leak into shared paths', () => {
  // Hetzner's ARM line is `cax*`. That naming may only be KNOWN inside
  // src/lib/providers/ — everything else filters on the provider-stamped
  // `architecture` field (lib/server-types.js filterAmd64Types) or calls
  // Provider.isArmServerType/assertAmd64ServerType. Prose is exempt: comments
  // legitimately explain the history (RCA 2026-06-23, the ARM→x86 rescue), so
  // the scan runs on code with comments stripped.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('the cax literal appears in no executable code outside lib/providers/', () => {
    const offenders = SRC_FILES.filter(
      (f) => !f.rel.startsWith('lib/providers/') && /cax\d/.test(stripComments(f.src)),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
