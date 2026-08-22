/**
 * Every state-backend failure this repo has actually observed, verbatim.
 *
 * This corpus is the reason the seven nested recovery branches in
 * `src/lib/iac/index.js` can be collapsed into one classifier without losing
 * what they know. Each entry is a real incident, dated, with the message text
 * quoted from the branch comment that was written when it happened. The
 * classifier is judged against these, so the knowledge lives in tests rather
 * than in nesting.
 *
 * Rules for adding an entry:
 *   - `message` must be the real text, not a paraphrase. Keep the execa
 *     envelope (`Command failed with exit code N: pulumi <verb> …`) because the
 *     verb is what distinguishes a pre-mutation failure from a post-mutation
 *     one, and it is the only place that information exists.
 *   - `expect.phase` is the mutation-safety answer: did cloud resources change
 *     before this failed? `'unknown'` is the fail-safe, and callers must treat
 *     it as "not provably pre-mutation".
 *   - Never delete an entry. A signature that stops occurring is not a
 *     signature that stopped existing.
 */

export type StatePhase = 'pre-mutation' | 'post-mutation' | 'unknown';

export type StateRecovery =
  | 'retry-in-place'
  | 'reread-outputs'
  | 'guarded-rerun'
  | 'verify-and-continue'
  | 'fail';

export type StateCause =
  | 'throttle'
  | 'lock-contention'
  | 'lock-blob-missing'
  | 'bucket-missing'
  | 'bucket-auth-lag'
  | 'checkpoint-stale'
  | 'stack-file-missing'
  | 'history-write'
  | 'unknown';

export interface StateErrorCase {
  /** Short id used in test names. */
  id: string;
  /** When this was first observed, and where. */
  incident: string;
  /** Our own operation label at the call site. */
  operation: string;
  /** The error text as it actually reached us. */
  message: string;
  expect: {
    cause: StateCause;
    phase: StatePhase;
    recovery: StateRecovery;
  };
}

/** execa builds `[shortMessage, stderr, stdout].join('\n')`. */
const envelope = (verb: string, args: string, body: string) =>
  `Command failed with exit code 1: pulumi ${verb} ${args}\n${body}`;

