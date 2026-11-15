/**
 * Failure-bundle sections keep their NEWEST lines, and a section's own line
 * budget decides how much survives, not a character cap.
 *
 * GitHub run 43757126064 (linode/k8s-ha verify-failover): the bundle's
 * "traefik and app logs (last 60 lines each)" section asked four pods for 60
 * lines each, then safeRun kept only the first 4,000 characters of the
 * result: the four OLDEST lines of the first pod. The access-log lines that
 * would have shown the retired cluster answering 404 were all cut. The same
 * head cut hit every line-bounded section (the 400-line postgres log, the
 * 100-event tail), and host-diagnostics.ts already kept tails the right way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capTail, DIAGNOSTIC_SECTION_MAX_CHARS } from '../../e2e/utils/diagnostic-cap.js';

const E2E_DIR = fileURLToPath(new URL('../../e2e/', import.meta.url));
const LIFECYCLE = join(E2E_DIR, 'scenarios/_run-lifecycle.ts');

/** One Traefik access-log line, about the width the real ones run. */
function accessLine(pod: string, i: number): string {
  return (
    `2026-11-15T21:51:${String(i).padStart(2, '0')}.000000000Z ${pod} 10.42.0.1 - - ` +
    `[15/Nov/2026:21:51:${String(i).padStart(2, '0')} +0000] "POST /api/v1/files/presign HTTP/2.0" 404 19 ` +
    `"-" "-" ${i} "-" "-" 0ms`
  );
}

describe('capTail', () => {
  it('returns text under the cap unchanged', () => {
    expect(capTail('a\nb\nc', 100)).toBe('a\nb\nc');
  });

  it('keeps the newest lines, from a line boundary, and says it cut', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const capped = capTail(text, 60);
    expect(capped).toMatch(/^\(truncated to the last 60 chars, from a line boundary\)\n/);
    const kept = capped.split('\n').slice(1);
    expect(kept.at(-1)).toBe('line 99');
    expect(kept[0]).toMatch(/^line \d+$/); // no partial first line
    expect(capped).not.toContain('line 0\n');
  });
});

describe('the failure bundle keeps a line-bounded section whole', () => {
  it('fits four pods x 60 access-log lines under the default section cap', () => {
    const pods = ['traefik-a', 'traefik-b', 'app-a', 'app-b'];
    const section = pods
      .map((p) => [`=== ${p} ===`, ...Array.from({ length: 60 }, (_, i) => accessLine(p, i))])
      .flat()
      .join('\n');
    expect(capTail(section, DIAGNOSTIC_SECTION_MAX_CHARS)).toBe(section);
  });

  it('safeRun caps through capTail, with the shared default', () => {
    const src = readFileSync(LIFECYCLE, 'utf-8');
    const at = src.indexOf('const safeRun = (');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n  };\n', at));
    expect(body).toMatch(/maxChars = DIAGNOSTIC_SECTION_MAX_CHARS/);
    expect(body.match(/capTail\(/g)?.length).toBe(2); // success and failure paths
  });
});

describe('census: no e2e diagnostic capture cuts its newest lines', () => {
  /** Every .ts under tests/e2e, recursively. */
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }

  it('finds no head cut to a character budget (`.slice(0, maxChars)`)', () => {
    const offenders = walk(E2E_DIR).flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(E2E_DIR, file)}:${i + 1}` }))
        .filter(({ line }) => /\.slice\(\s*0\s*,\s*maxChars\s*\)/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
