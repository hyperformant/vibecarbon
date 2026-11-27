/**
 * At the join deadline, a server that never registered but whose private
 * address answered port 22 in the probe from the k3s server
 * (node-join-probe.js) is read from the inside: one ssh to that private
 * address, hopping through the k3s server, for a handful of named facts.
 * What comes back is logged as `[node-join] on the node itself: ...` lines,
 * and one sentence reading those facts is added to that node's line in the
 * failure (clusterProbe's `readNode`).
 *
 * WHY (Vultr run 45994716507, 2026-11-27 14:21Z): the k8s-ha standby's
 * database node at 66.42.120.170 never registered. Vultr said it was running,
 * and the probe from the k3s server got `ping 2/2, port 22 open` on its
 * private address 10.159.218.4 and nothing on its public one, while every ssh
 * from the runner to the public address timed out. Its boot script installs
 * k3s from https://get.k3s.io, so it needs the internet. From outside, three
 * causes look the same:
 *
 *   a. the guest's public interface has no address, or no default route, or
 *      the default route goes the wrong way;
 *   b. the guest's network is set up, but the provider's public network for
 *      it passes nothing;
 *   c. the boot script failed or stalled for another reason, and the public
 *      silence has a cause of its own.
 *
 * Only the guest can tell them apart, and the rig is destroyed at teardown,
 * so this is read on the failure path or never. Four database nodes have
 * gone this way (Hetzner fsn1 2026-11-06, Hetzner nbg1 2026-11-27, Vultr ord
 * in runs 45956890734 and 45994716507).
 *
 * What it reads (nodeReadScript), one line each: the boot marks in
 * /var/log/vcboot (boot-timing.js), `cloud-init status` and its errors, each
 * interface's state and IPv4 addresses, the default IPv4 routes, networkctl's
 * state per interface, a TCP connect to 1.1.1.1:443, a lookup of get.k3s.io,
 * an HTTPS GET of https://get.k3s.io, whether the metadata service answers,
 * and at most 10 failure lines from cloud-init's output log. It runs only
 * read-only commands and sends nothing secret.
 *
 * Secrets: everything it prints is redacted before any of it is parsed or
 * logged (redactNodeRead): the cluster's k3s token, anything shaped like a
 * k3s token (`K10<hex>`), credential-shaped assignments (redactCredentials),
 * and every line that says `password` is dropped. The metadata service's
 * body is never printed, only whether it answered.
 *
 * Diagnosis only: one ssh per node, bounded at NODE_READ_BUDGET_MS, never
 * retried, and it never throws into the failure it describes. Nothing is
 * rebooted or replaced (no retry ladder).
 */

import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { runCommandAsync } from '../../command.js';
import { SSH_CONNECTION_OPTS } from '../../host-keys.js';
import { redactCredentials } from '../../redact-credentials.js';
import { shEscape } from '../../shell.js';
import { withTempDir } from '../../temp-dir.js';
import { BOOT_MARK_LOG, BOOT_STAGE_LABELS } from '../boot-timing.js';
import { boundedRun, whyRunFailed } from './node-join-probe.js';

/** The bound on the whole read of one node: one ssh, both hops, every check. */
export const NODE_READ_BUDGET_MS = 25_000;

/** Where cloud-init writes the user-data script's output (our boot scripts). */
const CLOUD_INIT_OUTPUT_LOG = '/var/log/cloud-init-output.log';

/**
 * What the boot scripts install k3s from, and so what the read fetches: named
 * in the facts and the failure as the target of a check, not a link to open.
 */
const K3S_INSTALL_URL = 'https://get.k3s.io';

/** How many failure lines of cloud-init's output log the read keeps. */
const OUTPUT_LINES = 10;

/** The failure words our boot scripts print (carbon/cloud-init/k3s/*-init.sh) and curl's own. */
const FAILURE_WORDS = 'install attempt|install failed|FATAL|ERROR|Warning: Master|curl:';

/** The bounds on the outbound checks, under `timeout`. */
const TCP_CHECK_S = 3;
const DNS_CHECK_S = 3;
const HTTPS_MAX_S = 5;
const HTTPS_CHECK_S = HTTPS_MAX_S + 1;
const METADATA_CHECK_S = 3;

/** The mark that opens the k3s install, and the one that ends a boot that finished. */
const INSTALL_MARK = 'k';
const DONE_MARK = 'e';

/** Plain words for each boot mark (boot-timing.js), with the last one's. */
const MARK_WORDS = { ...BOOT_STAGE_LABELS, [DONE_MARK]: 'done' };