export const STATE_ERROR_CORPUS: StateErrorCase[] = [
  {
    id: 'throttle-slowdown',
    incident: '2026-06-01 — parallel matrix, S3 SlowDown on the shared state bucket',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e2-primary --non-interactive',
      'error: 503 SlowDown: Please reduce your request rate',
    ),
    expect: { cause: 'throttle', phase: 'unknown', recovery: 'retry-in-place' },
  },
  {
    id: 'throttle-service-unavailable',
    incident: '2026-07-05 — fresh-bucket stack-select throttle',
    operation: 'stack-select',
    message: 'ServiceUnavailable: status code: 503',
    expect: { cause: 'throttle', phase: 'unknown', recovery: 'retry-in-place' },
  },
  {
    // The observability gap: today this matches STATE_BACKEND_THROTTLE_PATTERN
    // and is logged as "throttled", which is why we cannot tell server overload
    // from our own concurrency in the logs.
    id: 'lock-contention',
    incident: '2026-07-05 — a SlowDown-interrupted up left its own lock behind',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e2-primary --non-interactive',
      'error: the stack is currently locked by 1 lock(s). Either wait for the other process to finish or delete the lock file',
    ),
    expect: { cause: 'lock-contention', phase: 'pre-mutation', recovery: 'retry-in-place' },
  },
  {
    id: 'lock-blob-missing',
    incident: '2026-07-31 — compose-ha e2 restore re-deploy, fresh bucket, up exit 1 at 26.8s',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e2-primary --non-interactive',
      'error: blob (key ".pulumi/locks/organization/vibecarbon/e2-primary/9bba65d9-1c4e-4f7a-9a3e-2f0b5c8d7e11.json") (code=NotFound): NoSuchKey: status code: 404, request id: tx0000-nbg1-prod1-ceph5',
    ),
    // Flipped to FAIL 2026-08-16: fresh-bucket staleness, trigger root-fixed.
    expect: { cause: 'lock-blob-missing', phase: 'pre-mutation', recovery: 'fail' },
  },
  {
    id: 'bucket-missing-on-up',
    incident: '2026-07-25 — up hit a frontend the successful stack-select did not',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e1 --non-interactive',
      'error: could not read bucket: NoSuchBucket: status code: 404',
    ),
    // Flipped to FAIL 2026-08-16: visibility is condition-gated before any
    // state op, so NoSuchBucket past the gate is real or a store fault.
    expect: { cause: 'bucket-missing', phase: 'unknown', recovery: 'fail' },
  },
  {
    id: 'checkpoint-stale-error',
    incident: '2026-08-06 — k8s-ha record run, restore re-deploy, fresh bucket, e4-standby',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e4-standby --non-interactive',
      'error: failed to load checkpoint: blob (key ".pulumi/stacks/vibecarbon/e4-standby.json") (code=NotFound): NoSuchKey: status code: 404, request id: tx0001-nbg1-prod1-ceph5',
    ),
    // Flipped to FAIL 2026-08-16: the guarded re-run is deleted with its
    // recreated-bucket trigger; pre-mutation phase tells the operator a plain
    // re-run is safe.
    expect: { cause: 'checkpoint-stale', phase: 'pre-mutation', recovery: 'fail' },
  },
  {
    id: 'checkpoint-stale-panic',
    incident: '2026-08-06 — sibling cluster e4-primary, same 41s window, pulumi v3.231.0 nil-deref',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e4-primary --non-interactive',
      [
        'The Pulumi CLI encountered a fatal error. This is a bug!',
        'Panic: runtime error: invalid memory address or nil pointer dereference',
        'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).getTarget	diy/state.go:88',
        'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).newUpdate	diy/state.go:62',
        'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).apply	diy/backend.go:1213',
      ].join('\n'),
    ),
    // Flipped to FAIL 2026-08-16: the guarded re-run is deleted with its
    // recreated-bucket trigger; pre-mutation phase tells the operator a plain
    // re-run is safe.
    expect: { cause: 'checkpoint-stale', phase: 'pre-mutation', recovery: 'fail' },
  },
  {
    id: 'stack-file-missing-at-up-startup',
    incident: '2026-07-31 — e1, the stack-file lookup before the engine ran',
    operation: 'up',
    message: envelope('up', '--stack e1 --non-interactive', "error: no stack named 'e1' found"),
    // Flipped to FAIL 2026-08-16 (recovery deleted); phase survives as the
    // operator's mutation-safety answer.
    expect: { cause: 'stack-file-missing', phase: 'pre-mutation', recovery: 'fail' },
  },
  {
    // THE ci2 FAILURE, run 31898658781, 2026-08-15. Same text as the entry
    // above; only the verb differs, and the verb is the whole answer. `up`
    // already succeeded, so re-running is a double-provision hazard and the
    // only safe recovery is a read-only outputs poll.
    id: 'stack-file-missing-at-post-up-outputs',
    incident: '2026-08-15 — run 31898658781, hetzner/compose-ha restore, ci2-primary',
    operation: 'up',
    message: [
      'Command failed with exit code 6: pulumi stack output --json --stack ci2-primary --non-interactive',
      'SDK 2026/08/15 18:08:11 WARN Response has no supported checksum. Not validating response payload.',
      "error: no stack named 'ci2-primary' found",
    ].join('\n'),
    // Flipped to FAIL 2026-08-16: resources exist (post-mutation), and the
    // operator must inspect state before anything re-runs — absorbed rereads
    // are how this class hid for months.
    expect: { cause: 'stack-file-missing', phase: 'post-mutation', recovery: 'fail' },
  },
  {
    id: 'history-write-403',
    incident: '2026-07-31 — k8s scale e3, update fully applied, only the history entry failed',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e3 --non-interactive',
      [
        'Resources: ~3 updated, 8 unchanged',
        'Duration: 44s',
        'error: saving update info: blob (key ".pulumi/history/vibecarbon/e3/e3-1785538035700410364.history.json") (code=Unknown): AccessDenied: status code: 403, request id: tx0002-nbg1-prod1-ceph5',
      ].join('\n'),
    ),
    expect: { cause: 'history-write', phase: 'post-mutation', recovery: 'verify-and-continue' },
  },
  {
    id: 'bucket-auth-lag',
    incident: '2026-08-09 — round-A e4, mid-life state bucket answered AccessDenied for 6+ minutes',
    operation: 'backend-init',
    message:
      'error: could not list bucket: blob (code=Unknown): AccessDenied: status code: 403, request id: tx0003-hel1-prod1-ceph3',
    expect: { cause: 'bucket-auth-lag', phase: 'pre-mutation', recovery: 'fail' },
  },
];

