/**
 * The deploy's "can the operator sign in?" gate, shared by every deploy mode.
 *
 * The app creates its own super admin at startup from ADMIN_EMAIL and
 * ADMIN_PASSWORD (carbon/src/server/auth/bootstrap-admin.ts) and reports the
 * outcome as `adminReady` on `GET /api/health`. A deploy therefore has two
 * jobs and no auth API to call: make sure those two keys (plus
 * BETTER_AUTH_SECRET) reach the app container, then wait for the app to say
 * the admin exists. Only the transport differs per mode:
 *   - compose / compose-ha: `docker compose exec -T app node -` over SSH.
 *   - k8s / k8s-ha:         `kubectl exec deploy/app -c app -- node -e`.
 *
 * The probe runs INSIDE the app container with the app's own `node`, so it
 * needs no curl/wget in the image and no tunnel, port-forward, DNS or TLS.
 */

/** Exit codes of the in-container probe. */
export const ADMIN_PROBE_EXIT = Object.freeze({
  READY: 0,
  /** /api/health answered something other than 2xx JSON. */
  UNHEALTHY: 1,
  /** Connection refused / reset: the server is not listening yet. */
  UNREACHABLE: 2,
  TIMEOUT: 3,
  /** Serving, but the admin bootstrap has not succeeded (yet). */
  ADMIN_PENDING: 4,
});

/**
 * Node one-liner run inside the app container: GET localhost:3000/api/health
 * and exit 0 only when the JSON body says `adminReady: true`.
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
    `process.exit(j&&j.adminReady===true?${e.READY}:${e.ADMIN_PENDING})})});` +
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
