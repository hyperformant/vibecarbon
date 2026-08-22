import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Structural invariant: every reference to a documentation surface in client
// source must sit in a file that also gates on that surface's visibility
// setting.
//
// Two super-admin toggles remove the user docs site and the API docs surface.
// The failure this guards is not a broken link — it is a link that survives
// the toggle, sending a visitor to a page the operator turned off. That class
// of bug is invisible in review: someone adds a "see the docs" CTA to a new
// marketing section months from now and nothing complains.
//
// The rule: a file containing a /docs or /api/docs reference must also import
// the visibility hook or the href helpers. Files that legitimately hold such a
// reference without gating it are listed in ALLOWED_UNGATED with a reason.
//
// This is a coarse check by design. It cannot prove a given link is correctly
// gated — only that the file has the means to gate and that a new file with a
// docs link fails until someone makes that decision deliberately.

const CLIENT_ROOT = join(import.meta.dirname, '../../src/client');

/** Matches '/docs', '/docs/anything', and '/api/docs' inside quotes or JSX props. */
const DOCS_REFERENCE = /["'`](?:\/api)?\/docs(?:\/[\w-]*)?["'`]/;

/** Any of these in a file means it can make a visibility decision. */
const GATING_IMPORTS = [
  'useDocsVisibility',
  'isDocsHrefVisible',
  'isUserDocsHref',
  'isApiDocsHref',
  'requiresUserDocs',
];

/**
 * Files holding a docs reference that is deliberately not gated, each with the
 * reason it is exempt. Adding an entry here should be a considered act — if
 * the reference is a link a visitor can follow, it belongs behind a gate
 * instead of on this list.
 */
const ALLOWED_UNGATED: Record<string, string> = {
  'lib/docs-links.ts': 'Defines the gating rule itself — the paths are its subject matter.',
  'pages/Docs.tsx': 'The user docs page itself — its internal links are gated by its route.',
  'lib/setup-progress.ts':
    'Declares integration CTA URLs as data. The gate lives in the component that renders them ' +
    '(components/admin/SetupProgress.tsx), which filters through isDocsHrefVisible.',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const offenders = walk(CLIENT_ROOT)
  .map((file) => ({ file, rel: relative(CLIENT_ROOT, file), src: readFileSync(file, 'utf8') }))
  .filter(({ src }) => DOCS_REFERENCE.test(src))
  .filter(({ rel }) => !(rel in ALLOWED_UNGATED))
  .filter(({ src }) => !GATING_IMPORTS.some((token) => src.includes(token)))
  .map(({ rel }) => rel);

describe('docs link gating', () => {
  it('every client file referencing /docs or /api/docs can gate on visibility', () => {
    expect(
      offenders,
      `These files link to a documentation surface without gating on its visibility ` +
        `setting, so the link survives the super-admin toggle:\n` +
        `  ${offenders.join('\n  ')}\n` +
        `Gate with useDocsVisibility()/isDocsHrefVisible(), or add an entry to ` +
        `ALLOWED_UNGATED in this test explaining why the reference is exempt.`
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    // A file that stopped referencing docs should drop off the allowlist,
    // otherwise the list slowly becomes permission to add ungated links.
    const stale = Object.keys(ALLOWED_UNGATED).filter((rel) => {
      const full = join(CLIENT_ROOT, rel);
      try {
        return !DOCS_REFERENCE.test(readFileSync(full, 'utf8'));
      } catch {
        return true; // file moved or deleted
      }
    });
    expect(stale, `stale ALLOWED_UNGATED entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('detects a docs reference in each form it appears in source', () => {
    // Pins the matcher itself — a regex that silently stopped matching would
    // make the sweep above vacuously pass.
    for (const sample of [
      `<Link to="/docs">`,
      `href="/docs/getting-started"`,
      `to='/api/docs'`,
      `url: '/docs/email',`,
      "ctaHref: '/docs/getting-started',",
    ]) {
      expect(DOCS_REFERENCE.test(sample), `should match: ${sample}`).toBe(true);
    }

    for (const sample of ['/documentation', 'https://example.com/docs', 'docsUrl']) {
      expect(DOCS_REFERENCE.test(sample), `should not match: ${sample}`).toBe(false);
    }
  });
});
