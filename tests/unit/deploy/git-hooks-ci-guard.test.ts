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

/**
 * Same class, second surface: npm lifecycle scripts.
 *
 * `prepublishOnly` ran the whole unit suite + lint, and `npm publish` fires it
 * — so semantic-release hit it too. Release run 32607476095 got past the git
 * hook (guarded above) and died here instead, on
 * tests/unit/e2e/staging-ca-trust.test.ts — three tests that were GREEN in
 * test.yml on the identical commit.
 *
 * WHY they failed there is NOT established. The obvious theory — that the test
 * reads ambient NODE_EXTRA_CA_CERTS and npm's lifecycle sets it — was tested
 * on 2026-08-23 and DISPROVED: the suite passes with that variable set. Some
 * other difference in npm's lifecycle context is responsible and nobody has
 * isolated it. Recorded as unknown rather than guessed, because it was guessed
 * confidently once already.
 *
 * The guard stands either way: the gate should not run there whatever the
 * cause, since test.yml already proved that commit green.
 *
 * Any lifecycle script that runs the suite must skip under CI, for the same
 * reason the hooks must: release.yml already refuses to publish unless
 * test.yml is green for that commit.
 */
describe('npm lifecycle gates', () => {
  const scripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'))
    .scripts as Record<string, string>;
  const GATE = /pnpm\s+(test:unit|test:integration|lint|test:prepush)/;
  const gated = Object.entries(scripts).filter(
    ([name, body]) =>
      /^(prepublishOnly|prepublish|prepack|prepare|preversion)$/.test(name) && GATE.test(body),
  );

  it('every suite-running lifecycle script is CI-guarded', () => {
    for (const [name, body] of gated) {
      expect(body, `${name} runs the suite without a CI guard`).toMatch(/-n\s+"?\$CI"?/);
    }
  });
});
