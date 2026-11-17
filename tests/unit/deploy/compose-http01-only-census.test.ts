import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../_shared/source-files.js';

const REPO = join(__dirname, '..', '..', '..');

function textFiles(dir: string): string[] {
  return sourceFiles(dir, {
    exts: ['.js', '.mjs', '.yaml', '.yml', '.sh', '.md', '.json'],
    skip: ['node_modules'],
  });
}

// Each banned token and the files allowed to carry it. The one exception is
// deliberate, not a leftover: scale.js lists the DNS-01 env keys it strips
// from an old server's .env.
//
// The override file has none. A server deployed before HTTP-01 may still hold
// a copy, and nothing reads it: every Compose call on a server runs
// vc-compose, which the bundle upload rewrites with the deploy's own `-f`
// list (server-compose-command-census.test.ts). The upload used to delete the
// copy all the same; that `rm` is gone because it protected nothing.
const BANNED: Array<[string, RegExp, string[]]> = [
  ['docker-compose.dns01.prod.yml', /docker-compose\.dns01\.prod\.yml/, []],
  ['useDnsChallenge', /useDnsChallenge/, []],
  ['dnsChallenge', /\bdnsChallenge\b/, []],
  ['ACME_DNS_PROVIDER', /ACME_DNS_PROVIDER/, ['src/scale.js']],
  ['dnschallenge', /dnschallenge/i, []],
];

describe('compose solves HTTP-01 only', () => {
  const files = [...textFiles(join(REPO, 'src')), ...textFiles(join(REPO, 'carbon'))];

  it('actually read the expected inputs, so the absence checks cannot pass on empty input', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('carbon/docker-compose.prod.yml'))).toBe(true);
  });

  it('no DNS-01 machinery survives in src/ or carbon/', () => {
    const hits: string[] = [];
    for (const file of files) {
      const rel = file.slice(REPO.length + 1);
      const text = readFileSync(file, 'utf8');
      for (const [label, re, allowed] of BANNED) {
        if (re.test(text) && !allowed.includes(rel)) hits.push(`${rel}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the pending-TLS fix hint points at HTTP-01 (A record, port 80), never at a DNS-01 solver', () => {
    const text = readFileSync(join(REPO, 'src/lib/deploy/effects/index.js'), 'utf8');
    const hint = text.match(/fixHint: `([^`]*)`/)?.[1] ?? '';
    expect(hint).toContain('HTTP-01');
    expect(hint).toContain('port 80');
    expect(text).not.toMatch(/DNS-01 solver/);
    expect(hint).not.toContain('\u2014');
  });
});
