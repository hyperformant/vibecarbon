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
  // The same slot in prose/shell form (`~/.vibecarbon/license`). The trailing
  // class is load-bearing: `~/.vibecarbon/license-checks/` is the LIVE
  // per-machine verdict cache (src/lib/licensing/check.js cachePathFor), so a
  // bare prefix match would condemn current code. The `~/` is optional so a
  // bare `.vibecarbon/license` is caught too.
  '\\.vibecarbon/license([^-[:alnum:]_]|$)',
  '-legacy',
  'mintV1Key',
  'mintV2Key',
  'storedProjectId',
];
/**
 * Everything the sweep has to hold across, including the two documents that
 * SHIP: `carbon/content` is the User Docs the npm tarball carries (`files:
 * [src, carbon, services]`), so a retired flow described there reaches every
 * customer, and `AGENTS.md` is what an agent reads before touching this repo.
 */
const SCOPE =
  'src scripts tests docs README.md TERMS.md AGENTS.md .github carbon/README.md carbon/content';

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
  [
    'tests/unit/licensing/storage.test.ts::\\.vibecarbon/license([^-[:alnum:]_]|$)',
    'the isolation test names the slot it refuses to read, in its title and prose',
  ],
  // The harness guard forbids run-cli.ts SOURCING a key; it names the retired
  // pre-minted variable because that is half of what it forbids.
  [
    'tests/unit/e2e/iter-step-env-parity.test.ts::VIBECARBON_TEST_LICENSE_KEY',
    'pins the integration harness never sourcing the retired pre-minted key',
  ],
  // parseArgs must turn a retired mint flag into a loud error rather than
  // ignoring it silently; the test names one.
  [
    'tests/unit/licensing/generate-license.test.ts::-legacy',
    'pins parseArgs rejecting a retired mint flag',
  ],
]);

/**
 * The HISTORICAL RECORD of this removal, which necessarily names what went:
 * this census itself, the CHANGELOG, and the workstream's own plan + design
 * spec. Editing any of them to satisfy the census would falsify the record.
 * The two superpowers documents are pinned by exact path rather than by
 * directory, so a NEW plan or spec that drifts back into the retired
 * vocabulary is still caught.
 */
const RECORD_FILES = new Set([
  'tests/unit/licensing/no-legacy-traces.test.ts',
  'docs/superpowers/specs/2026-09-15-license-bind-at-activate-design.md',
  'docs/superpowers/plans/2026-09-15-license-bind-at-activate-cli.md',
]);

/** `<file>::<pattern>` for every line the pattern matched outside the record. */
function hitsFor(pattern: string): string[] {
  // `grep` exits 1 on no match, which execFileSync turns into a throw.
  let out = '';
  try {
    out = execFileSync(
      'grep',
      ['-rnE', '--exclude-dir=node_modules', '--', pattern, ...SCOPE.split(' ')],
      { encoding: 'utf8' },
    );
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err;
  }
  return out.split('\n').filter((line) => {
    if (!line) return false;
    // Anchored to the FILENAME slice, like RECORD_FILES: a bare /CHANGELOG/
    // over the whole grep line also excused any hit whose matched TEXT
    // happened to mention a changelog, which is a hole, not an exemption.
    const file = line.slice(0, line.indexOf(':'));
    return !/CHANGELOG/.test(file) && !RECORD_FILES.has(file);
  });
}

/** The ALLOW key a hit line would be excused by, if any. */
const allowKey = (line: string, pattern: string) =>
  `${line.slice(0, line.indexOf(':'))}::${pattern}`;

describe('no traces of retired licence formats', () => {
  for (const pattern of PATTERNS) {
    it(`/${pattern}/ appears nowhere in ${SCOPE}`, () => {
      const hits = hitsFor(pattern).filter((line) => !ALLOW.has(allowKey(line, pattern)));
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }

  it('every exemption still covers a live guard', () => {
    // An ALLOW entry whose guard was deleted or renamed is a hole nothing
    // reports — it would quietly excuse a future leftover in that file. Runs
    // its own greps rather than reading what the cases above collected, so it
    // holds under `-t` filtering, `.only`, and any future reordering.
    const live = new Set(
      PATTERNS.flatMap((pattern) => hitsFor(pattern).map((line) => allowKey(line, pattern))),
    );
    const dead = [...ALLOW.keys()].filter((k) => !live.has(k));
    expect(
      dead,
      `these exemptions match nothing any more — delete them:\n${dead.join('\n')}`,
    ).toEqual([]);
  });
});
