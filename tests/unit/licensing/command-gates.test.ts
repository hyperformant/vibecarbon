import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../../../src/cli.js';
import {
  COMMAND_GATES,
  PAID_TIERS,
  requiredTierFor,
  shouldGate,
} from '../../../src/lib/licensing/gate.js';

// The central license gate: cli.js consults COMMAND_GATES before dispatching,
// so a command-wide paid command can never ship unguarded. Every registered
// command MUST be classified here — adding a new command without an
// explicit gating decision fails this suite.
//
// Classifications:
//   'paid':     requires an active Fullerene license regardless of
//               deploy mode (gated in cli.js pre-dispatch, after the
//               project guard). Currently unused, see 'mode' below.
//   'free':     never gated
//   'internal': the command gates a sub-flow itself (e.g. configure only
//               gates its `cicd` flow, which is reachable interactively)
//   'mode':     the command gates itself in-flow once its deploy-mode tier
//               is known (requireDeployEntitlement(); see
//               src/lib/licensing/index.js). Only `deploy` does: the gate
//               fires on every deploy into a paid mode, and backup /
//               restore / failover / scale never check at all.

describe('COMMAND_GATES completeness', () => {
  it('classifies every KNOWN_COMMAND exactly (no missing, no extras)', () => {
    expect(Object.keys(COMMAND_GATES).sort()).toEqual([...KNOWN_COMMANDS].sort());
  });

  it('only uses the four known classifications', () => {
    for (const [cmd, gate] of Object.entries(COMMAND_GATES)) {
      expect(['paid', 'free', 'internal', 'mode'], `unknown classification for ${cmd}`).toContain(
        gate,
      );
    }
  });

  it('gates no command command-wide — licensing is deploy-mode-based now', () => {
    const paid = Object.entries(COMMAND_GATES)
      .filter(([, gate]) => gate === 'paid')
      .map(([cmd]) => cmd);
    expect(paid).toEqual([]);
  });

  it('gates exactly one command in-flow: deploy, the only mode-aware command', () => {
    const mode = Object.entries(COMMAND_GATES)
      .filter(([, gate]) => gate === 'mode')
      .map(([cmd]) => cmd)
      .sort();
    expect(mode).toEqual(['deploy']);
  });

  it('operating an existing environment is free, whatever its deploy mode', () => {
    // The product rule the per-project subscription move pinned: a
    // subscription buys deploys into a paid mode, never the right to run
    // disaster recovery on what is already standing.
    for (const cmd of ['backup', 'restore', 'failover', 'scale']) {
      expect(COMMAND_GATES[cmd], `${cmd} must stay free`).toBe('free');
    }
  });

  it('upgrade is free — a local template refresh, mode-agnostic', () => {
    expect(COMMAND_GATES.upgrade).toBe('free');
  });

  it('destroy is free — teardown is never held hostage to a license', () => {
    expect(COMMAND_GATES.destroy).toBe('free');
  });

  it('configure is free — no sub-flow of it is gated', () => {
    // `configure cicd` was gated in-flow until 2026-08-13. The gate was
    // redundant with the scenario gate (its Flux stage only reaches k8s /
    // k8s-ha, which already required Fullerene to deploy) and it fired before
    // the deploy mode was known, so Compose users hit a paywall for CI/CD,
    // which is free in every mode.
    expect(COMMAND_GATES.configure).toBe('free');
  });

  it('gating is by scenario only: no command carries its own license check', () => {
    // The product rule, pinned. Licensing follows the deploy tier
    // (compose-ha / k8s / k8s-ha); no command is paid for being that command.
    const selfGating = Object.entries(COMMAND_GATES)
      .filter(([, gate]) => gate === 'paid' || gate === 'internal')
      .map(([cmd]) => cmd);
    expect(selfGating).toEqual([]);
  });
});

describe('PAID_TIERS / requiredTierFor', () => {
  it('single-server Compose needs no subscription', () => {
    expect(requiredTierFor('compose')).toBe('graphite');
  });

  it('Kubernetes needs Graphene; both HA modes need Fullerene', () => {
    expect(requiredTierFor('k8s')).toBe('graphene');
    expect(requiredTierFor('k8s-ha')).toBe('fullerene');
    expect(requiredTierFor('compose-ha')).toBe('fullerene');
  });

  it('fails closed on unknown, missing, or corrupt tiers', () => {
    // A corrupt `.vibecarbon.json` or a deploy tier added without updating
    // the map must never provision for free.
    expect(requiredTierFor('bogus')).toBe('fullerene');
    expect(requiredTierFor('')).toBe('fullerene');
    expect(requiredTierFor(undefined as unknown as string)).toBe('fullerene');
    expect(requiredTierFor(null as unknown as string)).toBe('fullerene');
  });

  it('PAID_TIERS is every deploy tier that needs a subscription', () => {
    expect([...PAID_TIERS].sort()).toEqual(['compose-ha', 'k8s', 'k8s-ha']);
  });

  it('PAID_TIERS is derived from requiredTierFor, not typed out twice', () => {
    for (const tier of PAID_TIERS) {
      expect(requiredTierFor(tier), `${tier} is in PAID_TIERS`).not.toBe('graphite');
    }
    expect(PAID_TIERS.has('compose')).toBe(false);
  });
});

describe('shouldGate', () => {
  it('does not pre-dispatch-gate deploy — it gates in-flow after resolving its tier', () => {
    expect(shouldGate('deploy', ['prod'])).toBe(false);
  });

  it('does not gate the commands that only operate an existing environment', () => {
    expect(shouldGate('backup', ['prod', '-l'])).toBe(false);
    expect(shouldGate('restore', ['prod'])).toBe(false);
    expect(shouldGate('failover', ['prod'])).toBe(false);
    expect(shouldGate('scale', [])).toBe(false);
  });

  it('does not gate help or version invocations — help stays free', () => {
    expect(shouldGate('deploy', ['-h'])).toBe(false);
    expect(shouldGate('deploy', ['prod', '-h'])).toBe(false);
    expect(shouldGate('failover', ['-v'])).toBe(false);
  });

  it('does not gate free commands', () => {
    expect(shouldGate('up', [])).toBe(false);
    expect(shouldGate('create', ['my-app'])).toBe(false);
    expect(shouldGate('destroy', ['prod', '-y'])).toBe(false);
  });

  it('does not gate internal commands (they gate their own sub-flows)', () => {
    expect(shouldGate('configure', ['cicd', 'prod'])).toBe(false);
  });

  it('does not gate unknown commands (cli.js rejects them separately)', () => {
    expect(shouldGate('nonsense', [])).toBe(false);
  });
});
