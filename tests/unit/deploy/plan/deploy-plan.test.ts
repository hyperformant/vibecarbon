import { describe, expect, it } from 'vitest';
import { planDeploy } from '../../../../src/lib/deploy/plan/deploy-plan.js';
import { runPlan } from '../../../../src/lib/deploy/plan/runner.js';
import { planStepNames } from '../../../../src/lib/deploy/plan/step.js';

// The compose deploy plan is a pure, faithful decomposition of the (now
// removed) inlined `deployComposeSingle` block — one step per state-gated /
// conditional operation, in the exact order the orchestrator ran them. The
// 5 shared compose effect functions (setupServerFiles, startComposeStack,
// runMigrations, createAdminUser, setupComposeBackupCron) plus provisioning
// and the health gate are the headline steps; the intermediate
// server-prep / login / DNS operations are their own gated steps.
const EXPECTED_COMPOSE_SEQUENCE = [
  'provision-server',
  'setup-server',
  'transfer-image',
  'dockerhub-login',
  'ghcr-login',
  'setup-server-files',
  'update-dns',
  'start-compose-stack',
  'run-migrations',
  'create-admin-user',
  'verify-health',
  'verify-tls',
  'setup-backup-cron',
];

describe('planDeploy(compose)', () => {
  it('produces the compose deploy step sequence (pure — no config needed)', () => {
    const steps = planDeploy('compose', {});
    expect(planStepNames(steps)).toEqual(EXPECTED_COMPOSE_SEQUENCE);
  });

  it('includes the shipped-bug guard steps (run-migrations, create-admin-user, setup-backup-cron)', () => {
    // Regression guard, NOT optional: the inlined compose-single path once
    // shipped an empty schema (no runMigrations), an app the operator could
    // not log into (no createAdminUser), and no scheduled backups (no
    // setupComposeBackupCron). These MUST remain in the compose plan.
    const steps = planDeploy('compose', {});
    for (const guard of ['run-migrations', 'create-admin-user', 'setup-backup-cron']) {
      expect(steps.find((s) => s.name === guard)).toBeTruthy();
    }
  });

  it('is pure: repeated calls produce structurally identical plans with no I/O', () => {
    // Steps carry `when` closures (fresh per call, so reference-inequal); compare
    // the serializable shape — name, effect, and whether the step is gated.
    const shape = () =>
      planDeploy('compose', {}).map((s) => ({
        name: s.name,
        effect: s.effect,
        gated: typeof s.when === 'function',
      }));
    expect(shape()).toEqual(shape());
  });

  it('references only effects that exist in the registry', async () => {
    const { EFFECTS } = await import('../../../../src/lib/deploy/effects/index.js');
    for (const step of planDeploy('compose', {})) {
      expect(typeof EFFECTS[step.effect]).toBe('function');
    }
  });

  it('gates conditional steps with when-predicates and leaves unconditional steps ungated', () => {
    const byName = Object.fromEntries(planDeploy('compose', {}).map((s) => [s.name, s]));

    // provision-server only when the server has not been provisioned yet
    expect(typeof byName['provision-server'].when).toBe('function');
    expect(byName['provision-server'].when({ serverIp: null })).toBe(true);
    expect(byName['provision-server'].when({ serverIp: '1.2.3.4' })).toBe(false);

    // transfer-image only for local sideload / direct build modes
    expect(byName['transfer-image'].when({ isComposeLocal: true })).toBe(true);
    expect(byName['transfer-image'].when({ isDirectDeploy: true })).toBe(true);
    expect(byName['transfer-image'].when({})).toBe(false);

    // login steps gated on credentials being present
    expect(byName['dockerhub-login'].when({ dockerHubCreds: { username: 'x' } })).toBe(true);
    expect(byName['dockerhub-login'].when({ dockerHubCreds: null })).toBe(false);
    expect(byName['ghcr-login'].when({ ciReady: { ghcrPullCreds: { owner: 'x' } } })).toBe(true);
    expect(byName['ghcr-login'].when({ ciReady: {} })).toBe(false);

    // update-dns only for managed DNS providers with a domain
    expect(byName['update-dns'].when({ domain: 'x.com', dnsProvider: 'cloudflare' })).toBe(true);
    expect(byName['update-dns'].when({ domain: 'x.com', dnsProvider: 'manual' })).toBe(false);
    expect(byName['update-dns'].when({ domain: null, dnsProvider: 'cloudflare' })).toBe(false);

    // unconditional steps have no when-gate
    for (const always of [
      'setup-server',
      'setup-server-files',
      'start-compose-stack',
      'run-migrations',
      'create-admin-user',
      'verify-health',
      'setup-backup-cron',
    ]) {
      expect(byName[always].when).toBeUndefined();
    }
  });

  it('throws for an unknown tier', () => {
    expect(() => planDeploy('nope', {})).toThrow('planDeploy: unknown/unsupported tier nope');
  });
});

