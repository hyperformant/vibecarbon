/**
 * Census (Task 7b): every compose server created or deleted outside Pulumi is
 * followed by the Pulumi state sync, and the next deploy repairs a sync that
 * did not land before any `up`.
 *
 * The class: provider.createServer builds a replacement the stack does not
 * know, provider.deleteServer removes the server the stack does know. Left
 * alone, the next compose-ha deploy's refresh drops the deleted server and
 * `up` builds a second one. So:
 *   - the only createServer outside the provider classes and the autoscaler is
 *     scale's replacement (createReplacementServer);
 *   - every delete of an OLD server (the one the stack names) records the sync
 *     before the delete and runs it after; every other scale delete removes a
 *     replacement that never took over, which the stack never knew;
 *   - deploy repairs pending syncs before it runs any plan (and so any `up`);
 *   - scale refuses a provider whose stack cannot follow, before any prompt.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !isComment(l))
    .join('\n');

const srcFiles = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
  { cwd: ROOT, encoding: 'utf-8' },
)
  .stdout.split('\n')
  .filter((f) => f.endsWith('.js'))
  .filter((f) => !f.startsWith('src/lib/providers/') && !f.startsWith('src/autoscaler/'));

/** Top-level functions: a column-0 `function` line up to the next column-0 `}`. */
function topLevelFunctions(file: string) {
  const lines = read(file).split('\n');
  const out: { id: string; name: string; body: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/.exec(l);
    if (!m) return;
    let end = lines.findIndex((x, j) => j > i && /^\}\s*$/.test(x));
    if (end === -1) end = lines.length - 1;
    out.push({ id: `${file}#${m[1]}`, name: m[1], body: code(lines.slice(i, end + 1).join('\n')) });
  });
  return out;
}

const fns = srcFiles.flatMap(topLevelFunctions);
const scaleFn = (name: string) => fns.find((f) => f.id === `src/scale.js#${name}`)?.body ?? '';

describe('servers created or deleted outside Pulumi are followed by the state sync', () => {
  it('the only createServer outside the providers and the autoscaler is scale’s replacement', () => {
    const creators = fns.filter((f) => /\.createServer\(/.test(f.body)).map((f) => f.id);
    expect(creators).toEqual(['src/scale.js#createReplacementServer']);
  });

  it('every delete of the server the stack names records the sync first and runs it after', () => {
    const scale = code(read('src/scale.js'));
    const oldDeletes = scale.match(/provider\.deleteServer\(server\.id\)/g) ?? [];
    // The primary arm's (finishComposeCutover) and the standby arm's.
    expect(oldDeletes).toHaveLength(2);

    const finish = scaleFn('finishComposeCutover');
    const order = [
      finish.indexOf('scaledServerStateEntry(ctx, server)'),
      finish.indexOf('recordPendingServerState('),
      finish.indexOf('provider.deleteServer(server.id)'),
      finish.indexOf('clearWriteFenceMarker('),
      finish.indexOf('syncScaledServerState(ctx, stateEntry)'),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The sync sits outside the journaled steps, so a resume past the delete
    // still runs it.
    const destroyStep = finish.slice(finish.indexOf("step('destroy'"));
    expect(destroyStep.indexOf('syncScaledServerState(')).toBeGreaterThan(
      destroyStep.indexOf('});'),
    );

    const servers = scaleFn('scaleServers');
    const standby = servers.slice(servers.indexOf('const scaleStandbyArm = async'));
    const sOrder = [
      standby.indexOf('recordPendingServerState('),
      standby.indexOf('provider.deleteServer(server.id)'),
      standby.indexOf('syncScaledServerState('),
    ];
    expect(sOrder.every((i) => i > -1)).toBe(true);
    expect([...sOrder].sort((a, b) => a - b)).toEqual(sOrder);
  });

  it('every other scale delete removes a replacement the stack never knew', () => {
    const scale = code(read('src/scale.js'));
    const all = scale.match(/\.deleteServer\([^)]*\)/g) ?? [];
    const others = all.filter((d) => d !== '.deleteServer(server.id)');
    expect(others).toEqual(['.deleteServer(newServerId)', '.deleteServer(newServerId)']);
  });

  it('deploy repairs pending syncs on the compose tiers before it runs any plan', () => {
    const orch = code(read('src/lib/deploy/orchestrator.js'));
    const repair = orch.indexOf('await repairPendingServerState(');
    expect(repair).toBeGreaterThan(-1);
    expect(orch.slice(Math.max(0, repair - 300), repair)).toMatch(
      /isComposeTier\(tier\) && envConfig\?\.pendingServerState\?\.length/,
    );
    const firstPlan = orch.indexOf('runPlan(planDeploy(');
    expect(firstPlan).toBeGreaterThan(repair);
  });

  it('compose-ha deploy knows whether -server-type was given (the per-stack type rule reads it)', () => {
    const orch = code(read('src/lib/deploy/orchestrator.js'));
    const haCtx = orch.slice(orch.indexOf('const composeHaCtx = {'));
    expect(haCtx.slice(0, haCtx.indexOf('};'))).toMatch(/serverTypeRequested: !!args\.serverType,/);
    expect(code(read('src/lib/deploy/effects/compose-ha.js'))).toMatch(/ctx\.serverTypeRequested/);
  });

  it('scale refuses a provider the stack cannot follow before the token prompt, and resolves the backend before any server', () => {
    const body = scaleFn('scaleCompose');
    const refuse = body.indexOf('assertComposeScaleKeepsState(');
    const token = body.indexOf('Provider.promptApiToken(');
    const options = body.indexOf('resolveServerStateOptions(');
    const resume = body.indexOf('resumeComposeCutover(');
    const plan = body.indexOf('runPlan(planScale(');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(token);
    expect(token).toBeLessThan(options);
    expect(options).toBeLessThan(resume);
    expect(resume).toBeLessThan(plan);
    // Both the resume and the scale carry the options to the sync.
    expect(body.match(/serverStateOptions,/g)?.length).toBe(2);
  });
});