/**
 * Cases that must NOT be treated as recoverable. These are the guard rails —
 * each one is a real answer that an over-eager classifier would swallow, and
 * every one of them was called out in a branch comment as the thing that
 * branch must never do.
 */
export const STATE_ERROR_NEGATIVES: StateErrorCase[] = [
  {
    id: 'corrupt-checkpoint-is-honest',
    incident: 'A checkpoint that fails to load because it is CORRUPT, not absent',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e1 --non-interactive',
      'error: failed to load checkpoint: unmarshalling checkpoint: invalid character in string literal',
    ),
    expect: { cause: 'unknown', phase: 'unknown', recovery: 'fail' },
  },
  {
    id: 'destroy-path-bucket-missing-is-real',
    incident: 'Destroy-path NoSuchBucket is a real answer — the M3 wrong-creds-launder incident',
    operation: 'destroy',
    message: envelope(
      'destroy',
      '--stack e1 --non-interactive',
      'error: could not read bucket: NoSuchBucket: status code: 404',
    ),
    expect: { cause: 'bucket-missing', phase: 'unknown', recovery: 'fail' },
  },
  {
    id: 'history-403-alongside-a-real-failure',
    incident:
      'Pulumi records FAILED updates in history too — a history 403 can co-occur with a genuinely failed update',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e3 --non-interactive',
      [
        'error: update failed',
        'error: saving update info: blob (key ".pulumi/history/vibecarbon/e3/e3-17855.history.json") (code=Unknown): AccessDenied: status code: 403',
      ].join('\n'),
    ),
    expect: { cause: 'unknown', phase: 'unknown', recovery: 'fail' },
  },
  {
    id: 'nosuchkey-on-a-state-key-is-not-a-lock',
    incident:
      'The lock-blob widening must never opt in a NoSuchKey on a state/checkpoint key. Without the `failed to load checkpoint` prefix there is no proof this was the pre-plan read, so a missing STATE read stays a real answer — the same reasoning that keeps NoSuchBucket off the destroy path.',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e1 --non-interactive',
      'error: blob (key ".pulumi/stacks/vibecarbon/e1.json") (code=NotFound): NoSuchKey: status code: 404',
    ),
    expect: { cause: 'unknown', phase: 'unknown', recovery: 'fail' },
  },
  {
    // Review finding 2026-08-15: the lock-blob 404 used to be reachable only
    // via extraPattern, which destroy-path calls never pass — so on destroy it
    // failed fast. The classifier must preserve that: retrying a lock-blob 404
    // on destroy burns ~30s before the same answer, and destroy-path
    // conservatism is the rule that no signature may override.
    id: 'destroy-lock-blob-404-stays-fatal',
    incident: 'Classifier hole: destroy ops never opted lock-blob 404s into retry',
    operation: 'destroy',
    message: envelope(
      'destroy',
      '--stack e1 --non-interactive',
      'error: blob (key ".pulumi/locks/organization/vibecarbon/e1/9bba65d9.json") (code=NotFound): NoSuchKey: status code: 404',
    ),
    expect: { cause: 'lock-blob-missing', phase: 'pre-mutation', recovery: 'fail' },
  },
  {
    // Review finding 2026-08-15: verb 'stack' is not proof of the post-update
    // outputs read — `pulumi stack select` fails PRE-mutation with identical
    // text. Only `stack output` carries the post-mutation proof; any other
    // stack subcommand must land on the fail-safe.
    id: 'stack-select-404-is-not-post-mutation',
    incident: 'Classifier hole: `pulumi stack select` was read as the post-up outputs read',
    operation: 'stack-select',
    message: [
      'Command failed with exit code 255: pulumi stack select --stack e1 --non-interactive',
      "error: no stack named 'e1' found",
    ].join('\n'),
    expect: { cause: 'stack-file-missing', phase: 'unknown', recovery: 'fail' },
  },
  {
    id: 'ordinary-provider-error',
    incident: 'A plain provider failure must not look like anything storage-related',
    operation: 'up',
    message: envelope(
      'up',
      '--stack e1 --non-interactive',
      'error: hcloud/server: resource_unavailable: server type cx23 is unavailable in fsn1',
    ),
    expect: { cause: 'unknown', phase: 'unknown', recovery: 'fail' },
  },
];
