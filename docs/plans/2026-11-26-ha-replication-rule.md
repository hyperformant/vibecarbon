# k8s-ha replication rule survives scale and failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A k8s-ha side's cloud firewall keeps the WireGuard replication rule (UDP 51821 from the peer database node) through `vibecarbon scale`, `vibecarbon failover` and every other Pulumi up, on every provider whose k8s program declares firewall rules inline (Hetzner, DigitalOcean, Linode; Scaleway in Part C).

**Architecture:** The mechanism that already keeps the operator rules (22, 6443) through an up, applied to 51821. One input helper returns the other HA side's recorded database IP; both program builders pass it; each inline-rule k8s program appends a rule identical to its provider's REST `buildPeerRule`, last. The REST write stays as the bootstrap (first deploy, a replaced database node) and is a no-op otherwise. Vultr is unchanged: REST is its only writer (ruling RV5).

**Tech Stack:** Node ESM CLI, Pulumi (`@pulumi/hcloud`, `@pulumi/digitalocean`, `@pulumi/linode`), vitest with Pulumi mocks.

**Spec:** `docs/specs/2026-11-26-k8s-everywhere-design.md` (Part A's intent: close the k8s gaps on every provider; the shared firewall decision: "k8s-ha adds UDP 51821 from the peer database node's public IP"). Evidence: `.superpowers/sdd/2026-11-26-scaleway-k8s/udp51821-investigation.md` (read-only code investigation, 2026-11-26; its line numbers were read on main e7b09398).

## Global Constraints

- The finding (investigation sections 1 and 2): Hetzner (`hetzner-k8s.js` ~175-225, `replaceOnChanges: ['*']`), DigitalOcean (`digitalocean-k8s.js` ~234-251) and Linode (`linode-k8s.js` ~178-218) declare inbound rules inline without 51821. Every up refreshes first (`src/lib/iac/index.js` ~1209), so the up resets the live firewall to the declared list. `vibecarbon scale` (`src/scale.js` ~3013, ~3028, through `convergeClusterInfra`) drops 51821 on both sides and `vibecarbon failover` (`src/failover.js` ~1624) on the standby; neither re-opens it. Hetzner replaces both firewalls on every k8s-ha up (a brief window with no firewall, and a new firewall id).
- Traffic today (investigation section 3): established tunnels kept working (Hetzner documents that rule changes affect only new connections; both peers keep alive every 25 s). A database node reboot or a wg0 rebuild after the rule is gone has to re-form the tunnel with no allow rule: unmeasured, and the reason this is a fix, not a note.
- The declared rule equals each provider's `buildPeerRule` field for field (Hetzner's has no `description`), and goes last, where `replaceWireguardPeerRules` (`src/lib/providers/base.js` ~1974-1980) appends it. Linode's list is ordered.
- The peer is keyed by stack, not by role: failover swaps `ha.primary`/`ha.standby`, so the helper reads the other stack's recorded `dbIp` (`haStacksFrom`).
- No peer recorded (first deploy, non-HA, or before the other side's first up) declares no rule. The REST step (`openReplicationFirewallForPeers`, `src/lib/deploy/effects/k8s-ha.js` ~593-653) stays as the bootstrap.
- A scale that replaces a database node (`dbType` change) leaves the peer side's firewall pointing at the old address today (`scaleReestablishHaTunnel`, `src/scale.js` ~3069-3140, rebuilds wg0 but never the firewall). It re-opens the replication rule for both sides after its tunnel rebuild, through the same `openReplicationFirewallForPeers`.
- Vultr (`K8S_OPERATOR_RULES_AFTER_UP === true`) declares none of 22, 6443 or 51821 in its program (RV5).
- Before every commit: `pnpm lint`, `pnpm lint:infra`, `pnpm unused`, `pnpm dupes`, `pnpm test:unit`, and `pnpm test:integration` for Task 1; paste the output in the report.
- Commit rules: `git commit -F <msgfile> -- <paths>`, `git config --show-origin user.email` names `~/.gitconfig`, no `--no-verify`, no `!:` or BREAKING CHANGE footer; the message ends with the session's `Claude-Session:` line.
- No cloud calls and no real servers: real runs start after Parts A, B and C are all merged.
- Never read or print `tests/.env.e2e` or any `.env` file; recursive greps use `--exclude='.env*'`.

## Review Focus

1. A k8s-ha side whose peer has no recorded `dbIp` yet (the first deploy's first side): the program declares no 51821 rule and the deploy still opens it by REST. Test in Task 1.
2. After a failover (roles swapped), each side's program declares the OTHER stack's `dbIp`, not the role-named one. Test in Task 1.
3. A non-HA k8s environment never gets a 51821 rule. Test in Task 1.
4. A `dbType` scale that replaces the standby's database node ends with both firewalls admitting the NEW address. Test in Task 1.
5. A recorded `dbIp` that is not a valid IPv4 address (hand-edited `.vibecarbon.json`) is refused before any up, in the same voice as `requireOperatorCidrs`. Test in Task 1.

---

### Task 1: The programs declare the replication rule

**Files:**
- Modify: `src/lib/iac/program-inputs.js` (new `replicationPeerIpFor`)
- Modify: `src/lib/deploy/k8s/k3s.js` (deployK3s's `programConfig`, ~6360-6378), `src/lib/scale-plan.js` (`buildProgramConfig`), and their callers that must hand over the env config (`src/lib/deploy/effects/k8s-ha.js` ~280, ~312; `src/lib/iac/converge-cluster.js` ~316)
- Modify: `src/lib/iac/programs/hetzner-k8s.js`, `digitalocean-k8s.js`, `linode-k8s.js`
- Modify: `src/scale.js` (`scaleReestablishHaTunnel` re-opens the rule for both sides)
- Create: `tests/unit/iac/k8s-firewall-round-trip-census.test.ts`, `tests/unit/iac/replication-peer-input.test.ts`

**Interfaces:**
- Produces: `replicationPeerIpFor(envConfig, stackName) -> string | undefined` in `src/lib/iac/program-inputs.js`. Returns the other HA side's recorded `dbIp` for `stackName`; undefined when the environment is not HA or the peer has none recorded; throws (message names the env, the stack and the bad value) when the recorded value is not a valid IPv4 address. Program config field: `replicationPeerIp` (string, optional).
- Consumes: `haStacksFrom`, each provider's `buildPeerRule`, `buildReplicationFirewallRules`, `applyOperatorCidrs`, `openReplicationFirewallForPeers`; `tests/unit/helpers/js-call-scan.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `replication-peer-input.test.ts`: Review Focus 1, 2, 3 and 5 against `replicationPeerIpFor` with fixture env configs (HA with both sides recorded; HA with the standby unrecorded; HA after a failover swap; non-HA; a recorded `dbIp` of `'10.0.0.300'` and `'not-an-ip'`).
  - `k8s-firewall-round-trip-census.test.ts`, walking `PROVIDERS` (not a hand list), as `tests/unit/providers/wireguard-peer-rules-census.test.ts` does:
    - For every provider with a k8s program and `K8S_OPERATOR_RULES_AFTER_UP === false`: build the program under Pulumi mocks for a k8s-ha side with `replicationPeerIp: '203.0.113.7'` and operator CIDRs; map the declared inbound rules to that provider's REST wire shape; assert `buildReplicationFirewallRules(fw, '203.0.113.7')` returns `null`, and that the rule set `applyOperatorCidrs(sameCidrs)` would PUT equals the declared list, in order. Without `replicationPeerIp`, assert the declared list has no 51821 rule.
    - For every provider with `K8S_OPERATOR_RULES_AFTER_UP === true`: assert its program declares none of 22, 6443 or 51821.
    - Every `getK8sProgram(` call site in `src/` passes a config built with `replicationPeerIpFor` (source pin through `js-call-scan.ts`, the style of `tests/unit/deploy/k8s-operator-rules-after-up.test.ts`). Today: `k3s.js`, `converge-cluster.js`.
  - Review Focus 4: a unit test of `scaleReestablishHaTunnel` with stubbed providers asserting `openReplicationFirewallForPeers` runs after the tunnel rebuild with the new database IP for both sides.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit tests/unit/iac/k8s-firewall-round-trip-census.test.ts tests/unit/iac/replication-peer-input.test.ts`. Expected: FAIL (`replicationPeerIpFor` is not exported; the declared lists lack 51821).
- [ ] **Step 3: Implement.** The helper beside `requireOperatorCidrs`; both builders pass `replicationPeerIp`; each inline program appends one rule equal to its `buildPeerRule(replicationPeerIp)`, last, only when set; `scaleReestablishHaTunnel` calls `openReplicationFirewallForPeers` after the rebuild. Update the comment in `hetzner-k8s.js` that calls a firewall replace rare, and the `k8s-ha.js` doc comment that says no other path touches the firewall.
- [ ] **Step 4: Run the gate.** `pnpm lint && pnpm lint:infra && pnpm unused && pnpm dupes && pnpm test:unit && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit.** Subject `fix(k8s-ha): the replication rule survives scale and failover`. Body: the finding in two sentences, the mechanism, and that Hetzner no longer replaces both firewalls on every k8s-ha up.

### Task 2: verify-scale checks replication and the firewall

**Files:**
- Modify: `tests/e2e/scenarios/_run-lifecycle.ts` (verify-scale ~3191-3395; the stale comment ~1850 that says verify-scale checks replication)
- Modify or create: the unit test that pins the verify-scale check list (find it by `verify-scale` under `tests/unit/e2e`)

- [ ] **Step 1: Write the failing test.** The verify-scale step for an HA mode runs `runReplicationChecks` and a firewall read that asserts, for both sides, `buildReplicationFirewallRules(<that side's firewall>, <the peer's dbIp>) === null`; a non-HA mode runs neither.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement**, and fix the stale comment.
- [ ] **Step 4: Run the gate** (`pnpm lint && pnpm test:unit`). Expected: PASS.
- [ ] **Step 5: Commit.** Subject `test(e2e): verify-scale checks k8s-ha replication and its firewall rule`.

## Rulings made during execution

- The REST opener named firewalls by role. After a failover it wrote each cluster's own database address into its own firewall, so both sides admitted only themselves. It now names them by stack (`${projectName}-${stack}-firewall`), the name the programs use.
- Scale carries the addresses its up returned (`ctx.convergedDb`) into the tunnel rebuild and the REST re-open. A replaced database node's new `dbIp`/`dbPrivateIp` is saved on `ha.<role>` in the same config write as the types, so the next up never declares a stale peer. Every provider resizes in place today, so this path is unreachable for now.
- A k8s-ha scale with infrastructure changes checks both sides' recorded peer addresses before the token prompt and any up. A bounds-only scale runs no up and skips the check.
- A record without `ha.*.stack` falls back to `<env>-primary`/`<env>-standby`, as deploy and scale already resolve it.
- "Last" means "in the order the REST writers produce". It is last for Hetzner, DigitalOcean and Linode. Scaleway (Part C) declares 51821 after 443 and before 22, because its `applyOperatorCidrs` writes `[...kept, ...rebuilt]`. The round-trip census compares in order and walks the registry, so it holds Scaleway to whichever order its writers share.
- e2e checks:
  - verify-scale checks the end state (replication streaming, and both firewalls admit the peer).
  - verify-scale also requires the scale's ups to have planned no create, update or replace of a firewall resource on inline-rule providers. It reads the `scale.k8s.<stack>.upStack` per-resource markers and fails if a side has none. Without it, the scale's own REST re-open would hide a program that stopped declaring the rule.
  - verify-failover, verify-failback and reconverge-deploy read both firewalls by stack.
  - Part C confirms that Scaleway's Pulumi type name matches `/Firewall|SecurityGroup/`.
- The investigation this plan cites lives in a git-ignored workspace. Its findings are restated in Global Constraints above, which is the durable record.

## Out of scope

- compose-ha (not shipping); its programs never run an up on a recorded server.
- Opening 51821 to the whole internet (widens the peer-scoped posture; not chosen).
- Real-server proof: the first k8s-ha e2e runs after Parts A, B and C merge check that a scale and a failover leave no firewall change in the per-resource markers.
