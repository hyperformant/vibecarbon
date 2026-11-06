/**
 * Every ForwardAuth middleware says what it does with X-Forwarded headers.
 *
 * Why. Traefik v3.7 treats `trustForwardHeader` as three states. Left unset it
 * keeps a legacy path that removes some X-Forwarded headers from the auth
 * request and passes others through as the client sent them, and it logs a
 * warning at every start (pkg/middlewares/auth/forward.go). ForwardAuth is the
 * gate on the admin tools, so its headers are never left to that path.
 *
 * How. A census over the template's dynamic config and k8s manifests: each
 * `forwardAuth:` block must set `trustForwardHeader` itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../../..');

/** The forwardAuth blocks of a YAML file that do not set trustForwardHeader. */
function forwardAuthWithoutTrust(path: string, text: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  lines.forEach((line, i) => {
    const open = line.match(/^(\s*)forwardAuth:\s*$/);
    if (!open) return;
    const block: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === '' || next.trim().startsWith('#')) continue;
      if ((next.match(/^\s*/)?.[0].length ?? 0) <= open[1].length) break;
      block.push(next);
    }
    if (!block.some((l) => /^\s*trustForwardHeader:\s*(true|false)\s*$/.test(l))) {
      found.push(`${path}:${i + 1}`);
    }
  });
  return found;
}

describe('every ForwardAuth middleware sets trustForwardHeader', () => {
  const paths = execFileSync(
    'git',
    ['ls-files', '--', 'carbon/k8s/*.yaml', 'carbon/volumes/traefik/*.yml'],
    { cwd: REPO, encoding: 'utf-8' },
  )
    .split('\n')
    .filter(Boolean);

  it('finds the template’s ForwardAuth blocks', () => {
    const withBlocks = paths.filter((p) =>
      /forwardAuth:/.test(readFileSync(join(REPO, p), 'utf-8')),
    );
    expect(withBlocks).toContain('carbon/k8s/base/traefik/middleware.yaml');
    expect(withBlocks).toContain('carbon/volumes/traefik/middlewares.yml');
  });

  it('none is left to the legacy path', () => {
    const missing = paths.flatMap((p) =>
      forwardAuthWithoutTrust(p, readFileSync(join(REPO, p), 'utf-8')),
    );
    expect(missing).toEqual([]);
  });

  it('bites: a block without the option is reported, a sibling block is not read into it', () => {
    const text = [
      'a:',
      '  forwardAuth:',
      '    address: http://app',
      'b:',
      '  forwardAuth:',
      '    address: http://app',
      '    trustForwardHeader: false',
    ].join('\n');
    expect(forwardAuthWithoutTrust('probe.yml', text)).toEqual(['probe.yml:2']);
  });
});
