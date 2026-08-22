import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../../../src/cli.js';
import {
  COMMAND_GATES,
  isPaidTier,
  PAID_TIERS,
  shouldGate,
} from '../../../src/lib/licensing/gate.js';

// The central license gate: cli.js consults COMMAND_GATES before dispatching,
// so a command-wide paid command can never ship unguarded. Every registered
// command MUST be classified here — adding a new command without an
// explicit gating decision fails this suite.
//
// Classifications:
//   'paid'     — requires an active Fullerene license regardless of
//                deploy mode (gated in cli.js pre-dispatch, after the
//                project guard). Currently unused — see 'mode' below.
//   'free'     — never gated
//   'internal' — the command gates a sub-flow itself (e.g. configure only
//                gates its `cicd` flow, which is reachable interactively)
//   'mode'     — the command gates itself in-flow once its deploy-mode tier
//                is known (requirePaidTier() — see src/lib/licensing/index.js)

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

  it('gates exactly the mode-based command set', () => {
    const mode = Object.entries(COMMAND_GATES)
      .filter(([, gate]) => gate === 'mode')
      .map(([cmd]) => cmd)
      .sort();
    expect(mode).toEqual(['backup', 'deploy', 'failover', 'restore', 'scale']);
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

describe('PAID_TIERS / isPaidTier', () => {
  it('single-server Compose is the only free tier', () => {
    expect(isPaidTier('compose')).toBe(false);
  });

  it('Compose HA, Kubernetes, and Kubernetes HA all require a license', () => {
    expect(isPaidTier('compose-ha')).toBe(true);
    expect(isPaidTier('k8s')).toBe(true);
    expect(isPaidTier('k8s-ha')).toBe(true);
  });

  it('PAID_TIERS is exactly compose-ha, k8s, k8s-ha', () => {
    expect([...PAID_TIERS].sort()).toEqual(['compose-ha', 'k8s', 'k8s-ha']);
  });

  it('fails closed on unknown, missing, or corrupt tiers', () => {
    expect(isPaidTier('bogus')).toBe(true);
    expect(isPaidTier('')).toBe(true);
    expect(isPaidTier(undefined as unknown as string)).toBe(true);
    expect(isPaidTier(null as unknown as string)).toBe(true);
  });
});

describe('shouldGate', () => {
  it('does not pre-dispatch-gate mode-based commands — they gate in-flow after resolving tier', () => {
    expect(shouldGate('deploy', ['prod'])).toBe(false);
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