/**
 * The script the node runs (`sh -s`). The local facts come first, so a read
 * its bound stops still has them; then the four outbound checks at once,
 * each printing its one line when it is done. Nothing here writes on the
 * node, and stderr goes nowhere: what a command says on stderr is captured
 * where it is a fact (the TCP connect's error, curl's), never printed raw.
 * The paths are parameters only so a test can point them at its own files.
 *
 * @param {{ bootLog?: string, outputLog?: string }} [paths]
 * @returns {string}
 */
export function nodeReadScript({
  bootLog = BOOT_MARK_LOG,
  outputLog = CLOUD_INIT_OUTPUT_LOG,
} = {}) {
  return [
    'exec 2>/dev/null',
    `log=${shEscape(bootLog)}`,
    `out=${shEscape(outputLog)}`,
    'if [ -f "$log" ]; then',
    '  echo "marks found"',
    `  awk 'NF { print "mark", $1 }' "$log"`,
    'else',
    "  echo 'marks none'",
    'fi',
    'if command -v cloud-init >/dev/null; then',
    `  echo "cloud-init $(timeout 5 cloud-init status | sed -n 's/^status: *//p' | head -n 1)"`,
    `  echo "cloud-init-json $(timeout 5 cloud-init status --format json | tr -d '\\n')"`,
    'else',
    "  echo 'cloud-init -'",
    'fi',
    "ip -br link | sed 's/^/link /'",
    "ip -br -4 addr | sed 's/^/addr /'",
    'routes=$(ip -4 route show default)',
    `if [ -n "$routes" ]; then printf '%s\\n' "$routes" | sed 's/^/route /'; else echo 'route none'; fi`,
    'if command -v networkctl >/dev/null; then',
    "  timeout 3 networkctl list --no-pager --no-legend | sed 's/^/networkctl /'",
    'else',
    "  echo 'networkctl -'",
    'fi',
    'if [ -f "$out" ]; then',
    `  grep -a -E ${shEscape(FAILURE_WORDS)} "$out" | tail -n ${OUTPUT_LINES} | sed 's/^/log /'`,
    'fi',
    // Only bash has /dev/tcp; the connect runs in a bash of its own.
    'check_tcp() {',
    `  err=$(timeout ${TCP_CHECK_S} bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>&1 >/dev/null)`,
    '  case $? in',
    '    0) r=open ;;',
    '    124) r=timeout ;;',
    '    *) case $err in',
    '         *refused*) r=refused ;;',
    "         *unreachable*|*'No route'*) r=unreachable ;;",
    '         *) r=error ;;',
    '       esac ;;',
    '  esac',
    '  echo "tcp443 $r"',
    '}',
    'check_dns() {',
    `  res=$(timeout ${DNS_CHECK_S} getent hosts get.k3s.io)`,
    '  rc=$?',
    `  echo "dns rc=$rc $(printf '%s\\n' "$res" | awk 'NR == 1 { print $1 }')"`,
    '}',
    // curl's error goes to stderr and its -w code to stdout; both are kept,
    // on one line.
    'check_https() {',
    `  res=$(timeout ${HTTPS_CHECK_S} curl -sS -o /dev/null -m ${HTTPS_MAX_S} -w '%{http_code}' https://get.k3s.io 2>&1)`,
    '  rc=$?',
    `  echo "https rc=$rc $(printf '%s' "$res" | tr '\\n' ' ')"`,
    '}',
    // The body goes to /dev/null: only whether it answered, and with what code.
    'check_metadata() {',
    `  res=$(timeout ${METADATA_CHECK_S} curl -sS -o /dev/null -w '%{http_code}' http://169.254.169.254/)`,
    '  rc=$?',
    '  echo "metadata rc=$rc $res"',
    '}',
    'check_tcp &',
    'check_dns &',
    'check_https &',
    'check_metadata &',
    'wait',
    "echo 'read done'",
    '',
  ].join('\n');
}

const REDACTED = '<redacted>';

