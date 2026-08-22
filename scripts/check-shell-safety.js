#!/usr/bin/env node
/**
 * Shell-safety guard for src/ and tests/e2e/.
 *
 * Scans every .js / .ts file for patterns that bypass the argv-only
 * command contract. The argv contract is what keeps user-influenced data
 * out of shell interpretation — see docs/security.md for the rationale.
 *
 * Patterns flagged:
 *   1. runCommand / runCommandAsync invoked with a template-literal first arg.
 *   2. Direct use of child_process exec / execSync (imports from that
 *      module are tracked per-file to avoid false positives on unrelated
 *      identifiers such as RegExp#exec).
 *   3. execa called with `shell: true`.
 *   4. Inline SSH command strings of the form `ssh ... "${...}"` on a
 *      single line — shell-string SSH invocations with JS interpolation.
 *   5. ssh/scp argv that lacks `BatchMode=yes`. Without it, key-auth
 *      failure falls back to interactive password prompt and hangs the
 *      deploy until our timeout fires (see PR 1BT for the long story).
 *      A runtime guard in src/cli.js + tests/e2e/runner.ts kills
 *      askpass globally, but lint catches the issue at PR-time so a new
 *      contributor doesn't ship a bare ssh and have to debug a mysterious
 *      "k3s did not become ready" timeout six hours later.
 *
 * Opt-out: place `// shell-safety-ignore: <reason>` on the same line as
 * the match, or on the line immediately above it. Keep reasons specific.
 *
 * Exits 1 on any unignored violation, 0 when clean.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'src');
// tests/e2e is in scope because the 2026-04-27 audit found two
// BatchMode-missing call sites here (tests/e2e/utils/ssh.ts and
// tests/e2e/checks/feature-redis.ts). Unit tests under tests/unit
// don't spawn ssh, so they're out of scope.
const e2eDir = join(repoRoot, 'tests/e2e');

const SKIP_DIRS = new Set();

function* walkSourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const rel = full.slice(repoRoot.length + 1);
      if (SKIP_DIRS.has(rel)) continue;
      yield* walkSourceFiles(full);
    } else if (st.isFile() && (full.endsWith('.js') || full.endsWith('.ts'))) {
      yield full;
    }
  }
}

// Extract identifiers imported from node:child_process (static + dynamic).
function extractChildProcessImports(src) {
  const names = new Set();
  const staticRe =
    /import\s*(?:type\s*)?\{\s*([^}]+)\s*\}\s*from\s*['"](?:node:)?child_process['"]/g;
  const dynamicRe =
    /(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*(?:await\s+)?import\s*\(\s*['"](?:node:)?child_process['"]\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

// Returns true if the given line or the line immediately above it carries
// a `// shell-safety-ignore:` pragma.
function isIgnored(lines, idx) {
  const onLine = lines[idx] ?? '';
  const prev = idx > 0 ? lines[idx - 1] : '';
  return /\/\/\s*shell-safety-ignore:/.test(onLine) || /\/\/\s*shell-safety-ignore:/.test(prev);
}

const DANGEROUS_CP_NAMES = new Set(['exec', 'execSync']);

// Spread of a known-good opts bundle. These names are defined in the codebase
// (and audited to include BatchMode=yes); a spread of them is equivalent to
// inlining BatchMode. Shared by Patterns 5 and 5b. Updated when new helpers
// land.
//   - SSH_OPTS                : compose modules + tests/e2e/utils
//   - sshOpts                 : k8s/ha/index.js, deploy/utils.js (local var)
//   - sshArgs(...)            : k3s.js / diagnose.js (function returning argv)
//   - sshHostKeyOpts(...)     : src/lib/ssh.js + k3s.js (function returning argv)
//   - buildHostKeyOpts[ForPath](...) : src/lib/host-keys.js (single source of
//     truth; SSH_CONNECTION_OPTS there carries BatchMode=yes)
//   - SSH_OPTIONS             : tests/e2e/checks/feature-redis.ts
const KNOWN_GOOD_SSH_OPTS_RE =
  /\.\.\.\s*(SSH_OPTS|SSH_OPTIONS|sshOpts|sshArgs|sshHostKeyOpts|buildHostKeyOpts\w*)\b|\b(?:sshHostKeyOpts|buildHostKeyOpts\w*)\s*\(/;

const violations = [];

function record(file, lineNumber, line, patternId, message) {
  violations.push({
    file: relative(repoRoot, file),
    line: lineNumber,
    snippet: line.trim().slice(0, 120),
    patternId,
    message,
  });
}

// Map a whole-file offset back to a 0-based line index.
function offsetToLine(src, offset) {
  let line = 0;
  let seen = 0;
  for (const l of src.split('\n')) {
    if (seen + l.length >= offset) return line;
    seen += l.length + 1;
    line++;
  }
  return line;
}

// Find the byte offset of the matching closing `]` or `)` starting from
// `start`, ignoring brackets inside strings. Returns the offset of the
// closer or `src.length` if unbalanced. Used by Pattern 5 to know how
// far forward to scan for `BatchMode` after finding `'ssh'` or `'scp'`.
function findMatchingClose(src, start) {
  let depthBracket = 0;
  let depthParen = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '`' && prev !== '\\') inBacktick = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inBacktick = true;
    else if (ch === '[') depthBracket++;
    else if (ch === '(') depthParen++;
    else if (ch === ']') {
      depthBracket--;
      if (depthBracket < 0) return i;
    } else if (ch === ')') {
      depthParen--;
      if (depthParen < 0) return i;
    }
    // Hard cap: an ssh argv definition shouldn't span more than ~3000
    // characters; if we hit that we're probably in a malformed file or
    // a file with weird formatting, so bail and let other patterns flag.
    if (i - start > 3000) return i;
  }
  return src.length;
}

// Iterate src/ first, then tests/e2e/. Both directories share the
// same per-file pattern checks; tests/unit is excluded because it doesn't
// spawn child processes.
const filesToScan = [...walkSourceFiles(srcDir), ...walkSourceFiles(e2eDir)];
for (const file of filesToScan) {
  const src = readFileSync(file, 'utf-8');
  const lines = src.split('\n');
  const cpImports = extractChildProcessImports(src);
  const dangerousNames = [...cpImports].filter((n) => DANGEROUS_CP_NAMES.has(n));

  // Pattern 1: runCommand / runCommandAsync(<whitespace>`...`) — multi-line aware.
  const p1 = /\brunCommand(?:Async)?\s*\(\s*`/g;
  for (let pm; (pm = p1.exec(src)) !== null; ) {
    const idx = offsetToLine(src, pm.index);
    if (isIgnored(lines, idx)) continue;
    record(
      file,
      idx + 1,
      lines[idx] ?? '',
      'runCommand-template-literal',
      'runCommand/runCommandAsync called with a template literal — use an argv array or runShellScript',
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip blank lines and pure comment lines quickly.
    if (!line || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;

    // Pattern 2: dangerous child_process identifier invoked as a function.
    for (const name of dangerousNames) {
      const re = new RegExp(`\\b${name}\\s*\\(`);
      if (re.test(line)) {
        if (!isIgnored(lines, i)) {
          record(
            file,
            i + 1,
            line,
            `child_process-${name}`,
            `${name}() routes through a shell — replace with runCommand(argv) or runShellScript`,
          );
        }
      }
    }

    // Pattern 3: execa({ shell: true }) — can span the start of a line.
    if (/\bexeca\s*\([^)]*shell\s*:\s*true/.test(line)) {
      if (!isIgnored(lines, i)) {
        record(
          file,
          i + 1,
          line,
          'execa-shell-true',
          'execa({shell:true}) defeats argv protections — pass argv or use runShellScript',
        );
      }
    }

    // Pattern 4: inline shell-string SSH with JS interpolation.
    if (/\bssh\s+-[A-Za-z][^\n]*"\$\{/.test(line)) {
      if (!isIgnored(lines, i)) {
        record(
          file,
          i + 1,
          line,
          'inline-ssh-shell-interp',
          'Inline SSH shell-string with "${...}" — use sshRun(ip,key,[argv]) or sshRunScript',
        );
      }
    }
  }

  // Pattern 5: ssh/scp argv lacking BatchMode=yes. Scan the whole source
  // (not per-line) so we can match argv definitions that span many lines.
  // Look for `'ssh'` or `'scp'` as a quoted argv-element token; the
  // preceding `(` or `,` confirms it's a function-call argv element rather
  // than a comment / a longer string like 'ssh-key'. Then check the
  // enclosing call body for `BatchMode=yes` and flag if absent.
  // Bare `exec()` calls are already caught by Pattern 2 (DANGEROUS_CP_NAMES).
  const SPAWNERS_RE = /\b(execFile(?:Sync)?|spawn(?:Sync)?|runCommand(?:Async)?)\s*\(/;
  const p5 = /(^|[(\[,]\s*|=\s*)['"](ssh|scp)['"]\s*,/gm;
  for (let pm; (pm = p5.exec(src)) !== null; ) {
    const matchStart = pm.index;
    const idx = offsetToLine(src, matchStart);
    if (isIgnored(lines, idx)) continue;

    // Walk back at most 200 chars to find an enclosing spawner call.
    // Skips standalone strings like `const SSH = 'ssh';` which aren't argv.
    const lookBackStart = Math.max(0, matchStart - 200);
    const preceding = src.slice(lookBackStart, matchStart);
    if (!SPAWNERS_RE.test(preceding)) continue;

    // Find the call's `(` and its matching `)` to get the body to check.
    const openIdx = preceding.lastIndexOf('(');
    if (openIdx === -1) continue;
    const callStart = lookBackStart + openIdx + 1;
    const callEnd = findMatchingClose(src, callStart);
    const callBody = src.slice(callStart, callEnd);

    if (/BatchMode\s*=\s*yes/.test(callBody)) continue;

    // Spread of a known-good opts bundle (roster at KNOWN_GOOD_SSH_OPTS_RE).
    if (KNOWN_GOOD_SSH_OPTS_RE.test(callBody)) {
      // Verify the bundle's own definition in the same file actually
      // includes BatchMode. Catches the "named-it-sshOpts-but-forgot"
      // footgun. Look for `const VARNAME = [...]` and check the
      // initializer text. If the definition is in another file, trust
      // the import (the lint runs across all files anyway, so a missing
      // BatchMode in the source-of-truth file would be flagged there).
      const spreadMatch = callBody.match(
        /\.\.\.\s*(SSH_OPTS|SSH_OPTIONS|sshOpts)\b/,
      );
      if (spreadMatch) {
        const varName = spreadMatch[1];
        const defRe = new RegExp(
          `\\b(?:const|let|var)\\s+${varName}\\s*=([\\s\\S]{0,800})`,
        );
        const defMatch = src.match(defRe);
        if (
          defMatch &&
          !/BatchMode\s*=\s*yes/.test(defMatch[1]) &&
          // A definition built from the shared host-keys.js builders inherits
          // BatchMode=yes from SSH_CONNECTION_OPTS there.
          !/\b(?:buildHostKeyOpts\w*|sshHostKeyOpts)\s*\(/.test(defMatch[1])
        ) {
          // Local definition exists and is missing BatchMode — flag at
          // the definition site, not the spread site.
          const defLine = offsetToLine(src, defMatch.index ?? 0);
          if (!isIgnored(lines, defLine)) {
            record(
              file,
              defLine + 1,
              lines[defLine] ?? '',
              'ssh-missing-batchmode',
              `${varName} is spread into an ssh/scp argv but its definition lacks 'BatchMode=yes' — add it so every ssh callsite using ${varName} is covered.`,
            );
          }
        }
      }
      continue;
    }

    record(
      file,
      idx + 1,
      lines[idx] ?? '',
      'ssh-missing-batchmode',
      "ssh/scp argv missing '-o BatchMode=yes' — without it a key-auth failure can hang on a password prompt (PR 1BT). Add BatchMode=yes to the argv, or use sshRun/scpUpload from src/lib/ssh.js (which bake it in).",
    );
  }

  // Pattern 5b: scpWithRetry() call sites (2026-08-11 scp-retry conversion).
  // lib/ssh.js#scpWithRetry now owns the `scp` executable token, so Pattern 5's
  // quoted-'scp' detector no longer sees these argv arrays — but the CALLER
  // still supplies the -o options, so the BatchMode requirement is unchanged.
  // Without this pass the conversion would have silently blinded Pattern 5 at
  // ten call sites. Same body check, different trigger.
  const p5b = /\bscpWithRetry\s*\(/g;
  for (let pm; (pm = p5b.exec(src)) !== null; ) {
    const idx = offsetToLine(src, pm.index);
    if (isIgnored(lines, idx)) continue;
    // Prose in a JSDoc block, and the helper's own declaration, are not
    // call sites.
    const lineText = (lines[idx] ?? '').trim();
    if (lineText.startsWith('*') || lineText.startsWith('//')) continue;
    if (/\b(?:function|const|let|var)\s+$/.test(src.slice(Math.max(0, pm.index - 20), pm.index))) {
      continue;
    }
    const callStart = pm.index + pm[0].length;
    const callBody = src.slice(callStart, findMatchingClose(src, callStart));
    if (/BatchMode\s*=\s*yes/.test(callBody)) continue;
    if (KNOWN_GOOD_SSH_OPTS_RE.test(callBody)) continue;
    record(
      file,
      idx + 1,
      lines[idx] ?? '',
      'ssh-missing-batchmode',
      "scpWithRetry() argv missing '-o BatchMode=yes' — the helper adds the retry ladder, not the SSH options. Spread buildHostKeyOpts(sshKeyPath) (or an sshOpts bundle built from it) into the argv.",
    );
  }
}

if (violations.length > 0) {
  console.error(`\nshell-safety: ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.patternId}]`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.snippet}`);
    console.error('');
  }
  console.error(
    'If a match is a reviewed exception, add `// shell-safety-ignore: <reason>`',
  );
  console.error('on the same line or the line immediately above.\n');
  process.exit(1);
}

console.log('shell-safety: OK');
