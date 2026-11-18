/**
 * Sibling-convergence registry (sibling-surface drift failure class,
 * 2026-07-30).
 *
 * Four of the escapes that motivated this were "the same logical operation
 * implemented twice, fixed once": compose kept warn-and-continue admin-user
 * creation months after k8s failed loud; Hetzner list calls stayed
 * un-paginated after DO's were fixed; Cloudflare DNS destroy deleted only
 * the apex while the Hetzner branch beside it deleted the pair; iter-step
 * hand-copied three of the runner's env vars and silently ran production
 * Let's Encrypt. In every case the durable fix was CONVERGENCE — one shared
 * helper, N consumers — plus a pin that the consumers actually route
 * through it.
 *
 * This file is the registry of those convergences. Each row asserts, from
 * source text, that the helper is still exported where the row says and
 * that every consumer still references it by name — so a refactor that
 * re-inlines a private copy on one side (de-convergence, the first step of
 * every parity drift) fails here by name instead of surfacing as next
 * quarter's asymmetric bug. Behavioral depth lives in each row's deepTests
 * (also existence-checked so the pointers can't rot).
 *
 * When you converge a new sibling pair on a shared helper, ADD A ROW. The
 * decision procedure in docs/tests.md ("which guard must accompany a
 * change") points here.
 *
 * KNOWN LIMIT (PR #214 review, empirically probed): this registry is
 * file-level and listed-consumer-only. It catches a LISTED consumer
 * dropping its reference (de-convergence), but NOT a new file that
 * re-implements the operation without ever touching the helper, and not a
 * re-inline inside a listed file that still mentions the helper's name.
 * New bypassing call sites are caught only by the parity rule at review
 * time — or by a call-site-level repo sweep when the operation has a
 * greppable wire signature (see list-endpoint-pagination-sweep.test.ts
 * for the pattern).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const REGISTRY = [
  {
    helper: 'listHetznerPages',
    definition: 'src/lib/providers/hetzner-pagination.js',
    consumers: [
      'src/lib/providers/hetzner.js', // destroy sweeps + fetchServerTypes catalog
      'scripts/sweep-hetzner.js', // standalone zero-orphan audit
      'tests/e2e/utils/sweep-hetzner.ts', // per-run orphan sweep (lifecycle + iter-step)
    ],
    deepTests: [
      'tests/unit/providers/hetzner-pagination.test.ts',
      'tests/unit/e2e/sweep-pagination.test.ts',
      'tests/unit/providers/list-endpoint-pagination-sweep.test.ts',
    ],
  },
  {
    helper: 'deleteApexAndWildcard',
    definition: 'src/lib/cloudflare-dns.js',
    consumers: [
      'src/destroy.js', // destroyComposeTier + destroyK8sTier
      'src/lib/deploy/compose/ha.js', // destroyComposeHA
    ],
    deepTests: ['tests/unit/lib/delete-apex-and-wildcard.test.ts'],
  },
  {
    // A stale listing names a bucket destroy already removed; its delete
    // answers "no such bucket" by code, status or words (run 43757126064:
    // only the code, the message was "UnknownError"). The census catches a
    // new bucket-delete catch that skips this helper.
    helper: 'classifyBucketDeleteError',
    definition: 'tests/e2e/utils/bucket-already-gone.ts',
    consumers: [
      // The one bucket pass all five sweeps run (the row below): its catch
      // is where a failed bucket delete is decided.
      'tests/e2e/utils/sweep-core.ts',
    ],
    deepTests: [
      'tests/unit/e2e/bucket-already-gone.test.ts',
      'tests/unit/e2e/bucket-gone-census.test.ts',
    ],
  },
  {
    // The bucket pass itself. Each sweep used to carry its own copy of the
    // loop and of the catch above, and the copies had drifted (the Hetzner
    // one logged every delete error and never failed the sweep). A sweep
    // that stops calling this has grown its own loop again.
    helper: 'sweepBuckets',
    definition: 'tests/e2e/utils/sweep-core.ts',
    consumers: [
      'tests/e2e/utils/sweep-hetzner.ts', // Object Storage bucket delete
      'tests/e2e/utils/sweep-digitalocean.ts', // Spaces bucket delete
      'tests/e2e/utils/sweep-vultr.ts', // Object Storage bucket delete
      'tests/e2e/utils/sweep-linode.ts', // Object Storage bucket delete
      'tests/e2e/utils/sweep-scaleway.ts', // Object Storage bucket delete
    ],
    deepTests: [
      'tests/unit/e2e/sweep-hetzner.test.ts',
      'tests/unit/e2e/bucket-gone-census.test.ts',
    ],
  },
  {
    // The outline of a pass over one resource class: list, keep this run's,
    // delete, count or fail, and mark the sweep incomplete on a listing that
    // stopped early or threw. Each of the four sweeps wrote it out once per
    // class, and the copies are where "an unreadable list is not reported"
    // kept coming back. Hetzner's compute passes stay their own.
    helper: 'sweepClass',
    definition: 'tests/e2e/utils/sweep-core.ts',
    consumers: [
      'tests/e2e/utils/sweep-digitalocean.ts',
      'tests/e2e/utils/sweep-linode.ts',
      'tests/e2e/utils/sweep-vultr.ts',
      'tests/e2e/utils/sweep-scaleway.ts',
    ],
    deepTests: [
      'tests/unit/e2e/sweep-pass-transcript.test.ts',
      'tests/unit/e2e/sweep-load-balancers-networks.test.ts',
    ],
  },
  {
    // The volume rule of those four sweeps: never an attached volume, and a
    // CSI volume only with this run's project tag. A sweep with its own copy
    // can lose the tag check, which is how a live rig's volumes were deleted.
    helper: 'sweepOwnsVolume',
    definition: 'tests/e2e/utils/sweep-core.ts',
    consumers: [
      'tests/e2e/utils/sweep-digitalocean.ts',
      'tests/e2e/utils/sweep-linode.ts',
      'tests/e2e/utils/sweep-vultr.ts',
      'tests/e2e/utils/sweep-scaleway.ts',
    ],
    deepTests: ['tests/unit/e2e/sweep-pass-transcript.test.ts'],
  },
  {
    // One page walker for the harness, in each provider's pagination
    // dialect, that never says `complete` unless the provider said there is
    // no next page. The sweeps, preflight and verify-scale each had their
    // own loops, and three of the sweeps' called a listing that ran out of
    // page budget complete. The pagination tripwire
    // (list-endpoint-pagination-sweep.test.ts) recognises a call to it.
    helper: 'walkProviderPages',
    definition: 'tests/e2e/utils/provider-pages.ts',
    consumers: [
      'tests/e2e/utils/preflight.ts', // project-clean checks
      'tests/e2e/utils/sweep-digitalocean.ts', // firewalls, keys, load balancers, VPCs, reserved IPs, tags
      'tests/e2e/utils/sweep-linode.ts', // the same, and the bucket listing
      'tests/e2e/utils/sweep-vultr.ts', // cursor walks
      'tests/e2e/utils/sweep-scaleway.ts', // per-zone and page_size walks
      'tests/e2e/utils/server-types.ts', // verify-scale's server-type snapshot
    ],
    deepTests: ['tests/unit/e2e/provider-pages.test.ts', 'tests/unit/e2e/sweep-page-guard.test.ts'],
  },
  {
    // One ssh attempt for a check, as data: the options, the time limit and
    // what a failed exit carries. replication.ts and pilot-light.ts each had
    // a copy under their own retry, and grafana-ready.ts a third. The retries
    // stay in those files (registered sites in docs/mitigations.yml).
    helper: 'sshExecOnce',
    definition: 'tests/e2e/utils/ssh.ts',
    consumers: [
      'tests/e2e/checks/replication.ts', // under sshExecWithRetry, with the unreachable-host latch
      'tests/e2e/checks/pilot-light.ts', // under its own retry, no latch
      'tests/e2e/checks/grafana-ready.ts', // one attempt, the rollout's own time limit
    ],
    deepTests: ['tests/unit/e2e/checks-ssh-exec.test.ts'],
  },
  {
    // The same call for a check that wants the output or the thrown error.
    helper: 'sshOutput',
    definition: 'tests/e2e/utils/ssh.ts',
    consumers: [
      'tests/e2e/checks/config-canary.ts', // 30 s; the poll reads the thrown message
      'tests/e2e/checks/backup-evidence.ts', // 60 s; sshFailureReason reads the thrown error
    ],
    deepTests: ['tests/unit/e2e/checks-ssh-exec.test.ts'],
  },
  {
    helper: 'e2eCliEnv',
    definition: 'tests/e2e/utils/e2e-env.js',
    consumers: [
      'scripts/iter-step.js', // kept-rig single-step iteration
      'tests/e2e/utils/cli-runner.ts', // full-run step execution
    ],
    deepTests: ['tests/unit/e2e/iter-step-env-parity.test.ts'],
  },
  {
    helper: 'fetchServerTypes',
    definition: 'tests/e2e/utils/server-types.ts',
    consumers: [
      'tests/e2e/scenarios/_run-lifecycle.ts', // verify-scale type snapshots
      'tests/e2e/metrics/collector.ts', // cost metrics IP→type resolution
    ],
    deepTests: ['tests/unit/e2e/server-types.test.ts'],
  },
  {
    helper: 'gitScrubbedEnv',
    definition: 'tests/_shared/git-env.ts',
    consumers: [
      'tests/integration/template/create.test.ts', // fixture git assertions
      'tests/integration/cli/upgrade/upgrade.test.ts', // upgrade hygiene fixture commits
      'tests/e2e/scenarios/_run-lifecycle.ts', // kubectl reads in warm-redeploy-change
    ],
    deepTests: ['tests/unit/lib/git-scrubbed-env.test.ts'],
  },
  {
    // Same shape as gitScrubbedEnv, one layer up: an env var the RUNNER sets
    // that silently redirects what the fixture is testing. Fixed inline in two
    // files first, and the third site was missed until its assertion failed —
    // textbook sibling drift, so converged and pinned here. The FOURTH site
    // (the real-infra e2e harness) was missed by that convergence too and cost
    // a full e2e run: every e2e `create` built a pnpm project, so the matrix
    // never exercised the npm default and broke on the pnpm path instead.
    helper: 'pmScrubbedEnv',
    definition: 'tests/_shared/pm-env.js',
    consumers: [
      'tests/integration/template/create.test.ts', // default-options fixture
      'tests/integration/template/lint-build.test.ts', // npm lint/build/ci gate
      'tests/integration/_harness/real-project.ts', // cached CLI fixture
      'tests/e2e/utils/e2e-env.js', // every real-infra CLI child
    ],
    deepTests: ['tests/unit/lib/pm-scrubbed-env.test.ts'],
  },
  {
    // The address a k8s cluster's records point at: the floating IP, else
    // the master (every DigitalOcean cluster's, since it dropped its reserved
    // IP). Every writer and reader of those records must agree on it, or a
    // DigitalOcean deploy writes the master while failover flips to a
    // reserved IP still on record, or the reverse.
    helper: 'clusterIngressIp',
    definition: 'src/lib/deploy/k8s/ingress-ip.js',
    consumers: [
      'src/lib/deploy/k8s/dns-record.js', // single k8s record writer
      'src/lib/deploy/effects/k8s-ha.js', // k8s-ha record writer + update-dns barrier
      'src/lib/deploy/orchestrator.js', // success save (ingressIp) + post-deploy block
      'src/failover.js', // identifyServers: the DNS flip target
      'src/lib/deploy/completion-summary.js', // where the site lives
      'tests/e2e/checks/ha-integrity.ts', // readServingIp
    ],
    deepTests: [
      'tests/unit/deploy/k8s-ingress-ip.test.ts',
      'tests/unit/deploy/k8s-dns-early-write.test.ts',
      'tests/unit/deploy/k8s-ha-dns-single-writer.test.ts',
      'tests/unit/deploy/k8s-ha-dns-early.test.ts',
      'tests/unit/failover/server-identification.test.ts',
    ],
  },
  {
    // Every S3 call to the backups bucket used to spread the uploads config
    // with only the bucket swapped (`{ ...s3Config, bucket }`), so a backups
    // bucket in another region was asked at the uploads bucket's host. One
    // builder now takes the region and endpoint from the backups target;
    // census (c) in the deep test catches a spread coming back anywhere.
    helper: 'backupStorageConfig',
    definition: 'src/lib/backups-bucket.js',
    consumers: [
      'src/lib/deploy/orchestrator.js', // k8s TLS snapshot, deploy -restore point, lineage listing
      'src/lib/deploy/effects/index.js', // compose TLS restore
      'src/lib/deploy/k8s/k3s.js', // k8s TLS restore
    ],
    deepTests: [
      'tests/unit/deploy/backups-bucket-choice.test.ts',
      'tests/unit/deploy/backups-bucket-single-resolver-census.test.ts',
    ],
  },
  {
    // Every command read `environments.<env>.backupS3` its own way: restore
    // through a raw config loader, destroy with an `'fsn1'` guess for a missing
    // region, the credential check and the e2e checks each with their own
    // fallbacks. One reader now gives the bucket, its region (the uploads
    // region for a record an old CLI wrote without one) and its endpoint (the
    // uploads endpoint only when the regions match); census (a) in the deep
    // test catches a raw read coming back anywhere.
    helper: 'backupsTargetOf',
    definition: 'src/lib/backups-bucket.js',
    consumers: [
      'src/lib/walg/restore-base.js', // restore, backup, status, failover, scale, compose TLS restore
      'src/destroy.js', // -purge and its holders, the preview facts
      'src/lib/destroy/preview.js', // the preview's backups line
      'src/lib/destroy/s3-credential-check.js', // the pre-teardown credential check
      'src/configure.js', // the GitOps TLS snapshot prefix
      'src/lib/deploy/app-storage-credential.js', // unfenced-bucket marks
      'src/lib/deploy/orchestrator.js', // the deploy's skeleton record
      'tests/e2e/checks/backup-evidence.ts', // the e2e backup checks
    ],
    deepTests: [
      'tests/unit/deploy/backups-bucket-choice.test.ts',
      'tests/unit/deploy/backups-bucket-single-resolver-census.test.ts',
    ],
  },
  {
    // The Hetzner app key fence built its backups targets from the live
    // records alone, so once the last environment in a region was destroyed,
    // the backups bucket it kept there dropped out of the fence and a key
    // pasted later was never denied on it. Every backups bucket that holds
    // backups, a destroyed environment's and an older CLI's base bucket
    // included, now comes from the one list destroy -purge and the backups
    // bucket choice already count holders with.
    helper: 'backupsHoldings',
    definition: 'src/lib/backups-bucket.js',
    consumers: [
      'src/lib/deploy/hetzner-app-key-fence.js', // the fence's backups targets
    ],
    deepTests: [
      'tests/unit/deploy/backups-bucket-choice.test.ts',
      'tests/unit/deploy/hetzner-app-key-fence.test.ts',
    ],
  },
  {
    // configure cicd (updateImageReferences) and the GitOps deploy
    // (rewriteOwnerAndRepo) each had their own owner rewrite, "kept in sync"
    // by a comment, with different regexes; and upgrade knew neither, so it
    // read every rewritten file as the user's and left the Flux cluster
    // files behind while k8s/base moved (a literal {{TRAEFIK_IMAGE}} on the
    // cluster). One writer now, and upgrade applies the same edit.
    helper: 'writeGitHubRefs',
    definition: 'src/lib/template-edits.js',
    consumers: [
      'src/lib/ci-setup.js', // updateImageReferences (configure cicd)
      'src/lib/deploy/k8s/gitops-deploy.js', // deployK8sGitOps, before it commits
    ],
    deepTests: [
      'tests/unit/lib/template-edits.test.ts',
      'tests/integration/cli/upgrade/upgrade.test.ts',
    ],
  },
  {
    // upgrade re-applies (and undoes, before it compares) the edits the CLI
    // makes after create; the commands that make them use the same functions.
    helper: 'templateEdits',
    definition: 'src/lib/template-edits.js',
    consumers: ['src/upgrade.js'],
    deepTests: ['tests/unit/lib/template-edits.test.ts'],
  },
  {
    helper: 'addKustomizationEntry',
    definition: 'src/lib/template-edits.js',
    consumers: ['src/add.js'],
    deepTests: ['tests/unit/lib/template-edits.test.ts'],
  },
  {
    // The Flux build's placeholder walk: the GitOps deploy refuses on it,
    // upgrade warns on it.
    helper: 'fluxPlaceholders',
    definition: 'src/lib/deploy/k8s/unrendered-placeholders.js',
    consumers: ['src/lib/deploy/k8s/gitops-deploy.js', 'src/upgrade.js'],
    deepTests: ['tests/unit/deploy/flux-placeholders.test.ts'],
  },
  {
    // The stable IPv6 flow label for servers created before v0.54.1: compose's
    // first command per server and k8s's base pull and pre-pull per node.
    helper: 'withStableFlowLabel',
    definition: 'src/lib/deploy/stable-flowlabel.js',
    consumers: ['src/lib/deploy/compose/db-ledger-preflight.js', 'src/lib/deploy/k8s/k3s.js'],
    deepTests: [
      'tests/unit/deploy/stable-flowlabel-deploy-census.test.ts',
      'tests/unit/deploy/stable-flowlabel-census.test.ts',
    ],
  },
  {
    // The recursive file walk under every source census. Each census had its
    // own copy (a local walk, files(), a recursive readdirSync), and each
    // copy chose for itself what to skip and whether to follow a link, so no
    // one could say what a census scanned without reading its walker. A
    // consumer that grows its own walk again scans a set nobody checked
    // against this one.
    helper: 'sourceFiles',
    definition: 'tests/_shared/source-files.ts',
    consumers: [
      'tests/unit/autoscaler/image-ref.test.ts',
      'tests/unit/cli/no-positional-primary-census.test.ts',
      'tests/unit/cli/printed-command-flags-census.test.ts',
      'tests/unit/config/no-stale-save-census.test.ts',
      'tests/unit/create-vibecarbon/display-name.test.ts',
      'tests/unit/deploy/amd64-only.test.ts',
      'tests/unit/deploy/apiserver-egress-census.test.ts',
      'tests/unit/deploy/app-bucket-single-resolver-census.test.ts',
      'tests/unit/deploy/app-db-credential-census.test.ts',
      'tests/unit/deploy/app-runtime-env-census.test.ts',
      'tests/unit/deploy/apt-lock-timeout-census.test.ts',
      'tests/unit/deploy/backups-bucket-single-resolver-census.test.ts',
      'tests/unit/deploy/cert-manager-no-post-apply-patch-census.test.ts',
      'tests/unit/deploy/cert-manager-owner-ref-census.test.ts',
      'tests/unit/deploy/cloud-init-no-image-pull.test.ts',
      'tests/unit/deploy/cloud-init-units-started.test.ts',
      'tests/unit/deploy/compose-ha-overlay-up-flags.test.ts',
      'tests/unit/deploy/compose-http01-only-census.test.ts',
      'tests/unit/deploy/compose-port-publication.test.ts',
      'tests/unit/deploy/db-attach-watch.test.ts',
      'tests/unit/deploy/db-init-no-peer-census.test.ts',
      'tests/unit/deploy/db-in-pod-stop-census.test.ts',
      'tests/unit/deploy/db-sts-boot-timeout-census.test.ts',
      'tests/unit/deploy/deploy-key-census.test.ts',
      'tests/unit/deploy/flux-base-placeholder-census.test.ts',
      'tests/unit/deploy/flux-placeholders.test.ts',
      'tests/unit/deploy/host-key-seed-parallel-census.test.ts',
      'tests/unit/deploy/hostport-binding-census.test.ts',
      'tests/unit/deploy/image-delivery-census.test.ts',
      'tests/unit/deploy/k8s-addon-pvc-storage-class.test.ts',
      'tests/unit/deploy/k8s-certificate-render.test.ts',
      'tests/unit/deploy/k8s-ha-streaming-probe-always.test.ts',
      'tests/unit/deploy/k8s-http01-only-census.test.ts',
      'tests/unit/deploy/k8s-walg-role-record.test.ts',
      'tests/unit/deploy/kubectl-no-compression-census.test.ts',
      'tests/unit/deploy/no-helper-pod-reseed-census.test.ts',
      'tests/unit/deploy/no-warm-primary-restart-census.test.ts',
      'tests/unit/deploy/oci-image-metadata.test.ts',
      'tests/unit/deploy/pinned-service-no-run-census.test.ts',
      'tests/unit/deploy/pod-ready-wait-census.test.ts',
      'tests/unit/deploy/public-domain-probe-census.test.ts',
      'tests/unit/deploy/raw-ssh-opts-census.test.ts',
      'tests/unit/deploy/restore-destroy-before-verify-census.test.ts',
      'tests/unit/deploy/server-compose-command-census.test.ts',
      'tests/unit/deploy/slot-drop-on-demotion-census.test.ts',
      'tests/unit/deploy/slot-lost-reseed.test.ts',
      'tests/unit/deploy/sshd-concurrency-census.test.ts',
      'tests/unit/deploy/stable-flowlabel-deploy-census.test.ts',
      'tests/unit/deploy/tls-secret-writer-census.test.ts',
      'tests/unit/deploy/traefik-cross-namespace-egress.test.ts',
      'tests/unit/deploy/traefik-restart-challenge-census.test.ts',
      'tests/unit/deploy/vc-compose.test.ts',
      'tests/unit/deploy/walg-dockerfile-arch.test.ts',
      'tests/unit/deploy/walg-retention-orphan-sweep.test.ts',
      'tests/unit/destroy/app-bucket-purged-writer-census.test.ts',
      'tests/unit/destroy/entry-keep-class-table.test.ts',
      'tests/unit/destroy/race-timer-loop-hold-census.test.ts',
      'tests/unit/destroy/retry-command-census.test.ts',
      'tests/unit/destroy/server-name-family-census.test.ts',
      'tests/unit/dns/dns-setup-result-consumed-census.test.ts',
      'tests/unit/docs/carbon-npm-scripts-census.test.ts',
      'tests/unit/docs/parked-addon-surface-census.test.ts',
      'tests/unit/docs/terminology-census.test.ts',
      'tests/unit/e2e/acme-ca-switch.test.ts',
      'tests/unit/e2e/bucket-gone-census.test.ts',
      'tests/unit/e2e/diagnostic-cap.test.ts',
      'tests/unit/e2e/failover-role-resolution.test.ts',
      'tests/unit/e2e/kubectl-flag-order.test.ts',
      'tests/unit/e2e/stack-probes-census.test.ts',
      'tests/unit/helpers/runtime-reach-walk.ts',
      'tests/unit/iac/compose-boot-pull.test.ts',
      'tests/unit/iac/docker-daemon-config-census.test.ts',
      'tests/unit/iac/docker-install-census.test.ts',
      'tests/unit/iac/remove-stack-backup.test.ts',
      'tests/unit/iac/stack-lock.test.ts',
      'tests/unit/iac/state-bucket.test.ts',
      'tests/unit/iac/state-import.test.ts',
      'tests/unit/iac/state-passphrase-census.test.ts',
      'tests/unit/k8s/startup-probe-census.test.ts',
      'tests/unit/lib/cli/interactive-prompt-guard.test.ts',
      'tests/unit/lib/credential-key-convention.test.ts',
      'tests/unit/lib/dns-registration-census.test.ts',
      'tests/unit/lib/dns-setservers-census.test.ts',
      'tests/unit/lib/env-docs-census.test.ts',
      'tests/unit/lib/git-scrub-census.test.ts',
      'tests/unit/lib/git-spawn-env-sweep.test.ts',
      'tests/unit/lib/mitigation-attribution-census.test.ts',
      'tests/unit/lib/no-hardcoded-dns-dispatch.test.ts',
      'tests/unit/lib/operator-env-census.test.ts',
      'tests/unit/lib/pm-spawn-cleanenv-sweep.test.ts',
      'tests/unit/lib/project-config-access-census.test.ts',
      'tests/unit/lib/remote-sentinel-census.test.ts',
      'tests/unit/lib/runtime-floors-census.test.ts',
      'tests/unit/lib/s3-client-timeouts.test.ts',
      'tests/unit/lib/scp-call-site-census.test.ts',
      'tests/unit/lib/ssh-run-argv-census.test.ts',
      'tests/unit/lib/temp-dir-census.test.ts',
      'tests/unit/lib/template-edits.test.ts',
      'tests/unit/lib/transient-classifier-census.test.ts',
      'tests/unit/lib/version-channel-workflow.test.ts',
      'tests/unit/meta/source-pin-echo-guard.test.ts',
      'tests/unit/metrics/perf-publish-ci-gates.test.ts',
      'tests/unit/providers/build-iac-env-census.test.ts',
      'tests/unit/providers/k8s-storage-class-literal-guard.test.ts',
      'tests/unit/providers/list-endpoint-pagination-sweep.test.ts',
      'tests/unit/providers/no-hardcoded-provider-dispatch.test.ts',
      'tests/unit/providers/s3-getobject-body-census.test.ts',
      'tests/unit/providers/s3-region-immutable-census.test.ts',
      'tests/unit/security/git-add-census.test.ts',
      'tests/unit/security/role-password-session.test.ts',
      'tests/unit/security/template-secret-scan.test.ts',
      'tests/unit/services/addon-standby-declaration-census.test.ts',
      'tests/unit/ssh/ssh-key-path-census.test.ts',
      'tests/unit/template/db-log-level.test.ts',
      'tests/unit/template/embedded-shell-syntax.test.ts',
      'tests/unit/template/super-admin-auth.test.ts',
    ],
    deepTests: ['tests/unit/lib/source-files.test.ts'],
  },
  {
    // The Docker tier's synchronous spawn wrappers. Eight files each had
    // their own run, seven their own must, with two error-message forms and
    // two ways of passing stdin and env, so a fix to one (stderr empty, a
    // binary stdout) reached only the file it was made in.
    helper: 'dockerRunner',
    definition: 'tests/_shared/docker-sync.ts',
    consumers: [
      'tests/integration/docker/host-reporter-k3s.test.ts',
      'tests/integration/docker/host-reporter-ubuntu.test.ts',
      'tests/integration/docker/k3s-agent-token.test.ts',
      'tests/integration/docker/k3s-recorded-flags.test.ts',
      'tests/integration/docker/k8s-cloud-secrets-takeover.test.ts',
      'tests/integration/docker/k8s-secret-readers-restart.test.ts',
      'tests/integration/docker/layer-delta-roundtrip.test.ts',
      'tests/integration/docker/server-image-store.test.ts',
    ],
    deepTests: ['tests/unit/lib/docker-sync.test.ts'],
  },
  {
    // The Docker tier's polling wait, copied six times with the same body.
    helper: 'waitFor',
    definition: 'tests/_shared/docker-sync.ts',
    consumers: [
      'tests/integration/docker/host-reporter-k3s.test.ts',
      'tests/integration/docker/k3s-agent-token.test.ts',
      'tests/integration/docker/k3s-recorded-flags.test.ts',
      'tests/integration/docker/k8s-secret-readers-restart.test.ts',
      'tests/integration/docker/layer-delta-roundtrip.test.ts',
      'tests/integration/docker/server-image-store.test.ts',
    ],
    deepTests: ['tests/unit/lib/docker-sync.test.ts'],
  },
  {
    // The blocking sleep under waitFor, which one file also calls itself.
    helper: 'sleepSync',
    definition: 'tests/_shared/docker-sync.ts',
    consumers: ['tests/integration/docker/k8s-cloud-secrets-takeover.test.ts'],
    deepTests: ['tests/unit/lib/docker-sync.test.ts'],
  },
  {
    // The Docker tier's skip gate and its one-line banner. A copy that
    // tests DOCKER_INTEGRATION differently runs (or skips) on its own terms.
    helper: 'dockerTierSkip',
    definition: 'tests/_shared/docker-sync.ts',
    consumers: [
      'tests/integration/docker/host-reporter-k3s.test.ts',
      'tests/integration/docker/host-reporter-ubuntu.test.ts',
      'tests/integration/docker/k3s-agent-token.test.ts',
      'tests/integration/docker/k8s-cloud-secrets-takeover.test.ts',
      'tests/integration/docker/k8s-secret-readers-restart.test.ts',
    ],
    deepTests: ['tests/unit/lib/docker-sync.test.ts'],
  },
  {
    // The real-engine iac tests' `pulumi version` probe, eleven
    // byte-identical copies. Each file keeps its own `hasPulumi` name, which
    // ci-pulumi-cli-pin.test.ts pins in server-state-follows-scale.test.ts.
    helper: 'pulumiOnPath',
    definition: 'tests/_shared/pulumi-cli.ts',
    consumers: [
      'tests/integration/iac/deploy-drop-retired.test.ts',
      'tests/integration/iac/destroy-finishes-stack-after-sweeps.test.ts',
      'tests/integration/iac/destroy-removes-stack-backup.test.ts',
      'tests/integration/iac/pulumi-home-isolated.test.ts',
      'tests/integration/iac/retired-resources-surgery.test.ts',
      'tests/integration/iac/server-state-follows-scale.test.ts',
      'tests/integration/iac/stack-lock.test.ts',
      'tests/integration/iac/state-passphrase-destroy.test.ts',
      'tests/integration/iac/state-passphrase.test.ts',
      'tests/integration/iac/state-seal.test.ts',
      'tests/integration/iac/workspace-dir-exit.test.ts',
    ],
    deepTests: ['tests/unit/lib/pulumi-cli.test.ts'],
  },
] as const;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe.each(REGISTRY)('convergence: $helper', ({ helper, definition, consumers, deepTests }) => {
  it(`is exported from ${definition}`, () => {
    expect(read(definition)).toMatch(new RegExp(`export (?:async )?function ${helper}\\b`));
  });

  it.each([...consumers])('%s routes through it', (consumer) => {
    expect(
      read(consumer),
      `${consumer} no longer references ${helper}. If it grew its own copy, that is ` +
        'de-convergence — the first step of every sibling-parity drift. Route it back through ' +
        `${definition}, or update this registry WITH a parity argument for why the surfaces ` +
        'may now diverge.',
    ).toContain(helper);
  });

  it.each([...deepTests])('deep test %s still exists', (deepTest) => {
    expect(existsSync(join(ROOT, deepTest))).toBe(true);
  });
});