/** A k3s token's shape: `K10` and the CA hash, with its `::user:password` tail when there is one. */
const K3S_TOKEN_SHAPE = /K10[0-9a-f]{20,}(?:::[^\s'"]*)?/g;

/**
 * What the read printed, with nothing secret left: every line that says
 * `password` (in any case) is dropped, and in the rest each occurrence of a
 * secret the deploy holds (the cluster's k3s token), anything shaped like a
 * k3s token, and credential-shaped assignments are replaced. Runs on the raw
 * output before any of it is parsed or logged.
 *
 * @param {string} text
 * @param {Array<string|null|undefined>} [secrets]
 * @returns {string}
 */
export function redactNodeRead(text, secrets = []) {
  const known = secrets.filter((s) => typeof s === 'string' && s !== '');
  return String(text ?? '')
    .split('\n')
    .filter((line) => !/password/i.test(line))
    .map((line) => {
      let out = line;
      for (const secret of known) out = out.split(secret).join(REDACTED);
      return redactCredentials(out.replace(K3S_TOKEN_SHAPE, REDACTED));
    })
    .join('\n');
}

/**
 * @typedef {{ name: string, state: string|null, addrs: string[] }} NodeInterface
 * @typedef {{ via?: string, dev?: string }} DefaultRoute
 * @typedef {{ link: string, operational: string, setup: string }} NetworkdLink
 * @typedef {{ status: string|null, extended?: string, errors: string[] }} CloudInitStatus
 * @typedef {{ rc: number, code: string|null, error: string|null }} CurlOutcome
 * @typedef {'open' | 'timeout' | 'refused' | 'unreachable' | 'error'} TcpOutcome
 */
/**
 * What the read found. A field that is undefined was not reported (the read
 * stopped first); null is reported missing (no boot log, no cloud-init, no
 * networkctl on the node).
 * @typedef {object} NodeReadFacts
 * @property {boolean} done - the script ran to its last line
 * @property {string[]|null} [marks]
 * @property {CloudInitStatus|null} [cloudInit]
 * @property {NodeInterface[]} [interfaces]
 * @property {DefaultRoute[]} [routes]
 * @property {NetworkdLink[]|null} [networkctl]
 * @property {TcpOutcome} [tcp443]
 * @property {{ rc: number, address: string|null }} [dns]
 * @property {CurlOutcome} [https]
 * @property {{ rc: number, code: string|null }} [metadata]
 * @property {string[]} outputLines - failure lines from cloud-init's output log
 */

const TCP_OUTCOMES = new Set(['open', 'timeout', 'refused', 'unreachable', 'error']);
const CIDR4 = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;
const MARK_ID = /^[A-Za-z0-9._-]{1,20}$/;

/** A cut to one bounded line. */
const clip = (s, n = 200) => String(s).slice(0, n);

/** curl's `-w '%{http_code}'` code and its error line, from what it printed on both streams. */
function curlOutcome(rc, printed) {
  let rest = printed.trim();
  let code = null;
  const first = rest.match(/^(\d{3})(?=curl:|\s|$)/);
  const last = first ? null : rest.match(/(?:^|\s)(\d{3})$/);
  if (first) {
    code = first[1];
    rest = rest.slice(3).trim();
  } else if (last) {
    code = last[1];
    rest = rest.slice(0, last.index).trim();
  }
  return { rc, code, error: rest ? clip(rest) : null };
}

/** cloud-init's JSON status, when it is readable: its extended status and errors. */
function cloudInitJson(text) {
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') return null;
    return {
      ...(typeof json.extended_status === 'string' && { extended: clip(json.extended_status, 60) }),
      ...(typeof json.status === 'string' && { status: clip(json.status, 60) }),
      errors: Array.isArray(json.errors) ? json.errors.slice(0, 3).map((e) => clip(e)) : [],
    };
  } catch {
    return null;
  }
}

/**
 * The fact lines in what the read printed (after redactNodeRead); anything
 * else (an ssh warning, a line cut off) is ignored.
 * @param {string} stdout
 * @returns {NodeReadFacts}
 */
export function parseNodeRead(stdout) {
  /** @type {NodeReadFacts} */
  const f = { done: false, outputLines: [] };
  const iface = (name) => {
    f.interfaces ??= [];
    let found = f.interfaces.find((i) => i.name === name);
    if (!found) {
      found = { name, state: null, addrs: [] };
      f.interfaces.push(found);
    }
    return found;
  };
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.trim();
    const key = line.split(/\s/, 1)[0];
    const value = line.slice(key.length).trim();
    const words = value.split(/\s+/).filter(Boolean);
    switch (key) {
      case 'marks':
        if (value === 'none') f.marks = null;
        else if (value === 'found') f.marks ??= [];
        break;
      case 'mark':
        if (words.length === 1 && MARK_ID.test(words[0])) {
          f.marks ??= [];
          f.marks.push(words[0]);
        }
        break;
      case 'cloud-init':
        f.cloudInit =
          value === '-'
            ? null
            : { status: /^[a-z][a-z ]{0,30}$/.test(value) ? value : null, errors: [] };
        break;
      case 'cloud-init-json': {
        const json = f.cloudInit && cloudInitJson(value);
        if (json) f.cloudInit = { ...json, status: f.cloudInit?.status ?? json.status ?? null };
        break;
      }
      case 'link':
      case 'addr': {
        const [name, state, ...rest] = words;
        if (!name || !state) break;
        const i = iface(name.replace(/@.*$/, ''));
        i.state ??= state;
        if (key === 'addr') i.addrs = rest.filter((a) => CIDR4.test(a));
        break;
      }
      case 'route':
        f.routes ??= [];
        if (value !== 'none' && words[0] === 'default') {
          const at = (w) => (words.includes(w) ? words[words.indexOf(w) + 1] : undefined);
          f.routes.push({
            ...(at('via') && { via: at('via') }),
            ...(at('dev') && { dev: at('dev') }),
          });
        }
        break;
      case 'networkctl':
        if (value === '-') f.networkctl = null;
        else if (/^\d+$/.test(words[0] ?? '') && words.length >= 5) {
          f.networkctl ??= [];
          f.networkctl.push({ link: words[1], operational: words[3], setup: words[4] });
        }
        break;
      case 'tcp443':
        if (TCP_OUTCOMES.has(value)) f.tcp443 = /** @type {TcpOutcome} */ (value);
        break;
      case 'dns': {
        const m = value.match(/^rc=(\d+)(?:\s+(\S+))?$/);
        if (m) f.dns = { rc: Number(m[1]), address: m[2] && isIPv4(m[2]) ? m[2] : null };
        break;
      }
      case 'https': {
        const m = value.match(/^rc=(\d+)(?:\s(.*))?$/);
        if (m) f.https = curlOutcome(Number(m[1]), m[2] ?? '');
        break;
      }
      case 'metadata': {
        const m = value.match(/^rc=(\d+)(?:\s+(\S*))?$/);
        if (m) f.metadata = { rc: Number(m[1]), code: /^\d{3}$/.test(m[2] ?? '') ? m[2] : null };
        break;
      }
      case 'log':
        if (value && f.outputLines.length < OUTPUT_LINES) f.outputLines.push(clip(value, 300));
        break;
      case 'read':
        if (value === 'done') f.done = true;
        break;
      default:
        break;
    }
  }
  return f;
}

