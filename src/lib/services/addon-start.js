/**
 * Add-ons off the deploy's critical path (compose and compose-ha primary).
 *
 * The app does not need observability, n8n or metabase to serve, so a deploy
 * pulls and starts only the core stack, waits for it, and reports the app
 * live; the add-ons come up in a detached job on the server
 * (addons-start.sh, started by reconcile.sh), which records each add-on's
 * state in `.vc-addons/status` for `vibecarbon status` and the e2e harness.
 *
 * Nothing here is a hand list:
 *   - The add-ons and their compose services come from each add-on's
 *     manifest (standby.compose.services / .setup, the same declaration the HA
 *     standby policy reads).
 *   - An add-on the app itself is wired to (its compose overlay extends the
 *     `app` service, as redis does with REDIS_URL) is core: the app needs it
 *     to serve, so it starts with the stack.
 *   - Core is everything else in the rendered stack: reconcile.sh asks
 *     `docker compose config --services` and removes the deferred names.
 * tests/unit/services/addon-start.test.ts classifies every service in the
 * base compose files and every add-on overlay against this.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAddonStandby } from './standby-policy.js';

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'services');

/** The node-side dir the add-on job keeps its state in (project dir relative). */
export const ADDON_STATE_DIR = '.vc-addons';
/** One line per add-on: `<name>\t<starting|running|failed>\t<reason>`. */
export const ADDON_STATUS_FILE = `${ADDON_STATE_DIR}/status`;
/** The detached job reconcile.sh starts after the core stack is up. */
export const ADDON_JOB_SCRIPT = 'addons-start.sh';
/** Prints the compose services this node defers to the job (none on a standby). */
export const ADDON_SERVICES_SCRIPT = 'addon-services.sh';
/** Upper bound the job gives one add-on to become healthy (compose --wait). */
export const ADDON_WAIT_TIMEOUT_S = 900;

export const ADDON_STATES = ['starting', 'running', 'failed', 'stopped'];

/** The compose overlay files an add-on ships (dev overrides excluded). */
function overlayTexts(name) {
  return ['docker-compose.yml', 'docker-compose.prod.yml']
    .map((f) => join(SERVICES_DIR, name, 'compose', f))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'));
}

/**
 * Whether an add-on's compose overlay extends the `app` service: then the app
 * is wired to it and it is core. A top-level `  app:` key under `services:`
 * (two-space indent, the compose files' style; the census checks this
 * reading against a real YAML parse of every overlay).
 */