// The k8s (single-cluster) deploy plan wraps `deployK3s` as ONE step. deployK3s
// is a cohesive, internally state-gated pipeline (Pulumi up → wait-ready →
// kubeconfig → build → sideload → applyK3sManifests) that k8s-ha REUSES
// verbatim, running two copies in parallel with per-cluster state/tracker
// isolation. Cracking it into separate effects would break that parallel
// isolation (two clusters colliding on one ctx) and risk drift on a hardened
// path, so — per the Task 5 brief's "wrap the existing function rather than
// inlining it" — the single-cluster deploy is the one `deploy-cluster` step and
// the shared per-cluster block k8s-ha reuses ×2 IS this deployK3s call.
const EXPECTED_K8S_SEQUENCE = ['deploy-cluster'];

describe('planDeploy(k8s)', () => {
  it('produces the k8s deploy step sequence (pure — no config needed)', () => {
    expect(planStepNames(planDeploy('k8s', {}))).toEqual(EXPECTED_K8S_SEQUENCE);
  });

  it('is a single unconditional step wrapping the deployK3s pipeline', () => {
    const [step] = planDeploy('k8s', {});
    expect(step.name).toBe('deploy-cluster');
    expect(step.effect).toBe('k8sDeployCluster');
    expect(step.when).toBeUndefined();
  });

  it('references only effects that exist in the registry', async () => {
    const { EFFECTS } = await import('../../../../src/lib/deploy/effects/index.js');
    for (const step of planDeploy('k8s', {})) {
      expect(typeof EFFECTS[step.effect]).toBe('function');
    }
  });

  it('is pure: repeated calls produce structurally identical plans', () => {
    const shape = () =>
      planDeploy('k8s', {}).map((s) => ({
        name: s.name,
        effect: s.effect,
        gated: typeof s.when === 'function',
      }));
    expect(shape()).toEqual(shape());
  });
});

// The k8s-ha deploy plan is a pure, faithful decomposition of the (now removed)
// inlined `deployK8sHA` orchestration — every top-level phase it ran, in order:
// generate + upload the shared SSH key, provision BOTH clusters in parallel
// (deployK3s ×2 — the k8s per-cluster block, reused ×2), open the WireGuard
// replication firewall on both, configure replication (setupReplication — the
// hardened WG transport + scale-to-zero reseed, called as a black box),
// hard-gate on streaming (verify-streaming), set up managed-DNS HA (update-dns),
// and print the finalize summary. Replication step NAMES (configure-replication,
// verify-streaming) mirror compose-ha's for cross-tier read symmetry; the
// EFFECTS are k8s-ha-specific (kubectl-over-ssh fan-out, `deploy.ha.k8s.*` perf
// labels) so they are distinct registry entries.
const EXPECTED_K8S_HA_SEQUENCE = [
  'generate-ssh-key',
  'upload-ssh-key',
  'provision-clusters',
  'open-replication-firewall',
  'configure-replication',
  'verify-streaming',
  'update-dns',
  'finalize',
];

