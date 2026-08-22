/**
 * Git hooks must not run in CI.
 *
 * package.json's `prepare` sets `core.hooksPath=git-hooks`, so `pnpm install`
 * in any workflow arms them. semantic-release then makes a real `git commit`
 * for the version bump — and the pre-commit gate fires inside the release job,
 * against a tree semantic-release has just rewritten.
 *
 * Release run 32605420027 died exactly there: `pnpm lint` rejected the commit,
 * semantic-release aborted during `prepare`, and vibecarbon@0.39.16 never
 * published. Nothing was wrong with the commit — test.yml was green for it,
 * which is the condition release.yml already verifies before it will publish
 * at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOKS = join(process.cwd(), 'git-hooks');

describe('git hooks', () => {
  const hooks = readdirSync(HOOKS);

  it('there are hooks to guard (never vacuously green)', () => {
    expect(hooks.length).toBeGreaterThan(0);
  });

  it.each(hooks)('%s exits early when CI is set', (hook) => {
    const body = readFileSync(join(HOOKS, hook), 'utf-8');
    // The guard must precede any gate command, or the gate still runs.
    const guardAt = body.search(/if\s+\[\s+-n\s+"\$CI"\s+\]/);
    expect(guardAt, `${hook}: no CI guard`).toBeGreaterThan(-1);
    const firstGate = body.search(/^\s*pnpm\s+(lint|test)/m);
    if (firstGate > -1) {
      expect(guardAt, `${hook}: CI guard sits AFTER the first gate command`).toBeLessThan(
        firstGate,
      );
    }
    expect(body.slice(guardAt), `${hook}: guard does not exit`).toMatch(/exit 0/);
  });
});
