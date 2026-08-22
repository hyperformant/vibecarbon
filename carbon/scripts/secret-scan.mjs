#!/usr/bin/env node
// Self-contained secret scanner for the vibecarbon-managed pre-commit
// hook. Mirrors the rules in src/lib/secret-scan.js (vibecarbon CLI)
// so the same allowlist + behaviour applies offline / without the CLI
// installed. Keep the rule set in sync — the test suite over there is
// the source of truth.
//
// Usage:
//   node scripts/secret-scan.mjs <file> [<file>...]
//   node scripts/secret-scan.mjs --stdin   # reads file paths from stdin, one per line

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_RULES = [
  { id: 'aws-access-key', description: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    id: 'aws-secret-key',
    description: 'AWS secret access key',
    pattern:
      /(?:aws[_-]?secret[_-]?access[_-]?key|secretAccessKey)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  {
    id: 'github-pat',
    description: 'GitHub personal access token',
    pattern: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret key',
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
  },
  {
    id: 'stripe-test-key',
    description: 'Stripe test secret key',
    pattern: /\bsk_test_[A-Za-z0-9]{24,}\b/g,
  },
  { id: 'slack-token', description: 'Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { id: 'openai-key', description: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g,
  },
  {
    id: 'google-service-account-json',
    description: 'Google Cloud service account JSON',
    pattern: /"type"\s*:\s*"service_account"/g,
    context: /"private_key"\s*:\s*"-----BEGIN[ A-Z]+PRIVATE KEY-----/,
  },
  { id: 'google-api-key', description: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: 'private-key-block',
    description: 'PEM-encoded private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'hetzner-token',
    description: 'Hetzner Cloud API token',
    pattern: /['"]([A-Za-z0-9]{64})['"]/g,
    context: /(?:hetzner|hcloud|HCLOUD_TOKEN|HETZNER_API_TOKEN)/i,
  },
  {
    id: 'cloudflare-api-token',
    description: 'Cloudflare scoped API token',
    pattern: /\b[A-Za-z0-9_-]{40}\b/g,
    context: /(?:cloudflare|cf[_-]?api[_-]?token|CLOUDFLARE_API_TOKEN)/i,
    predicate: (m) => !/^[a-f0-9]+$/i.test(m),
  },
  {
    id: 'supabase-service-role-jwt',
    description: 'Supabase service-role JWT',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    predicate: (m) => {
      const parts = m.split('.');
      if (parts.length !== 3) return false;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      try {
        const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
        return payload?.role === 'service_role' || payload?.role === 'admin';
      } catch {
        return false;
      }
    },
  },
  {
    id: 'generic-secret-assignment',
    description: 'High-entropy value assigned to a secret-named variable',
    pattern:
      /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)\s*[:=]\s*['"]([^'"\s]{20,})['"]/gi,
    predicate: (_m, captured) => {
      const value = captured?.[1];
      if (!value) return false;
      if (/^(?:REPLACE|TODO|CHANGE|YOUR|EXAMPLE|PLACEHOLDER|FIXME)/i.test(value)) return false;
      if (/^(?:local|dev|test|sample|fake|demo)[-_]/i.test(value)) return false;
      const freq = new Map();
      for (const c of value) freq.set(c, (freq.get(c) ?? 0) + 1);
      let h = 0;
      for (const n of freq.values()) {
        const p = n / value.length;
        h -= p * Math.log2(p);
      }
      return h >= 3.5;
    },
  },
];

const SKIP_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.so',
  '.dll',
  '.dylib',
  '.bin',
  '.wasm',
]);
const MAX_FILE_BYTES = 1_048_576;

function loadAllowlist() {
  try {
    return readFileSync(join(process.cwd(), '.vibecarbonignore'), 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function matchesAllowlist(value, allowlist) {
  for (const entry of allowlist) {
    if (entry.startsWith('regex:')) {
      try {
        if (new RegExp(entry.slice(6)).test(value)) return true;
      } catch {}
    } else if (value.includes(entry)) {
      return true;
    }
  }
  return false;
}

function locate(content, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function scanContent(content, allowlist) {
  if (!content) return [];
  const findings = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    let m = rule.pattern.exec(content);
    while (m !== null) {
      const [whole] = m;
      if (rule.context) {
        const start = Math.max(0, m.index - 128);
        const end = Math.min(content.length, m.index + whole.length + 128);
        if (!rule.context.test(content.slice(start, end))) {
          m = rule.pattern.exec(content);
          continue;
        }
      }
      if (rule.predicate && !rule.predicate(whole, m)) {
        m = rule.pattern.exec(content);
        continue;
      }
      if (matchesAllowlist(whole, allowlist)) {
        m = rule.pattern.exec(content);
        continue;
      }
      const { line, column } = locate(content, m.index);
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        match: whole.length > 64 ? `${whole.slice(0, 32)}…${whole.slice(-16)}` : whole,
        line,
        column,
      });
      m = rule.pattern.exec(content);
    }
  }
  return findings;
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
    const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')).toLowerCase() : '';
    if (SKIP_EXTS.has(ext)) continue;
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
    const findings = scanContent(content, allowlist);
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