describe('planDeploy(k8s-ha)', () => {
  it('produces the k8s-ha deploy step sequence (pure — no config needed)', () => {
    expect(planStepNames(planDeploy('k8s-ha', {}))).toEqual(EXPECTED_K8S_HA_SEQUENCE);
  });

  it('places replication configuration + verification after both clusters provision, in order', () => {
    const names = planStepNames(planDeploy('k8s-ha', {}));
    const idx = (n: string) => names.indexOf(n);
    // Both clusters must exist before the WG firewall + replication run.
    expect(idx('open-replication-firewall')).toBeGreaterThan(idx('provision-clusters'));
    expect(idx('configure-replication')).toBeGreaterThan(idx('open-replication-firewall'));
    // Streaming is verified (hard-gated) only after replication is configured.
    expect(idx('verify-streaming')).toBeGreaterThan(idx('configure-replication'));
    // DNS + finalize come last (mirrors deployK8sHA's tail).
    expect(idx('update-dns')).toBeGreaterThan(idx('verify-streaming'));
    expect(idx('finalize')).toBe(names.length - 1);
  });

  it('reuses the shared per-cluster block ×2 and adds the replication steps', () => {
    // deployK8sHA provisions primary + standby in ONE parallel step (deployK3s
    // ×2), then layers the replication/tunnel/verify steps on top.
    const names = planStepNames(planDeploy('k8s-ha', {}));
    expect(names).toContain('provision-clusters');
    for (const repl of ['open-replication-firewall', 'configure-replication', 'verify-streaming']) {
      expect(names).toContain(repl);
    }
  });

  it('mirrors compose-ha replication step names (cross-tier symmetry)', () => {
    // The Task 5 symmetry check: both HA tiers name the replication phases
    // identically so a reader recognises them across tiers.
    const k8sHaNames = new Set(planStepNames(planDeploy('k8s-ha', {})));
    const composeHaNames = new Set(planStepNames(planDeploy('compose-ha', {})));
    for (const shared of ['configure-replication', 'verify-streaming']) {
      expect(composeHaNames.has(shared)).toBe(true);
      expect(k8sHaNames.has(shared)).toBe(true);
    }
  });

  it('leaves all k8s-ha steps unconditional (conditionals live inside the effects)', () => {
    // deployK8sHA gated its firewall (apiToken), DNS (domain/provider) and
    // degraded handling INSIDE the function body, not at the phase boundary —
    // so no step carries a when-predicate, mirroring compose-ha's provisioning.
    for (const step of planDeploy('k8s-ha', {})) {
      expect(step.when).toBeUndefined();
    }
  });

  it('marks the DR gate + replication + finalize steps `required` (unskippable)', () => {
    // 2026-07-07 RCA: a k8s-ha deploy reported success without ever running its
    // replication hard-gate. These steps carry no `when` today, so `required`
    // has no runtime effect NOW — it is a forward guard: if anyone ever adds a
    // when-predicate that evaluates falsy under the real ctx, runPlan aborts
    // loudly instead of shipping a deploy with no verified replica.
    const byName = Object.fromEntries(planDeploy('k8s-ha', {}).map((s) => [s.name, s]));
    for (const gate of ['configure-replication', 'verify-streaming', 'finalize']) {
      expect(byName[gate].required).toBe(true);
    }
    // update-dns is best-effort (deployK8sHA warned + continued) — NOT required.
    expect(byName['update-dns'].required).toBeUndefined();
  });

  it('runs EVERY step (incl. the replication hard-gate + finalize) under a realistic cold-deploy ctx', async () => {
    // Pin the tonight-failing invariant directly: given a cold-deploy ctx (the
    // shape the orchestrator builds — `{ options: deploymentConfig }` with no
    // primaryResult/replicationStatus yet), runPlan must execute all 8 effects
    // in order. No step may be when-skipped out; the replication setup,
    // verify-streaming gate and finalize MUST all fire. Effects are stubbed so
    // this stays a pure ordering assertion (no SSH/kubectl).
    const ran: string[] = [];
    const record = (name: string) => async () => {
      ran.push(name);
    };
    const stubEffects = {
      haK8sGenerateSshKey: record('generate-ssh-key'),
      haK8sUploadSshKey: record('upload-ssh-key'),
      haK8sProvisionClusters: record('provision-clusters'),
      haK8sOpenReplicationFirewall: record('open-replication-firewall'),
      haK8sConfigureReplication: record('configure-replication'),
      haK8sVerifyStreaming: record('verify-streaming'),
      haK8sUpdateDns: record('update-dns'),
      haK8sFinalize: record('finalize'),
    };
    const coldCtx = {
      options: {
        projectName: 'testapp',
        environment: 'e4',
        region: 'nbg1',
        secondaryRegion: 'hel1',
        apiToken: 'tok',
        domain: 'e4.appcarbon.dev',
        dnsProvider: 'cloudflare',
        allowDegraded: false,
      },
    };
    await runPlan(planDeploy('k8s-ha', {}), coldCtx, stubEffects);
    expect(ran).toEqual(EXPECTED_K8S_HA_SEQUENCE);
  });

  it('references only effects that exist in the registry', async () => {
    const { EFFECTS } = await import('../../../../src/lib/deploy/effects/index.js');
    for (const step of planDeploy('k8s-ha', {})) {
      expect(typeof EFFECTS[step.effect]).toBe('function');
    }
  });

  it('is pure: repeated calls produce structurally identical plans', () => {
    const shape = () =>
      planDeploy('k8s-ha', {}).map((s) => ({
        name: s.name,
        effect: s.effect,
        gated: typeof s.when === 'function',
      }));
    expect(shape()).toEqual(shape());
  });
});

