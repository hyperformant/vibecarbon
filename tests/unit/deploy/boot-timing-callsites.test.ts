/**
 * Every node ready wait (deploy in each mode, and scale's replacement server)
 * queues the same first-boot timing collection (src/lib/deploy/boot-timing.js)
 * on the branch that actually waited, and cli.js reads the queue only after
 * the command's own total is recorded, so the collection never competes with
 * the work it measures and never counts toward `cli.<command>.total`.
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
  it('ready waits only queue: nothing collects inline', () => {
    for (const file of [
      'lib/deploy/k8s/k3s.js',
      'lib/deploy/effects/index.js',
      'lib/deploy/effects/compose-ha.js',
      'scale.js',
    ]) {
      const text = src(file);
      expect(text, file).toContain('queueBootTiming(');
      expect(text, file).not.toMatch(/collectBootTiming|flushBootTiming/);
    }
  });

  it('cli.js reads the queue after the command total, in the finally', () => {
    const text = src('cli.js');
    const fin = between(text, '  } finally {', '\n}\n');
    const total = fin.indexOf('commandTimer.end();');
    const flush = fin.indexOf('await flushBootTiming()');
    expect(total).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(total);
    // Off the startup path: loaded only when perf tracing is on.
    expect(fin).toContain('if (perfEnabled())');
    expect(text).not.toMatch(/^import .*boot-timing/m);
  });

  it('k3s: master, db and every static worker, after the ready wait and the host-key seed', () => {
    const text = src('lib/deploy/k8s/k3s.js');
    const wait = text.indexOf(tpl('deploy.#{perfPrefix}.waitForReady'));
    const seed = text.indexOf('seedKnownHosts(khPath, ip)', wait);
    const call = text.indexOf('queueBootTiming(', wait);
    expect(wait).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(wait);
    expect(call).toBeGreaterThan(seed);
    const site = text.slice(call, text.indexOf('privateKeyPath,', call));
    expect(site).toContain(tpl('`deploy.#{perfPrefix}.master`'));
    expect(site).toContain(tpl('`deploy.#{perfPrefix}.db`'));
    expect(site).toContain(tpl('`deploy.#{perfPrefix}.worker#{i + 1}`'));
    // Only when this run waited for the master, i.e. a fresh (re)provision.
    const block = between(
      text,
      "if (!state.shouldSkip('k3s-ready'",
      "state.completeStep('k3s-ready')",
    );
    expect(block).toContain('bootTimingDue = true');
    expect(text.slice(call - 40, call)).toContain('if (bootTimingDue)');
  });

  it('compose: the server, inside the state-gated cloud-init wait', () => {
    const block = between(
      src('lib/deploy/effects/index.js'),
      "if (!state.shouldSkip('compose-setup-server'",
      "state.completeStep('compose-setup-server'",
    );
    const wait = block.indexOf("'deploy.compose.cloudInitReady'");
    const call = block.indexOf('queueBootTiming(');
    expect(wait).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(wait);
    expect(block.slice(call)).toContain("prefix: 'deploy.compose'");
  });

  it('compose-ha: both servers, after the paired cloud-init wait', () => {
    const fn = between(
      src('lib/deploy/effects/compose-ha.js'),
      'async function haSetupServers(',
      '\n}\n',
    );
    const wait = fn.indexOf("'deploy.ha.compose.cloudInitReady.both'");
    const call = fn.indexOf('queueBootTiming(');
    expect(wait).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(wait);
    expect(fn.slice(call)).toContain("prefix: 'deploy.ha.compose.primary'");
    expect(fn.slice(call)).toContain("prefix: 'deploy.ha.compose.standby'");
  });

  it('scale: the replacement server, after its cloud-init wait', () => {
    const text = src('scale.js');
    const wait = text.indexOf("perfAsync('scale.cloudInitReady'");
    const call = text.indexOf('queueBootTiming(', wait);
    expect(wait).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(wait);
    expect(text.slice(call, call + 120)).toContain("prefix: 'scale.server'");
  });
});