/** Whether the read reported anything at all. */
function reportedAnything(f) {
  return (
    f.done ||
    f.outputLines.length > 0 ||
    [
      'marks',
      'cloudInit',
      'interfaces',
      'routes',
      'networkctl',
      'tcp443',
      'dns',
      'https',
      'metadata',
    ].some((k) => f[k] !== undefined)
  );
}

/** An HTTP status curl got back: any three digits but 000, which is no answer. */
const answeredHttp = (code) => Boolean(code && code !== '000');

/** An answer the k3s install script's download takes: 2xx or 3xx. */
const fetched = (code) => /^[23]\d\d$/.test(code ?? '');

const TCP_FACT = {
  open: 'open',
  timeout: `no answer in ${TCP_CHECK_S}s`,
  refused: 'refused',
  unreachable: 'no route',
  error: 'could not run',
};

/** `boot marks p n w k; the last is k, installing Kubernetes`. */
function marksFact(marks) {
  if (marks === null) return `boot marks: none (${BOOT_MARK_LOG} is not there)`;
  if (marks.length === 0) return `boot marks: none yet (${BOOT_MARK_LOG} is empty)`;
  const last = marks.at(-1);
  const words = Object.hasOwn(MARK_WORDS, last) ? `, ${MARK_WORDS[last]}` : '';
  return `boot marks ${marks.join(' ')}; the last is ${last}${words}`;
}

/** `cloud-init status error, extended status error, errors: ...`. */
function cloudInitFact(ci) {
  if (ci === null) return 'cloud-init: not on this node';
  const parts = [`cloud-init status ${ci.status ?? 'not reported'}`];
  if (ci.extended && ci.extended !== ci.status) parts.push(`extended status ${ci.extended}`);
  if (ci.errors.length > 0) parts.push(`errors: ${ci.errors.join('; ')}`);
  return parts.join(', ');
}

function dnsFact(dns) {
  if (dns.rc === 0)
    return dns.address ? `get.k3s.io resolves to ${dns.address}` : 'get.k3s.io resolves';
  if (dns.rc === 124) return `get.k3s.io: no answer in ${DNS_CHECK_S}s`;
  return `get.k3s.io does not resolve (getent exit ${dns.rc})`;
}

function httpsFact(https) {
  if (answeredHttp(https.code)) return `HTTP ${https.code}`;
  if (https.error) return https.error;
  if (https.rc === 124) return `no answer in ${HTTPS_CHECK_S}s`;
  return `curl exit ${https.rc}`;
}

function metadataFact(md) {
  if (answeredHttp(md.code)) return `answered HTTP ${md.code}`;
  if (md.rc === 124) return `no answer in ${METADATA_CHECK_S}s`;
  return `no answer (curl exit ${md.rc})`;
}

/**
 * One named fact a line, for the `[node-join] on the node itself:` log
 * lines: never a raw dump. The loopback interface is left out.
 * @param {NodeReadFacts} f
 * @returns {string[]}
 */
