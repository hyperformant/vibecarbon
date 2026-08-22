import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciAvailable } from '../../../src/lib/ci-setup.js';

/**
 * Census: the project config file is read through `lib/config.js`, never by
 * hand-rolling its path.
 *
 * Written after `ciAvailable()` spent an unknown stretch of time reading
 * `join(cwd, 'vibecarbon.json')` — no leading dot. The file it looked for
 * never existed, so the function always returned `false`,
 * `resolveBuildMode()` could never return `'push'`, and the CI branch in
 * `deploy/prompts.js` was unreachable. Nothing failed: the push path silently
 * never ran, which is the worst shape a bug can take.
 *
 * A guard that only checked the spelling would miss the real lesson. The
 * defect class is a second implementation of "where does the config live",
 * so this bans the duplicate rather than policing its correctness.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** `lib/config.js` owns the path; `lib/project.js` owns the same file's manifest half. */
const CONFIG_OWNERS = [join('lib', 'config.js'), join('lib', 'project.js')];

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

/** A path build against the config filename, in either spelling. */
const HAND_ROLLED = /join\([^)]*['"]\.?vibecarbon\.json['"]\s*\)/;

describe('project config is read through one accessor', () => {
  it('no module outside the owners builds a path to the config file', () => {
    const offenders = jsFiles(SRC)
      .map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf-8') }))
      .filter(({ rel }) => !CONFIG_OWNERS.includes(rel))
      .filter(({ src }) =>
        src.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && HAND_ROLLED.test(line)),
      )
      .map(({ rel }) => rel);

    expect(
      offenders,
      'These build their own path to the project config instead of calling ' +
        `loadProjectConfig()/saveProjectConfig() from lib/config.js:\n  ${offenders.join('\n  ')}\n` +
        'A second implementation of "where the config lives" is how ciAvailable() ' +
        'came to read an undotted filename and silently return false forever.',
    ).toEqual([]);
  });

  it('the owners really do reference the dotted filename (guards the matcher)', () => {
    // If the regex or the filename ever changes shape, this fails rather than
    // letting the sweep above pass over an empty search.
    const owned = CONFIG_OWNERS.map((rel) => readFileSync(join(SRC, rel), 'utf-8'));
    for (const src of owned) {
      expect(src).toMatch(HAND_ROLLED);
      expect(src).toContain('.vibecarbon.json');
    }
  });

  it('ciAvailable reads the file that is actually written', () => {
    // The regression itself, pinned behaviorally rather than by spelling.
    // An undotted read returns false here no matter what the config says.
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'vc-cfg-'));

    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'demo', cicdEnabled: true }),
    );
    expect(ciAvailable(dir)).toBe(true);

    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ projectName: 'demo' }));
    expect(ciAvailable(dir)).toBe(false);
  });
});
