import { describe, expect, it, vi } from 'vitest';
import { runPlan } from '../../../../src/lib/deploy/plan/runner.js';
import { defineStep } from '../../../../src/lib/deploy/plan/step.js';

describe('runPlan', () => {
  const effects = {
    doA: vi.fn(async (ctx) => {
      ctx.log.push('A');
    }),
    doB: vi.fn(async (ctx, args) => {
      ctx.log.push(`B:${args.v}`);
    }),
  };
  it('runs steps in order, passes args + ctx, honors when-gates', async () => {
    const ctx = { log: [] };
    await runPlan(
      [
        defineStep({ name: 'a', effect: 'doA' }),
        defineStep({ name: 'skip', effect: 'doA', when: () => false }),
        defineStep({ name: 'b', effect: 'doB', args: { v: 2 } }),
      ],
      ctx,
      effects,
    );
    expect(ctx.log).toEqual(['A', 'B:2']);
  });
  it('aborts the plan and surfaces the step name when an effect throws', async () => {
    const boom = { boom: vi.fn().mockRejectedValue(new Error('nope')) };
    await expect(
      runPlan([defineStep({ name: 'kaboom', effect: 'boom' })], { log: [] }, boom),
    ).rejects.toThrow(/kaboom/);
  });
  it('throws on an effect name missing from the registry', async () => {
    await expect(runPlan([defineStep({ name: 'x', effect: 'ghost' })], {}, {})).rejects.toThrow(
      /ghost/,
    );
  });

  it('runs a required step normally when its when-predicate is truthy (or absent)', async () => {
    const ctx = { log: [] };
    await runPlan(
      [
        defineStep({ name: 'gate', effect: 'doA', required: true }),
        defineStep({
          name: 'gate2',
          effect: 'doB',
          args: { v: 9 },
          required: true,
          when: () => true,
        }),
      ],
      ctx,
      effects,
    );
    expect(ctx.log).toEqual(['A', 'B:9']);
  });

  it('ABORTS the plan (never silently continues) when a REQUIRED step is when-skipped', async () => {
    // 2026-07-07 k8s-ha RCA guard: a load-bearing gate/persist/replication step
    // must never be gated out. A falsy `when` on a required step is a fatal plan
    // error, surfaced with the step name — the effect must not have run.
    const spy = vi.fn(async () => {});
    await expect(
      runPlan(
        [
          defineStep({
            name: 'verify-streaming',
            effect: 'spy',
            required: true,
            when: () => false,
          }),
        ],
        {},
        { spy },
      ),
    ).rejects.toThrow(/\[step:verify-streaming\] required step SKIPPED/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs (never hides) an OPTIONAL when-skip by name on stderr, then continues', async () => {
    const ctx = { log: [] };
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      await runPlan(
        [
          defineStep({ name: 'transfer-image', effect: 'doA', when: () => false }),
          defineStep({ name: 'b', effect: 'doB', args: { v: 1 } }),
        ],
        ctx,
        effects,
      );
    } finally {
      spy.mockRestore();
    }
    // Optional skip did not run its effect but the later step still ran...
    expect(ctx.log).toEqual(['B:1']);
    // ...and the skip was announced loudly, by name.
    expect(writes.join('')).toMatch(/\[plan\] skip optional step 'transfer-image' \(when=false\)/);
  });
});
