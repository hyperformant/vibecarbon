import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Census: the carbon/ docs must only tell a reader to run commands that exist,
 * and only link to files that ship with their project.
 *
 * carbon/ is a TEMPLATE. Everything under it is copied into the user's
 * generated project, so its docs are read in a checkout that contains carbon/'s
 * contents and nothing else from this repo. Two failure modes follow:
 *
 *   1. `npm run <script>` for a script that was renamed or removed — the
 *      reader gets "Missing script", with no way to guess the new name.
 *   2. A relative link that resolves ABOVE carbon/ (e.g. `../docs/...` reaching
 *      this repo's root docs/). It works for us and is a 404 for every user,
 *      which is exactly why it survives review here.
 *
 * Truth sources are carbon/package.json's scripts object and the filesystem —
 * never another doc.
 */

const ROOT = process.cwd();
const CARBON = join(ROOT, 'carbon');

/** Every markdown/MDX doc that ships inside the template. */
function templateDocs(): string[] {
  const out: string[] = [];
  const pushMd = (dir: string, ext: RegExp) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile() && ext.test(entry)) out.push(relative(ROOT, full));
    }
  };
  pushMd(CARBON, /\.md$/);
  const walkK8s = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkK8s(full);
      else if (entry.endsWith('.md')) out.push(relative(ROOT, full));
    }
  };
  walkK8s(join(CARBON, 'k8s'));
  pushMd(join(CARBON, 'content', 'docs'), /\.mdx$/);
  return out.sort();
}

const DOCS = templateDocs();
const SCRIPTS = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(join(CARBON, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
      }
    ).scripts,
  ),
);

describe('carbon template docs run real commands', () => {
  it('the doc walk and the scripts map both found real content', () => {
    // Both assertions below are filters over collected sets: an empty walk or
    // an empty script map would pass them while checking nothing.
    expect(DOCS.length).toBeGreaterThan(8);
    expect(SCRIPTS.size).toBeGreaterThan(20);
  });

  it('every `npm run <script>` in the template docs exists in carbon/package.json', () => {
    const offenders: string[] = [];
    let tokens = 0;
    for (const rel of DOCS) {
      const text = readFileSync(join(ROOT, rel), 'utf-8');
      for (const m of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        tokens++;
        if (!SCRIPTS.has(m[1])) offenders.push(`${rel}: \`npm run ${m[1]}\` is not a script`);
      }
    }
    // The assertion below is a filter over matches, so an inert regex would
    // pass it on an empty set. Mirrors the link-scan floor further down.
    expect(
      tokens,
      'the `npm run` scan matched nothing — the extraction regex has gone inert',
    ).toBeGreaterThan(20);
    expect(
      offenders,
      `${offenders.join('\n')}\nAdd the script to carbon/package.json or fix the doc — ` +
        'a generated project has only the scripts in that file.',
    ).toEqual([]);
  });
});

describe('carbon template docs link inside the template', () => {
  it('every relative markdown link resolves to a real path inside carbon/', () => {
    const offenders: string[] = [];
    for (const rel of DOCS) {
      const text = readFileSync(join(ROOT, rel), 'utf-8');
      // Relative targets only: http(s)/mailto are external, and `/docs/...`
      // style targets are app routes served by the template's own router,
      // not files on disk.
      for (const m of text.matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (!target) continue; // pure `#fragment` after a `./` prefix
        const abs = resolve(join(ROOT, dirname(rel)), target);
        if (abs !== CARBON && !abs.startsWith(CARBON + sep)) {
          offenders.push(
            `${rel}: \`${m[1]}\` escapes carbon/ (resolves to ${relative(ROOT, abs)}). ` +
              'That path does not exist in a generated project — link inside the template or drop the link.',
          );
        } else if (!existsSync(abs)) {
          offenders.push(`${rel}: \`${m[1]}\` does not exist (resolves to ${relative(ROOT, abs)})`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the link scan actually found links (guards against a regex that stopped matching)', () => {
    let links = 0;
    for (const rel of DOCS) {
      links += [...readFileSync(join(ROOT, rel), 'utf-8').matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)]
        .length;
    }
    expect(links).toBeGreaterThan(3);
  });
});
