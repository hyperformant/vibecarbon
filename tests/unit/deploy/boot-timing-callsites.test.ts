/**
 * Every deploy mode's node ready wait is followed by the same first-boot
 * timing collection (src/lib/deploy/boot-timing.js), started without being
 * awaited so it never sits on the critical path, and only on the branch that
 * actually waited (a warm redeploy that skips the wait collects nothing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Source text containing template placeholders, written as `#{...}`. */
const tpl = (s: string) => s.replaceAll('#{', '$' + '{');

const src = (p: string) => readFileSync(join(__dirname, '../../../src', p), 'utf-8');

/** The source between two anchors, both required to exist. */
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `anchor ${from}`).toBeGreaterThan(-1);
  const b = text.indexOf(to, a);
  expect(b, `anchor ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

describe('first-boot timing call sites', () => {
  it('nothing awaits the collection', () => {
    for (const file of [
      'lib/deploy/k8s/k3s.js',
      'lib/deploy/effects/index.js',
      'lib/deploy/effects/compose-ha.js',
    ]) {
      const text = src(file);
      expect(text, file).toContain('void startBootTiming(');
      expect(text, file).not.toMatch(/await\s+startBootTiming\(/);
    }
  });

  it('k3s: master, db and every static worker, after the ready wait and the host-key seed', () => {
    const text = src('lib/deploy/k8s/k3s.js');
    const wait = text.indexOf(tpl('deploy.#{perfPrefix}.waitForReady'));
    const seed = text.indexOf('await seedKnownHosts(khPath, seedIp)', wait);
    const call = text.indexOf('void startBootTiming(', wait);
    expect(wait).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(wait);
    expect(call).toBeGreaterThan(seed);
    const site = text.slice(call, text.indexOf(');', call));
    expect(site).toContain(tpl('`#{perfPrefix}.master`'));
    expect(site).toContain(tpl('`#{perfPrefix}.db`'));
    expect(site).toContain(tpl('`#{perfPrefix}.worker#{i + 1}`'));
    // Only when this run waited for the master, i.e. a fresh (re)provision.
    const block = between(
      text,
      "if (!state.shouldSkip('k3s-ready'",
      "state.completeStep('k3s-ready')",
    );
    expect(block).toContain('bootTimingDue = true');
  });

  it('compose: the server, inside the state-gated cloud-init wait', () => {
    const text = src('lib/deploy/effects/index.js');
    const block = between(
      text,
      "if (!state.shouldSkip('compose-setup-server'",
      "state.completeStep('compose-setup-server'",
    );
    const wait = block.indexOf("'deploy.compose.cloudInitReady'");
    const call = block.indexOf('void startBootTiming(');
    expect(wait).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(wait);
    expect(block.slice(call)).toContain("prefix: 'compose'");
  });

  it('compose-ha: both servers, after the paired cloud-init wait', () => {
    const text = src('lib/deploy/effects/compose-ha.js');
    const fn = between(text, 'async function haSetupServers(', '\n}\n');
    const wait = fn.indexOf("'deploy.ha.compose.cloudInitReady.both'");
    const call = fn.indexOf('void startBootTiming(');
    expect(wait).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(wait);
    expect(fn.slice(call)).toContain("prefix: 'ha.compose.primary'");
    expect(fn.slice(call)).toContain("prefix: 'ha.compose.standby'");
  });
});
