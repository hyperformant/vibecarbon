import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..');

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(js|mjs|ya?ml|sh|md|json)$/.test(name) ? [path] : [];
  });
}

// Each banned token and the files allowed to carry it. Both exceptions are
// deliberate, not leftovers: scale.js lists the DNS-01 env keys it strips from
// an old server's .env, and the compose upload removes a stale override file
// an older deploy left behind. dns-provider.js carries the DNS01_PROVIDERS
// table until Task 5 deletes it.
const BANNED: Array<[string, RegExp, string[]]> = [
  [
    'docker-compose.dns01.prod.yml',
    /docker-compose\.dns01\.prod\.yml/,
    ['src/lib/deploy/compose/index.js'],
  ],
  ['useDnsChallenge', /useDnsChallenge/, []],
  ['dnsChallenge', /\bdnsChallenge\b/, []],
  ['ACME_DNS_PROVIDER', /ACME_DNS_PROVIDER/, ['src/scale.js', 'src/lib/dns-provider.js']],
  ['dnschallenge', /dnschallenge/i, ['src/lib/dns-provider.js']],
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

  it('the stale override file is removed in the same remote step as the tar extract', () => {
    const text = readFileSync(join(REPO, 'src/lib/deploy/compose/index.js'), 'utf8');
    expect(text).toMatch(/tar [^"]*-xzf - -C \$4 && rm -f \$4\/docker-compose\.dns01\.prod\.yml/);
  });
});
