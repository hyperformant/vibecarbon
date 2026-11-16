#!/usr/bin/env node
// Secret scanner for the vibecarbon-managed pre-commit hook. Runs offline,
// without the vibecarbon CLI installed.
//
// What counts as a secret (the rules, the allowlist match, the files never
// opened) lives in scripts/lib/secret-scan-rules.js, the same file the CLI's
// deploy gate runs. Do not add a rule here: this file only reads the staged
// files and reports.
//
// Usage:
//   node scripts/secret-scan.mjs <file> [<file>...]
//   node scripts/secret-scan.mjs --stdin   # reads file paths from stdin, one per line

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_FILE_BYTES,
  parseAllowlist,
  scanContent,
  skipsPath,
} from './lib/secret-scan-rules.js';

function loadAllowlist() {
  try {
    return parseAllowlist(readFileSync(join(process.cwd(), '.vibecarbonignore'), 'utf-8'));
  } catch {
    return [];
  }
}

async function readStdinList() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

async function main() {
  const argv = process.argv.slice(2);
  let files = [];
  if (argv.includes('--stdin')) {
    files = await readStdinList();
  } else {
    files = argv;
  }
  if (files.length === 0) process.exit(0);

  const allowlist = loadAllowlist();
  const failures = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    if (skipsPath(file)) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const findings = scanContent(content, { allowlist });
    for (const f of findings) failures.push({ file, ...f });
  }

  if (failures.length === 0) process.exit(0);
  process.stderr.write(
    `\n[X] Refusing commit: ${failures.length} potential secret${failures.length === 1 ? '' : 's'} detected:\n\n`,
  );
  for (const f of failures) {
    process.stderr.write(`  ${f.file}:${f.line}:${f.column}  [${f.ruleId}] ${f.description}\n`);
    process.stderr.write(`    -> ${f.match}\n`);
  }
  process.stderr.write(
    '\nIf a finding is a false positive, add it to .vibecarbonignore at the repo root:\n',
  );
  process.stderr.write('  - one entry per line\n');
  process.stderr.write('  - literal substring match, OR `regex:<pattern>` for a regex\n');
  process.stderr.write('  - `#` comments are ignored\n\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`secret-scan: ${err.message}\n`);
  process.exit(2);
});