// The compose-ha deploy plan is a pure, faithful decomposition of the (now
// removed) inlined `deployComposeHA` block — every operation it performed,
// in order, over the primary+standby pair. It is the compose primary sequence
// generalized to a two-node fan-out PLUS the HA-only replication additions
// (write-replication-overlay, configure-replication, verify-streaming) and the
// two-node config persistence (persist-pending-config / finalize-config that
// deployComposeHA owned inline). Step NAMES mirror the single-compose plan
// where the operation is conceptually shared (setup-server-files,
// start-compose-stack, run-migrations, create-admin-user, setup-backup-cron,
// update-dns) so the read symmetry is visible; the EFFECTS differ (multi-node
// fan-out + `deploy.ha.compose.*` perf labels), so they are distinct registry
// entries — reusing the single-server effects verbatim would change the perf
// instrumentation and the ctx shape, breaking behavior-identity.
const EXPECTED_COMPOSE_HA_SEQUENCE = [
  'provision-servers',
  'persist-pending-config',
  'wait-for-ssh',
  'seed-known-hosts',
  'setup-servers',
  'wait-docker-ready',
  'remote-build',
  'setup-server-files',
  'merge-walg-role',
  'pull-images',
  'update-dns',
  'start-compose-stack',
  'run-migrations',
  'create-admin-user',
  'wait-primary-postgres',
  'write-replication-overlay',
  'configure-replication',
  'verify-streaming',
  'verify-tls',
  'setup-backup-cron',
  'finalize-config',
];

describe('planDeploy(compose-ha)', () => {
  it('produces the compose-ha deploy step sequence (pure — no config needed)', () => {
    const steps = planDeploy('compose-ha', {});
    expect(planStepNames(steps)).toEqual(EXPECTED_COMPOSE_HA_SEQUENCE);
  });

  it('places the replication additions after the primary app is up, in order', () => {
    const names = planStepNames(planDeploy('compose-ha', {}));
    const idx = (n: string) => names.indexOf(n);
    // The app must be serving (migrations + admin + primary PG ready) before
    // the standby is seeded.
    expect(idx('run-migrations')).toBeGreaterThan(idx('start-compose-stack'));
    expect(idx('wait-primary-postgres')).toBeGreaterThan(idx('create-admin-user'));
    // Overlay is written before replication is configured; streaming is
    // verified only after the standby is configured.
    expect(idx('write-replication-overlay')).toBeGreaterThan(idx('wait-primary-postgres'));
    expect(idx('configure-replication')).toBeGreaterThan(idx('write-replication-overlay'));
    expect(idx('verify-streaming')).toBeGreaterThan(idx('configure-replication'));
    // Backup cron + finalize come last (mirrors deployComposeHA's tail).
    expect(idx('setup-backup-cron')).toBeGreaterThan(idx('verify-streaming'));
    expect(idx('finalize-config')).toBe(names.length - 1);
  });

  it('includes the shipped-bug guard steps shared with single compose', () => {
    const steps = planDeploy('compose-ha', {});
    for (const guard of ['run-migrations', 'create-admin-user', 'setup-backup-cron']) {
      expect(steps.find((s) => s.name === guard)).toBeTruthy();
    }
  });

  it('marks the persist + replication + finalize steps `required` (unskippable)', () => {
    // Same forward guard as k8s-ha: the two-node config persistence
    // (persist-pending-config so destroy can recover, finalize-config that
    // promotes deployed) and the replication gate must never be silently
    // gated out of a compose-ha deploy.
    const byName = Object.fromEntries(planDeploy('compose-ha', {}).map((s) => [s.name, s]));
    for (const gate of [
      'persist-pending-config',
      'configure-replication',
      'verify-streaming',
      'finalize-config',
    ]) {
      expect(byName[gate].required).toBe(true);
    }
  });

  it('gates remote-build on a local-only image tag; provisioning is unconditional', () => {
    const byName = Object.fromEntries(planDeploy('compose-ha', {}).map((s) => [s.name, s]));
    // deployComposeHA always reconciled both Pulumi stacks (idempotent) — no
    // warm-skip gate, unlike single compose's provision-server.
    expect(byName['provision-servers'].when).toBeUndefined();
    // Remote build only fires when the image is local-only (isLocalOnlyImageTag).
    expect(byName['remote-build'].when({ isLocalOnlyImage: true })).toBe(true);
    expect(byName['remote-build'].when({ isLocalOnlyImage: false })).toBe(false);
  });

  it('references only effects that exist in the registry', async () => {
    const { EFFECTS } = await import('../../../../src/lib/deploy/effects/index.js');
    for (const step of planDeploy('compose-ha', {})) {
      expect(typeof EFFECTS[step.effect]).toBe('function');
    }
  });

  it('is pure: repeated calls produce structurally identical plans', () => {
    const shape = () =>
      planDeploy('compose-ha', {}).map((s) => ({
        name: s.name,
        effect: s.effect,
        gated: typeof s.when === 'function',
      }));
    expect(shape()).toEqual(shape());
  });
});