export function nodeReadFacts(f) {
  const out = [];
  if (f.marks !== undefined) out.push(marksFact(f.marks));
  if (f.cloudInit !== undefined) out.push(cloudInitFact(f.cloudInit));
  for (const i of f.interfaces ?? []) {
    if (i.name === 'lo') continue;
    const addrs = i.addrs.length > 0 ? `IPv4 ${i.addrs.join(' ')}` : 'no IPv4 address';
    out.push(`interface ${i.name} ${i.state ?? 'in an unknown state'}, ${addrs}`);
  }
  if (f.routes?.length === 0) out.push('no default IPv4 route');
  for (const r of f.routes ?? []) {
    out.push(`default route${r.via ? ` via ${r.via}` : ''}${r.dev ? ` dev ${r.dev}` : ''}`);
  }
  if (f.networkctl === null) out.push('networkctl: not on this node');
  for (const n of f.networkctl ?? []) {
    if (n.link !== 'lo') out.push(`networkctl ${n.link}: ${n.operational}, ${n.setup}`);
  }
  if (f.tcp443) out.push(`TCP connect to 1.1.1.1:443: ${TCP_FACT[f.tcp443]}`);
  if (f.dns) out.push(dnsFact(f.dns));
  if (f.https) out.push(`${K3S_INSTALL_URL}: ${httpsFact(f.https)}`);
  if (f.metadata) out.push(`metadata service http://169.254.169.254/: ${metadataFact(f.metadata)}`);
  for (const line of f.outputLines) out.push(`cloud-init output: ${line}`);
  return out;
}

/** `a, b and c`. */
function listed(parts) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}

const TCP_PHRASE = {
  open: 'a TCP connect to 1.1.1.1:443 opened',
  timeout: `a TCP connect to 1.1.1.1:443 got no answer in ${TCP_CHECK_S}s`,
  refused: 'a TCP connect to 1.1.1.1:443 was refused',
  unreachable: 'a TCP connect to 1.1.1.1:443 found no route',
};

function dnsPhrase(dns) {
  if (!dns) return null;
  if (dns.rc === 0)
    return dns.address ? `get.k3s.io resolves to ${dns.address}` : 'get.k3s.io resolves';
  if (dns.rc === 124) return `the lookup of get.k3s.io got no answer in ${DNS_CHECK_S}s`;
  return `get.k3s.io does not resolve (getent exit ${dns.rc})`;
}

function httpsPhrase(https) {
  if (!https) return null;
  if (answeredHttp(https.code)) return `${K3S_INSTALL_URL} answered HTTP ${https.code}`;
  if (https.error) return `${K3S_INSTALL_URL} failed with ${https.error}`;
  if (https.rc === 124) return `${K3S_INSTALL_URL} got no answer in ${HTTPS_CHECK_S}s`;
  return `${K3S_INSTALL_URL} failed (curl exit ${https.rc})`;
}

/** The output line that says most about why the boot stopped: the install's failure first. */
function failureLine(lines) {
  for (const re of [
    /install failed/,
    /install attempt/,
    /FATAL|ERROR/,
    /Warning: Master/,
    /curl:/,
  ]) {
    const hit = lines.filter((l) => re.test(l)).at(-1);
    if (hit) return hit;
  }
  return null;
}

/** `k` (installing Kubernetes). */
const mark = (id) => `\`${id}\`${Object.hasOwn(MARK_WORDS, id) ? ` (${MARK_WORDS[id]})` : ''}`;

/**
 * Where the boot got to, as the end of the sentence, with the line of
 * cloud-init's output (or cloud-init's own error) that says why. Null when
 * the read did not get to the marks.
 * @param {NodeReadFacts} f
 * @param {boolean} works - outbound works
 */
function bootClause(f, works) {
  if (f.marks === undefined) return null;
  const found = failureLine(f.outputLines);
  const line = found && clip(found);
  const ciError = f.cloudInit?.errors?.[0];
  const why = line
    ? `; its cloud-init output says "${line}"`
    : ciError
      ? `; cloud-init reports "${ciError}"`
      : '';
  // Whether the boot is over says how to word where it got to: cloud-init
  // still running is a boot that may yet go on, and one that did not report
  // is not said to have stopped.
  const status = f.cloudInit?.status ?? null;
  const running = status === 'running';
  if (f.marks === null || f.marks.length === 0) {
    const ci = status ? `; cloud-init says ${status}${ciError ? ` ("${ciError}")` : ''}` : '';
    return (
      `${works ? 'outbound works, but ' : ''}${BOOT_MARK_LOG} holds no boot marks, so its boot ` +
      `script ${running ? 'has not started' : 'never started'}` +
      `${line ? `; its cloud-init output says "${line}"` : ci}`
    );
  }
  const and = works ? 'outbound works and ' : '';
  if (f.marks.includes(DONE_MARK)) {
    return `${and}the boot finished (mark \`${DONE_MARK}\`), so the k3s install succeeded, though the node never registered${why}`;
  }
  if (!f.marks.includes(INSTALL_MARK)) {
    const reached = running
      ? 'is still running and has not reached'
      : status
        ? 'never reached'
        : 'has not reached';
    return `${and}the boot ${reached} mark ${mark(INSTALL_MARK)}: its last mark is ${mark(f.marks.at(-1))}${why}`;
  }
  const where = running ? 'is still running after' : status ? 'stopped after' : 'got as far as';
  return `${and}the boot ${where} mark ${mark(INSTALL_MARK)}${why}`;
}

