import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Clean sweep: no code, test, workflow, or doc may describe the retired v1
 * lifetime key, the v2 project-bound key, the legacy storage slot, or the
 * pre-minted test key. A hit is a leftover, not a false positive.
 *
 * Patterns are EXTENDED REGEXES, not fixed strings, because one of them has
 * to tell a licence key from an unrelated product identifier — see `vc2-`.
 */
const PATTERNS = [
  // The retired v2 key was `vc2-<8 hex>-<32 hex>-<sig>`. Narrowed from a bare
  // `vc2-` because Vultr's plan ids are also `vc2-…` (`vc2-2c-4gb`), all over
  // src/lib/providers/vultr.js and the scenario tables — nothing to do with
  // licensing. Requiring 8 hex digits after the prefix separates them: no
  // Vultr plan id has them, every v2 key did.
  'vc2-[0-9a-f]{8}',
  'vc-f-', // the retired v1 lifetime key
  'lifetime key',
  'lifetime license',
  'lifetime Fullerene',
  'isLifetime',
  'legacy license',
  'legacy key',
  'legacy slot',
  'legacyLicensePath',
  'listStoredLicenses',
  'VIBECARBON_TEST_LICENSE_KEY',
  "'\\.vibecarbon', 'license'", // join(home, '.vibecarbon', 'license'): the old global slot
  '-legacy',
  'mintV1Key',
  'mintV2Key',
  'storedProjectId',
];
const SCOPE = 'src scripts tests docs README.md TERMS.md .github carbon/README.md';

/**
 * The only places allowed to NAME a retired thing: guards whose entire job is
 * to prove it stays dead, and which cannot do that job without spelling it.
 * Keyed `<file>::<pattern>` so an exemption covers one guard, not a whole
 * file — a new leftover in any of these files still fails.
 */
const ALLOW = new Map([
  // "rejects the retired formats by name" — the test that pins parseLicenseKey
  // refusing both retired shapes has to write them out.
  ['tests/unit/licensing/validator.test.ts::vc-f-', 'pins parseLicenseKey rejecting the v1 shape'],
  [
    'tests/unit/licensing/validator.test.ts::vc2-[0-9a-f]{8}',
    'pins parseLicenseKey rejecting the v2 shape',
  ],
  // The HOME-isolation test plants a decoy at the retired global slot and
  // proves getLicense ignores it; the decoy has to sit at that exact path.
  [
    "tests/unit/licensing/storage.test.ts::'\\.vibecarbon', 'license'",
    'plants the decoy the isolation test refuses to read',
  ],
  ['tests/unit/licensing/storage.test.ts::legacy slot', 'prose of that same isolation test'],
  // parseArgs must turn a retired mint flag into a loud error rather than
  // ignoring it silently; the test names one.
  [
    'tests/unit/licensing/generate-license.test.ts::-legacy',
    'pins parseArgs rejecting a retired mint flag',
  ],
]);

/** Every ALLOW key that actually matched something, filled in by the run below. */
const allowUsed = new Set<string>();

describe('no traces of retired licence formats', () => {
  for (const pattern of PATTERNS) {
    it(`/${pattern}/ appears nowhere in ${SCOPE}`, () => {
      // `grep` exits 1 on no match, which execFileSync turns into a throw.
      let out = '';
      try {
        out = execFileSync(
          'grep',
          ['-rnE', '--exclude-dir=node_modules', '--', pattern, ...SCOPE.split(' ')],
          { encoding: 'utf8' },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        if (e.status !== 1) throw err;
      }
      const hits = out.split('\n').filter((line) => {
        if (!line) return false;
        const file = line.slice(0, line.indexOf(':'));
        if (file === 'tests/unit/licensing/no-legacy-traces.test.ts') return false;
        // CHANGELOG and the workstream's own plan + design spec under
        // docs/superpowers/ are the HISTORICAL RECORD of this removal: they
        // exist to say what the retired formats were and that they went.
        // Editing them to satisfy a census would falsify the record.
        if (/CHANGELOG/.test(line)) return false;
        if (file.startsWith('docs/superpowers/')) return false;
        const key = `${file}::${pattern}`;
        if (ALLOW.has(key)) {
          allowUsed.add(key);
          return false;
        }
        return true;
      });
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }

  it('every exemption still covers a live guard', () => {
    // An ALLOW entry whose guard was deleted or renamed is a hole nothing
    // reports — it would quietly excuse a future leftover in that file.
    const dead = [...ALLOW.keys()].filter((k) => !allowUsed.has(k));
    expect(
      dead,
      `these exemptions match nothing any more — delete them:\n${dead.join('\n')}`,
    ).toEqual([]);
  });
});
