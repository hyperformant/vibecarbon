import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Census: every write to .vibecarbon.json is one locked read-modify-write
 * through updateProjectConfig (backup/restore integrity M6).
 *
 * The old shape, `loadProjectConfig()` early, mutate, `saveProjectConfig(all)`
 * late, wrote the WHOLE file from a copy that could be minutes stale: a
 * failover journal, a write-fence marker or a scale's cutover journal saved by
 * another step (or another terminal) in between was silently dropped. The walk
 * covers every module under src/, so a writer added later is caught too.
 */

const SRC = join(process.cwd(), 'src');
const CONFIG = join('lib', 'config.js');

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

const sources = jsFiles(SRC).map((file) => ({
  rel: relative(SRC, file),
  lines: readFileSync(file, 'utf-8').split('\n'),
}));

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

function offenders(pattern: RegExp, { exempt = [] as string[] } = {}) {
  return sources
    .filter(({ rel }) => !exempt.includes(rel))
    .flatMap(({ rel, lines }) =>
      lines.flatMap((line, i) =>
        !isComment(line) && pattern.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : [],
      ),
    );
}

describe('.vibecarbon.json has one writer', () => {
  it('no module outside lib/config.js calls or imports saveProjectConfig', () => {
    expect(
      offenders(/\bsaveProjectConfig\b/, { exempt: [CONFIG] }),
      'Use updateProjectConfig((config) => { ...patch... }): it reloads the file under ' +
        'the lock, so a field another step saved meanwhile is kept, not overwritten.',
    ).toEqual([]);
  });

  it('lib/config.js keeps saveProjectConfig internal', () => {
    const config = sources.find(({ rel }) => rel === CONFIG);
    expect(config).toBeDefined();
    expect(config?.lines.filter((l) => /export\s+function\s+saveProjectConfig\b/.test(l))).toEqual(
      [],
    );
  });

  it('the manifest half writes through updateProjectConfig too (no saveManifest)', () => {
    expect(offenders(/\bsaveManifest\b/)).toEqual([]);
  });

  it('no module but lib/config.js writes or renames onto the config file', () => {
    // project.js owns the manifest half of the same file; it must read it
    // only (its other writes are .env.local, which goes through formatDotenvLine).
    expect(offenders(/\b(writeFileSync|renameSync)\(\s*manifestPath\b/)).toEqual([]);
    expect(
      offenders(/\b(writeFileSync|renameSync)\([^)]*\.vibecarbon\.json/, { exempt: [CONFIG] }),
    ).toEqual([]);
  });

  it('every mutator takes the freshly loaded config (no zero-argument mutator)', () => {
    // `updateProjectConfig(() => staleWholeObject)` would bring the clobber back.
    expect(offenders(/updateProjectConfig\(\s*\(\s*\)\s*=>/)).toEqual([]);
  });

  it('the matcher sees the writer it guards (guards the walk)', () => {
    expect(offenders(/\bupdateProjectConfig\(/).length).toBeGreaterThan(20);
  });
});