/**
 * The one sentence a node's failure line gains from the read: its network
 * first (the public address, the default route, whether it reaches the
 * internet), and when that is fine or was not reached, where its boot got
 * to. Which interface is public comes from the provider's public address;
 * when no interface holds it, the sentence says that. That reading rests on
 * every provider putting the public address on the guest's own interface
 * (Scaleway's servers take a `routed_ipv4` address, never a NAT one). Null
 * when the read says nothing.
 *
 * @param {NodeReadFacts} f
 * @param {{ publicIp?: string|null, privateIp?: string|null }} addresses
 * @returns {string|null}
 */
export function nodeReadSentence(f, { publicIp = null, privateIp = null } = {}) {
  const at = 'On the node itself,';
  const ifaces = f.interfaces ?? [];
  const holder = (ip) =>
    ip ? (ifaces.find((i) => i.addrs.some((a) => a.split('/')[0] === ip))?.name ?? null) : null;
  const pub = holder(publicIp);
  const priv = holder(privateIp);

  if (publicIp && f.interfaces && !pub) {
    const others = ifaces
      .filter((i) => i.name !== 'lo' && i.name !== priv)
      .map(
        (i) =>
          `${i.name} is ${i.state ?? 'in an unknown state'} with ${i.addrs.length > 0 ? i.addrs.join(' and ') : 'no IPv4 address'}`,
      );
    const seen = others.length > 0 ? others.join(', ') : 'it has no interface but the private one';
    return `${at} no interface holds its public address ${publicIp} (${seen}), so the guest never set up its public address.`;
  }

  const holds = pub ? `${pub} holds ${publicIp}` : null;
  const viaPrivate = (r) =>
    `the default route is via ${r.dev}, the private interface (${privateIp}), so its internet traffic goes out on the private network`;
  if (f.routes) {
    if (f.routes.length === 0) {
      return `${at} ${holds ? `${holds} but there` : 'there'} is no default IPv4 route, so it cannot reach the internet.`;
    }
    if (pub && !f.routes.some((r) => r.dev === pub)) {
      const r = f.routes[0];
      if (r.dev && r.dev === priv) return `${at} ${holds} but ${viaPrivate(r)}.`;
      return (
        `${at} ${holds} but the default route is via ${r.dev ?? r.via}, not ${pub}, so its internet ` +
        'traffic does not leave by the public interface.'
      );
    }
    if (!pub && f.routes[0].dev && f.routes[0].dev === priv)
      return `${at} ${viaPrivate(f.routes[0])}.`;
  }

  const works = fetched(f.https?.code);
  const tcpOpen = f.tcp443 === 'open';
  if (!works && tcpOpen) {
    if (f.dns && f.dns.rc !== 0) {
      return `${at} it reaches the internet (${TCP_PHRASE.open}) but ${dnsPhrase(f.dns)}, so the k3s install cannot download.`;
    }
    if (f.https) {
      return (
        `${at} it reaches the internet and ${dnsPhrase(f.dns) ?? 'get.k3s.io resolves'}, but ` +
        `${httpsPhrase(f.https)}, so the k3s install cannot download.`
      );
    }
  }
  const tcpFailed = Boolean(f.tcp443 && Object.hasOwn(TCP_PHRASE, f.tcp443) && !tcpOpen);
  if (!works && !tcpOpen && (tcpFailed || f.https)) {
    const route = (pub && f.routes?.find((r) => r.dev === pub)) || f.routes?.[0];
    const where = holds
      ? `${holds}${route ? ` with the default route${route.via ? ` via ${route.via}` : ''} there` : ''}`
      : route
        ? `the default route is${route.via ? ` via ${route.via}` : ''}${route.dev ? ` on ${route.dev}` : ''}`
        : null;
    const outcomes = listed(
      [tcpFailed ? TCP_PHRASE[f.tcp443] : null, dnsPhrase(f.dns), httpsPhrase(f.https)].filter(
        Boolean,
      ),
    );
    // Set up is claimed only from both facts: the public address on its
    // interface, and the default route out of that interface.
    const setUp =
      holds && route
        ? ', so its own network is set up and its traffic goes unanswered outside it'
        : '';
    return where
      ? `${at} ${where}, but it cannot reach the internet (${outcomes})${setUp}.`
      : `${at} it cannot reach the internet (${outcomes}).`;
  }

  const boot = bootClause(f, works);
  if (boot) return `${at} ${boot}.`;
  return works ? `${at} outbound works.` : null;
}

