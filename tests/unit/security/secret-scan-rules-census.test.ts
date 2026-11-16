/**
 * One secret-scan rule set, two copies that cannot drift.
 *
 * The CLI's deploy gate (src/lib/secret-scan.js) and the pre-commit scanner
 * every generated project carries (carbon/scripts/secret-scan.mjs) must agree
 * on what a secret is. A generated project cannot import the CLI, so the rule
 * module exists twice, byte for byte (the src/lib/dotenv.js arrangement).
 *
 * History: the template scanner used to carry a hand-mirrored rule list. It
 * drifted, and by 2026-11-16 it lacked the DigitalOcean, Linode, Vultr and
 * Scaleway rules, so a project's hook passed four of five providers' tokens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_RULES as CLI_RULES } from '../../../src/lib/secret-scan.js';
import { SECRET_RULES } from '../../../src/lib/secret-scan-rules.js';
import { getFilePolicy } from '../../../src/lib/upgrade-policy.js';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (f: string) => readFileSync(join(root, f), 'utf-8');

const CLI_MODULE = 'src/lib/secret-scan-rules.js';
const TEMPLATE_MODULE = 'carbon/scripts/lib/secret-scan-rules.js';
const CONSUMERS = [
  { file: 'src/lib/secret-scan.js', specifier: './secret-scan-rules.js' },
  { file: 'carbon/scripts/secret-scan.mjs', specifier: './lib/secret-scan-rules.js' },
];

/** Strip comments so prose that mentions a rule id or `pattern:` does not count. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the secret-scan rule module', () => {
  it('is byte-identical in the CLI and in the template', () => {
    expect(read(TEMPLATE_MODULE)).toBe(read(CLI_MODULE));
  });

  it('imports nothing, so a generated project can run it without the CLI', () => {
    expect(code(read(CLI_MODULE))).not.toMatch(/\bimport\b|\brequire\(/);
  });

  it('holds every rule, each provider included', () => {
    const ids = SECRET_RULES.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'hetzner-token',
        'digitalocean-token',
        'linode-token',
        'vultr-token',
        'scaleway-access-key',
        'scaleway-secret-key',
      ]),
    );
  });

  it('is the very array the CLI scanner exports', () => {
    expect(CLI_RULES).toBe(SECRET_RULES);
  });

  it('reaches existing projects through upgrade together with the scanner', () => {
    expect(getFilePolicy('scripts/lib/secret-scan-rules.js')).toBe('safe');
    expect(getFilePolicy('scripts/secret-scan.mjs')).toBe('safe');
  });
});

describe('both scanners take their rules from the module', () => {
  for (const { file, specifier } of CONSUMERS) {
    it(`${file} imports ${specifier} and defines no rule, pattern or allowlist match of its own`, () => {
      const src = code(read(file));
      const imported = new RegExp(
        `import\\s*\\{[^}]*\\bscanContent\\b[^}]*\\}\\s*from\\s*'${specifier.replaceAll('.', '\\.')}'`,
      );
      expect(src).toMatch(imported);
      // A rule object, wherever it is written, has these three keys.
      expect(src).not.toMatch(/\bid:\s*['"`]/);
      expect(src).not.toMatch(/\bpattern:\s*\//);
      expect(src).not.toMatch(/\bpredicate:/);
      // The scan loop and the allowlist matcher live in the module too.
      expect(src).not.toMatch(/\.pattern\.exec\(/);
      expect(src).not.toMatch(/startsWith\(['"]regex:['"]\)/);
      // So do the lists of what is never opened.
      expect(src).not.toMatch(/['"]\.woff2['"]/);
    });
  }
});
