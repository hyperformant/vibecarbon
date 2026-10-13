/**
 * The deploy's "can the operator sign in?" gate, shared by every deploy mode.
 *
 * The app creates its own super admin at startup from ADMIN_EMAIL and
 * ADMIN_PASSWORD (carbon/src/server/auth/bootstrap-admin.ts, under a
 * cross-replica advisory lock; db/startup.ts waits on the schema, the
 * connection and a read-only standby) and reports it on `GET /api/health`
 * as `adminReady` plus `adminStatus` (pending | ready | skipped | refused |
 * failed). A deploy therefore has two jobs and no auth API to call: make
 * sure those two keys (plus BETTER_AUTH_SECRET) reach the app container,
 * then wait for the app to say the admin exists. It stops at the first
 * skipped, refused or failed: those need the operator (failed is retried
 * inside the app, but only fixing its cause makes it pass). Only the transport
 * differs per mode:
 *   - compose / compose-ha: `docker compose exec -T app node -` over SSH.
 *   - k8s / k8s-ha:         `kubectl exec deploy/app -c app -- node -e`.
 *
 * The probe runs INSIDE the app container with the app's own `node`, so it
 * needs no curl/wget in the image and no tunnel, port-forward, DNS or TLS.
 */

/** Exit codes of the in-container probe. */
export const ADMIN_PROBE_EXIT = Object.freeze({
  READY: 0,
  /**
   * /api/health answered something other than 2xx JSON. Not 1: that is what
   * `kubectl exec` / `docker compose exec` return for their own failures.
   */
  UNHEALTHY: 8,
  /** Connection refused / reset: the server is not listening yet. */
  UNREACHABLE: 2,
  TIMEOUT: 3,
  /** Serving, but the admin bootstrap has not settled (yet). */
  ADMIN_PENDING: 4,
  /** Terminal: an existing ADMIN_EMAIL account's ownership was not proven. */
  ADMIN_REFUSED: 5,
  /** Terminal: ADMIN_EMAIL / ADMIN_PASSWORD are not set in the app. */
  ADMIN_SKIPPED: 6,
  /**
   * The last bootstrap attempt hit a non-connection error. The app keeps
   * retrying, but the cause needs the operator, so a deploy stops here.
   */
  ADMIN_FAILED: 7,
});

/** Exit codes after which polling again cannot change the answer. */
const TERMINAL = new Set([
  ADMIN_PROBE_EXIT.ADMIN_REFUSED,
  ADMIN_PROBE_EXIT.ADMIN_SKIPPED,
  ADMIN_PROBE_EXIT.ADMIN_FAILED,
]);

const PROBE_CODES = new Set(Object.values(ADMIN_PROBE_EXIT));

/**
 * @param {number|null|undefined} code
 * @returns {boolean} true when the exit code came from the probe itself (not
 *   from kubectl / docker failing to run it)
 */
export function isAdminProbeExit(code) {
  return code != null && PROBE_CODES.has(code);
}

/**
 * @param {number|null|undefined} code
 * @returns {boolean} true when the app reported a status a deploy stops on
 *   (skipped, refused, failed)
 */
export function isTerminalAdminProbeExit(code) {
  return code != null && TERMINAL.has(code);
}

/**
 * Node one-liner run inside the app container: GET localhost:3000/api/health
 * and exit 0 only when the JSON body says `adminReady: true`; a terminal
 * `adminStatus` gets its own exit code so the caller can stop waiting.
 *
 * @returns {string}
 */
export function adminReadyProbeScript() {
  const e = ADMIN_PROBE_EXIT;
  return (
    "const r=require('http').get({host:'localhost',port:3000,path:'/api/health',timeout:4000},res=>{" +
    "let b='';res.on('data',c=>{b+=c});res.on('end',()=>{" +
    `if(res.statusCode<200||res.statusCode>=300)process.exit(${e.UNHEALTHY});` +
    `let j;try{j=JSON.parse(b)}catch{process.exit(${e.UNHEALTHY})}` +
    `if(j&&j.adminReady===true)process.exit(${e.READY});` +
    `const t={refused:${e.ADMIN_REFUSED},skipped:${e.ADMIN_SKIPPED},failed:${e.ADMIN_FAILED}};` +
    `process.exit(t[j&&j.adminStatus]||${e.ADMIN_PENDING})})});` +
    `r.on('error',()=>process.exit(${e.UNREACHABLE}));` +
    `r.on('timeout',()=>{r.destroy();process.exit(${e.TIMEOUT})});`
  );
}

/**
 * Human reading of a probe exit code, for progress lines and the final error.
 *
 * @param {number|null|undefined} code
 * @returns {string}
 */
export function describeAdminProbeExit(code) {
  switch (code) {
    case ADMIN_PROBE_EXIT.READY:
      return 'super admin ready';
    case ADMIN_PROBE_EXIT.ADMIN_PENDING:
      return 'app is serving but has not reported its super admin ready';
    case ADMIN_PROBE_EXIT.ADMIN_REFUSED:
      return (
        'the app refused to make ADMIN_EMAIL a super admin: an account with that email ' +
        'already exists and its password does not match ADMIN_PASSWORD (or it has no password)'
      );
    case ADMIN_PROBE_EXIT.ADMIN_SKIPPED:
      return 'the app has no ADMIN_EMAIL / ADMIN_PASSWORD, so it created no super admin';
    case ADMIN_PROBE_EXIT.ADMIN_FAILED:
      return 'the app could not create its super admin (the app log names the error)';
    case ADMIN_PROBE_EXIT.UNHEALTHY:
      return 'app answered /api/health with an error';
    case ADMIN_PROBE_EXIT.UNREACHABLE:
      return 'app is not listening on :3000 yet';
    case ADMIN_PROBE_EXIT.TIMEOUT:
      return '/api/health timed out';
    default:
      return `probe could not run (exit ${code ?? 'unknown'})`;
  }
}

/**
 * What to tell the operator when the admin never became ready. The app logs
 * the exact cause (e.g. an existing account with that email whose password
 * does not match), so point at the log line.
 *
 * @param {string} logsCommand - how to read the app's log in this mode
 * @returns {string}
 */
export function adminNotReadyHint(logsCommand) {
  return (
    'The app creates its super admin from ADMIN_EMAIL and ADMIN_PASSWORD at startup and logs ' +
    `why when it cannot. Read the app log (${logsCommand}) for the "super admin" line, fix ` +
    'the cause, then deploy again.'
  );
}