/**
 * The inner hop's connection options: the shared ones (BatchMode, the
 * connect timeout, the keepalives) without multiplexing. A mux socket is
 * keyed on user, host and port (`%C`), not on the hop, and VPC addresses
 * repeat across clusters (10.159.218.4 was two servers in one run), so a
 * shared socket could hand this read another cluster's server.
 */
const INNER_CONNECTION_OPTS = Object.freeze([
  ...SSH_CONNECTION_OPTS.flatMap((v, i, all) =>
    v === '-o' && /^Control(Master|Path|Persist)=/.test(all[i + 1] ?? '')
      ? []
      : all[i - 1] === '-o' && /^Control(Master|Path|Persist)=/.test(v)
        ? []
        : [v],
  ),
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
]);

/**
 * One token of a ProxyCommand: quoted for the shell ssh runs it with, and
 * with every `%` doubled, since ssh expands `%` tokens in the whole line
 * first (the mux socket path's own `%C` must reach the outer ssh as written).
 */
const proxyToken = (token) => shEscape(token).replaceAll('%', '%%');

/**
 * The ssh argv for one read: to `root@<address>` (the node's private
 * address), through the k3s server.
 *
 * The hop is a ProxyCommand running the command's own ssh to the k3s server
 * (`ssh -i <key> <hostKeyOpts> -W %h:%p root@<k3s server>`), not `-J`: the
 * command line's `-i` and `-o` options never reach a ProxyJump hop. So the
 * outer hop pins the k3s server in the env's known_hosts, exactly as every
 * other ssh to it does.
 *
 * The inner hop pins the node in `knownHostsFile`, a throwaway file, with
 * accept-new, never in the env's known_hosts: VPC addresses repeat across
 * clusters, so a pinned private address would refuse a later read of
 * another server with a key mismatch. Taking the node's key on first sight
 * is acceptable here because the read sends nothing secret (the script holds
 * no token or password) and runs only read-only commands; a machine that
 * answered in its place would learn nothing and change nothing.
 *
 * `%h` reaches the shell ssh runs the ProxyCommand with, so `address` must be
 * an IPv4 literal.
 *
 * @param {object} args
 * @param {string} args.sshKeyPath
 * @param {readonly string[]} args.hostKeyOpts - the outer hop's `-o` options
 *   (buildHostKeyOpts/buildHostKeyOptsForPath, host-keys.js)
 * @param {string} args.masterIp - the k3s server
 * @param {string} args.address - the node's private address
 * @param {string} args.knownHostsFile - the inner hop's throwaway known_hosts
 * @returns {string[]}
 */