export function addonWiresApp(name) {
  return overlayTexts(name).some((text) => /^ {2}app:\s*(#.*)?$/m.test(text));
}

/**
 * The enabled add-ons this deploy starts in the background, in the order
 * given, each with its long-running services and its one-shot setups.
 *
 * @param {string[]} names enabled add-on names
 * @returns {Array<{name: string, services: string[], setup: string[]}>}
 */
export function backgroundAddons(names) {
  return names
    .filter((name) => !addonWiresApp(name))
    .map((name) => {
      const { composeServices, composeSetup } = loadAddonStandby(name);
      return { name, services: composeServices, setup: composeSetup };
    })
    .filter((a) => a.services.length + a.setup.length > 0);
}

/** Every compose service the job owns, for the core/add-on split. */
export function backgroundAddonServices(names) {
  return backgroundAddons(names).flatMap((a) => [...a.services, ...a.setup]);
}

/**
 * Parse `.vc-addons/status`. Unknown states and malformed lines are dropped.
 * @param {string} text
 * @returns {Array<{name: string, state: 'starting'|'running'|'failed', reason: string}>}
 */
export function parseAddonStatus(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([name, state]) => name && ADDON_STATES.includes(state))
    .map(([name, state, ...reason]) => ({ name, state, reason: reason.join(' ').trim() }));
}

/**
 * The remote read `vibecarbon status` and the e2e check run on a node: the
 * status file, then `#live` when the recorded job pid really is the job (a
 * /proc cmdline match: a recycled pid is not).
 * @param {string} projectName
 */
export function ADDON_STATUS_READ_CMD(projectName) {
  const dir = `/opt/${projectName}/${ADDON_STATE_DIR}`;
  return (
    `cat ${dir}/status 2>/dev/null; ` +
    `if [ -f ${dir}/job.pid ] && grep -q ${ADDON_JOB_SCRIPT} "/proc/$(cat ${dir}/job.pid)/cmdline" 2>/dev/null; ` +
    `then echo '#live'; fi; true`
  );
}

/**
 * Parse ADDON_STATUS_READ_CMD's output.
 * @param {string} text
 * @returns {{started: number|null, live: boolean, addons: ReturnType<typeof parseAddonStatus>}}
 */
export function parseAddonStatusFile(text) {
  const lines = String(text ?? '').split('\n');
  const stamp = lines.map((l) => /^#started (\d+)$/.exec(l.trim())).find(Boolean);
  return {
    started: stamp ? Number(stamp[1]) : null,
    live: lines.some((l) => l.trim() === '#live'),
    addons: parseAddonStatus(text),
  };
}

/**
 * Each expected add-on's state, from the job's status file when it is
 * current, else from the add-ons' own containers.
 *
 * The file is current when the job that wrote it started at or after
 * `notBeforeMs` (the env's last deploy attempt or failover): a promoted node
 * that never ran the job has no file, and after a failback the re-promoted
 * node can hold one from before, which must not read as a pass. An add-on the
 * file still says is starting while no job is alive reads `stopped`.
 *
 * @param {object} o
 * @param {string} o.text ADDON_STATUS_READ_CMD output
 * @param {Array<{name: string, services: string[]}>} o.expected
 * @param {number} o.notBeforeMs
 * @param {Map<string, {health: string, label: string}>} [o.containers] by service
 */
export function resolveAddonStates({ text, expected, notBeforeMs, containers = new Map() }) {
  const file = parseAddonStatusFile(text);
  const current = file.started !== null && file.started * 1000 >= (notBeforeMs || 0);
  if (current) {
    const by = new Map(file.addons.map((a) => [a.name, a]));
    return expected.map(({ name }) => {
      const a = by.get(name) ?? { name, state: 'starting', reason: '' };
      if (a.state === 'starting' && !file.live) {
        return { name, state: 'stopped', reason: `the add-on job stopped before ${name} came up` };
      }
      return { name, state: a.state, reason: a.reason };
    });
  }
  return expected.map(({ name, services }) => {
    const missing = services.find((svc) => !containers.has(svc));
    if (missing) return { name, state: 'stopped', reason: `no ${missing} container` };
    const bad = services.find((svc) => containers.get(svc).health === 'unhealthy');
    if (bad) return { name, state: 'failed', reason: `${bad} ${containers.get(bad).label}` };
    if (services.every((svc) => containers.get(svc).health === 'healthy')) {
      return { name, state: 'running', reason: '' };
    }
    return { name, state: 'starting', reason: 'no add-on status; from its containers' };
  });
}

/**
 * addon-services.sh: prints the services this node defers to the add-on job,
 * one per line. Nothing on a compose-ha standby (`.env` WALG_ROLE=standby),
 * which keeps today's behaviour there: one whole-stack up, with the
 * primary-only add-ons held at zero by standby-scale.sh.
 * @param {string[]} services
 */
export function renderAddonServicesScript(services) {
  const list = services.length ? `printf '%s\\n' ${services.join(' ')}\n` : '';
  return `#!/bin/sh
# Generated by Vibecarbon. Prints the add-on services reconcile.sh leaves to
# ${ADDON_JOB_SCRIPT} (started in the background once the core stack is up).
# Nothing on a compose-ha standby: it starts the whole stack as it always has.
role=$(grep '^WALG_ROLE=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\\"'[:space:]")
[ "$role" = standby ] && exit 0
${list}exit 0
`;
}

/**
 * addons-start.sh: the detached add-on job. One run at a time: a newer run
 * (the next deploy's reconcile) stops the older one's process group first.
 * Per add-on: pull its images (never the app's local-only image, the same
 * filter as the stack pull), `up -d --wait` its services, run its one-shot
 * setups to completion, and record `running`, or `failed` with the reason;
 * the output goes to `.vc-addons/<name>.log`, with the services' log tail on a
 * failure.
 *
 * @param {string} projectName
 * @param {string} composeFlags the deploy's baked `-f` set (reconcile.sh's)
 * @param {Array<{name: string, services: string[], setup: string[]}>} addons
 */
export function renderAddonJobScript(projectName, composeFlags, addons) {
  const runs = addons
    .map((a) => `run_addon ${a.name} '${a.services.join(' ')}' '${a.setup.join(' ')}'`)
    .join('\n');
  const starting = addons.map((a) => `set_status ${a.name} starting ''`).join('\n');
  return `#!/bin/sh
# Generated by Vibecarbon. Starts the add-ons after the core stack is up, in
# the background (reconcile.sh runs this under setsid nohup), and records each
# add-on's state in ${ADDON_STATUS_FILE} for \`vibecarbon status\`.
cd "\${VC_PROJECT_DIR:-/opt/${projectName}}" || exit 1
dir=${ADDON_STATE_DIR}
mkdir -p "$dir"

# One job at a time. stop_job ends the recorded job and waits until it is
# gone, so the caller's compose operation never overlaps it: a newer run, and
# \`${ADDON_JOB_SCRIPT} stop\`, which reconcile.sh and the scale cutover run
# before their own. Only a process whose command line is this script is
# killed: a recorded pid can be recycled by an unrelated process.
stop_job() {
  [ -f "$dir/job.pid" ] || return 0
  old=$(cat "$dir/job.pid")
  if [ -z "$old" ] || [ "$old" = "$$" ]; then return 0; fi
  case "$(tr '\\000' ' ' < "/proc/$old/cmdline" 2>/dev/null)" in
    *${ADDON_JOB_SCRIPT}*) ;;
    *)
      rm -f "$dir/job.pid"
      return 0
      ;;
  esac
  kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true
  # Bounded wait for it to go; past the bound, KILL the same verified group
  # (and the pid), so no job keeps running once its pid file is dropped.
  if ! timeout "\${VC_ADDON_STOP_WAIT:-60}" tail --pid="$old" -f /dev/null 2>/dev/null; then
    kill -KILL -- "-$old" 2>/dev/null || kill -KILL "$old" 2>/dev/null || true
  fi
  rm -f "$dir/job.pid"
}
if [ "\${1:-}" = stop ]; then
  stop_job
  exit 0
fi
# promoted: a compose-ha failover runs this on the node it promoted. The
# one-shot setups do not run there: the replicated database already holds
# their work.
skip_setup=""
[ "\${1:-}" = promoted ] && skip_setup=1
stop_job
echo "$$" > "$dir/job.pid"

# The -f set, resolved at EVERY call: compose-ha writes the replication
# overlay after the core up, while this job runs, and a stale set would
# render db without it.
# shellcheck disable=SC2046,SC2086 # the -f set is a word list
dc() { docker compose ${composeFlags} $([ -f docker-compose.replication.yml ] && echo '-f docker-compose.replication.yml') "$@"; }

# <name> <state> <reason>: replace the add-on's line, atomically.
set_status() {
  tmp="$dir/status.$$"
  { [ -f "$dir/status" ] && grep -v "^$1	" "$dir/status"; printf '%s\\t%s\\t%s\\n' "$1" "$2" "$(printf '%s' "$3" | tr '\\t\\n' '  ')"; } > "$tmp"
  mv "$tmp" "$dir/status"
}

app_image=$(dc config --images app 2>/dev/null)

# <name> '<services>' '<setup services>'
run_addon() {
  name=$1
  services=$2
  setup=$3
  if [ -n "$skip_setup" ]; then setup=""; fi
  log="$dir/$name.log"
  : > "$log"
  pull=""
  for s in $services $setup; do
    [ "$(dc config --images "$s" 2>/dev/null)" = "$app_image" ] || pull="$pull $s"
  done
  # shellcheck disable=SC2086 # service word lists
  if [ -n "$pull" ] && ! dc pull --policy missing $pull >> "$log" 2>&1; then
    set_status "$name" failed "image pull failed: $(tail -n 1 "$log")"
    return
  fi
  # shellcheck disable=SC2086
  # --no-deps on every up: the add-ons depend on db, and the job must never
  # recreate a core service (reconcile.sh owns those).
  if [ -n "$services" ] && ! dc up -d --no-deps --wait --wait-timeout ${ADDON_WAIT_TIMEOUT_S} $services >> "$log" 2>&1; then
    reason=$(tail -n 1 "$log")
    dc logs --tail 40 $services >> "$log" 2>&1
    set_status "$name" failed "did not become healthy: $reason"
    return
  fi
  for s in $setup; do
    if ! dc up -d --no-deps "$s" >> "$log" 2>&1; then
      set_status "$name" failed "setup $s did not start: $(tail -n 1 "$log")"
      return
    fi
    rc=$(docker wait "$(dc ps -aq "$s")" 2>> "$log")
    if [ "$rc" != 0 ]; then
      dc logs --tail 40 "$s" >> "$log" 2>&1
      set_status "$name" failed "setup $s exited \${rc:-?}: $(tail -n 1 "$log")"
      return
    fi
  done
  set_status "$name" running ''
}

# This run's add-ons only: an add-on removed since the last deploy drops out.
# The first line stamps when this run started (server clock): a reader treats
# a file from before the current deploy or failover as stale.
printf '#started %s\n' "$(date +%s)" > "$dir/status"
${starting}
${runs}
[ "$(cat "$dir/job.pid" 2>/dev/null)" = "$$" ] && rm -f "$dir/job.pid"
exit 0
`;
}
