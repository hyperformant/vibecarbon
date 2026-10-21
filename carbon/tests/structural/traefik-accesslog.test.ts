import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Traefik's access log RequestPath includes the query string, where reset,
 * magic-link and OAuth tokens travel. Every place that enables the access
 * log must drop that field (the app's own access log carries a redacted path).
 * Field customization only applies to the JSON format (the default `common`
 * line always prints the path and query), so an enablement must also pick JSON.
 */
const REPO = join(__dirname, '..', '..', '..');

describe('Traefik access log', () => {
  it('every enablement uses JSON format and drops RequestPath', () => {
    const hits = execFileSync(
      'git',
      ['grep', '-liE', '--untracked', '-e', 'access-?log', '--', 'carbon', 'src', ':!carbon/tests', ':!carbon/src/server', ':!carbon/node_modules'],
      { cwd: REPO, encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean);
    const offenders = hits.filter((f) => {
      const txt = readFileSync(join(REPO, f), 'utf-8');
      const enabled = /accesslog(=|:\s*)(true|\s*$)/im.test(txt) || /--accesslog(\s|$)/i.test(txt);
      const json = /accesslog\.format(=|:\s*)["']?json/i.test(txt) || /accessLog:[\s\S]*?format:\s*["']?json/i.test(txt);
      return enabled && (!/RequestPath\W+drop/i.test(txt) || !json);
    });
    expect(offenders).toEqual([]);
    expect(hits).toContain('carbon/k8s/base/traefik/deployment.yaml');
  });
});