export function nodeReadArgv({ sshKeyPath, hostKeyOpts, masterIp, address, knownHostsFile }) {
  if (!isIPv4(String(address))) {
    throw new Error(`nodeReadArgv: ${address} is not an IPv4 address`);
  }
  const hop = [
    ...['ssh', '-i', sshKeyPath, ...hostKeyOpts, '-W'].map(proxyToken),
    '%h:%p',
    proxyToken(`root@${masterIp}`),
  ].join(' ');
  return [
    'ssh',
    '-i',
    sshKeyPath,
    '-o',
    `UserKnownHostsFile=${knownHostsFile}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...INNER_CONNECTION_OPTS,
    '-o',
    `ProxyCommand=${hop}`,
    '--',
    `root@${address}`,
    'sh -s',
  ];
}

/**
 * The read's `run` over ssh (nodeRead): spawns nodeReadArgv with the script
 * on stdin, killed at `timeoutMs`, with the inner hop's known_hosts in a temp
 * dir that is removed when the run settles.
 *
 * Its stdout is marked secret, so a failed run's raw output is never echoed
 * (runCommandAsync prints a failed command's stdout under CI): only the
 * redacted facts are logged. What it printed is collected line by line, so a
 * run its bound stopped still hands back its lines (`err.stdout`). $SHELL is
 * /bin/sh, since ssh runs the ProxyCommand with $SHELL and the operator's may
 * not be a POSIX one.
 *
 * @param {object} args
 * @param {string} args.sshKeyPath
 * @param {readonly string[]} args.hostKeyOpts
 * @param {string} args.masterIp
 * @param {typeof runCommandAsync} [args.runArgv] - spawns the argv (tests fake it)
 * @returns {(address: string, script: string, opts: {timeoutMs: number}) => Promise<string>}
 */
export function nodeReadOverSsh({ sshKeyPath, hostKeyOpts, masterIp, runArgv = runCommandAsync }) {
  return (address, script, { timeoutMs }) =>
    withTempDir('vc-node-read-', async (dir) => {
      const argv = nodeReadArgv({
        sshKeyPath,
        hostKeyOpts,
        masterIp,
        address,
        knownHostsFile: join(dir, 'known_hosts'),
      });
      const lines = [];
      try {
        return String(
          await runArgv(argv, {
            silent: true,
            input: script,
            timeout: timeoutMs,
            secret: true,
            env: { ...process.env, SHELL: '/bin/sh' },
            onStdoutLine: (line) => lines.push(line),
          }),
        );
      } catch (err) {
        throw Object.assign(new Error(String(err?.message ?? err)), {
          stdout: lines.join('\n'),
          stderr: err?.stderr,
          status: err?.status,
          timedOut: err?.timedOut,
        });
      }
    });
}

/**
 * The read clusterProbe runs (`readNode`) for each node whose private port 22
 * answered `open`: one bounded `run` per node, all at once. One `[node-join]
 * on the node itself: <label>: <fact>` log line per fact, and one sentence
 * per node (nodeReadSentence). Everything printed is redacted
 * (redactNodeRead) before it is parsed or logged.
 *
 * Never throws and never waits past its bound: a read that fails is one log
 * line, and a read its bound stopped keeps what it printed.
 *
 * @param {object} args
 * @param {(address: string, script: string, opts: {timeoutMs: number}) => Promise<string>} args.run -
 *   runs the script with `sh -s` on the node at `address`, through the k3s
 *   server (nodeReadOverSsh), killed at `timeoutMs`
 * @param {Array<string|null|undefined>} [args.secrets] - what to redact: the cluster's k3s token
 * @param {number} [args.budgetMs]
 * @param {(line: string) => void} [args.log]
 * @returns {(targets: Array<{
 *   node: import('./node-join.js').UnjoinedNode,
 *   label: string,
 *   privateIp: string,
 *   publicIp: string|null,
 * }>) => Promise<Map<import('./node-join.js').UnjoinedNode, string>>}
 */
export function nodeRead({
  run,
  secrets = [],
  budgetMs = NODE_READ_BUDGET_MS,
  log = (line) => console.error(line),
}) {
  const budgetS = Math.round(budgetMs / 1000);
  const redact = (text) => redactNodeRead(text, secrets);
  const say = (line) => {
    const clean = redact(line);
    if (clean) log(clean);
  };
  const script = nodeReadScript();

  const readOne = async ({ label, privateIp, publicIp }) => {
    const cannot = (why) => say(`[node-join] could not read ${label} from the inside: ${why}`);
    if (!isIPv4(String(privateIp ?? ''))) {
      cannot(`${privateIp} is not an IPv4 address`);
      return null;
    }
    const outcome = await boundedRun(
      () => run(privateIp, script, { timeoutMs: budgetMs }),
      budgetMs,
    );
    if (!outcome) {
      cannot(`it did not finish within ${budgetS}s`);
      return null;
    }
    let printed = '';
    let stopped = null;
    if ('err' in outcome) {
      printed = String(outcome.err?.stdout ?? '');
      stopped = outcome.err?.timedOut
        ? `stopped after ${budgetS}s`
        : `failed partway (${whyRunFailed(outcome.err, budgetS)})`;
    } else {
      printed = outcome.out;
    }
    const facts = parseNodeRead(redact(printed));
    if (!reportedAnything(facts)) {
      cannot(
        'err' in outcome
          ? whyRunFailed(outcome.err, budgetS)
          : 'it printed none of the facts it reads',
      );
      return null;
    }
    for (const fact of nodeReadFacts(facts))
      say(`[node-join] on the node itself: ${label}: ${fact}`);
    if (stopped)
      say(
        `[node-join] the read of ${label} from the inside ${stopped}; what it had printed is above`,
      );
    const sentence = nodeReadSentence(facts, { publicIp, privateIp });
    return sentence ? redact(sentence) || null : null;
  };

  return async (targets) => {
    /** @type {Map<import('./node-join.js').UnjoinedNode, string>} */
    const sentences = new Map();
    await Promise.all(
      targets.map(async (target) => {
        try {
          const sentence = await readOne(target);
          if (sentence) sentences.set(target.node, sentence);
        } catch (err) {
          say(
            `[node-join] could not read ${target.label} from the inside: ${whyRunFailed(err, budgetS)}`,
          );
        }
      }),
    );
    return sentences;
  };
}
