/**
 * The oldest version of every tool vibecarbon runs on, in one table.
 *
 * We do not pin tool versions: a security fix should reach a server without a
 * CLI release. So the protection against an old tool is a floor and an early,
 * plain failure, instead of a confusing one deep in a deploy (Docker 27.5.1 and
 * `docker save --platform`, 86aeb04f, was the failure that started this).
 *
 * A wrong floor would stop deploys that work, so two rules hold everywhere:
 *   - Each number here came from running the tool, and each row says how. See
 *     `source`. A row whose number was not proven by a run says that too.
 *   - A check refuses only a version it read and knows is too old. Anything it
 *     cannot parse is a warning and the deploy continues (judgeVersion).
 *
 * Floors are floors: never an exact version, never a ceiling.
 *
 * A row with `notFloor` records a version gate that does NOT stop anyone, with
 * the reason. The gate is real, and the code handles it another way. The census
 * (tests/unit/lib/runtime-floors-census.test.ts) holds every gated feature as
 * a pattern, so one with no row here fails, and so does a row whose feature is
 * gone.
 *
 * Tested 2026-11-05 with Docker's own releases (docker/compose-bin and
 * docker:*-cli images, alpine/k8s), each in a container with no network unless
 * the test needed it, a read-only root, no capabilities and no host access.
 * Engine behaviour was tested by pointing real Compose binaries at a stub
 * Docker API reporting the old version.
 */
import { createRequire } from 'node:module';

/** What a person calls each tool, in messages. */
const TOOL_LABELS = Object.freeze({
  'docker-engine': 'Docker Engine',
  compose: 'Docker Compose',
  kubectl: 'kubectl',
  openssh: 'OpenSSH',
  pulumi: 'Pulumi',
  node: 'Node.js',
  k3s: 'k3s',
});

/**
 * The Node floor, read from package.json `engines.node` (computed by
 * scripts/sync-node-version.js from the lockfile), so there is no second copy
 * to drift. Null when it cannot be read: src/cli.js then skips its check.
 *
 * @returns {string | null}
 */
function nodeEnginesFloor() {
  try {
    const require = createRequire(import.meta.url);
    const { engines } = require('../../package.json');
    return /(\d+\.\d+\.\d+)/.exec(String(engines?.node ?? ''))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @typedef {'server' | 'laptop'} Where
 * @typedef {object} FloorRow
 * @property {string} id - stable key, shared with the census
 * @property {keyof typeof TOOL_LABELS} tool
 * @property {string | null} min - oldest version the feature works on; null for
 *   a tool we pin ourselves, where only `notFloor` applies
 * @property {readonly Where[]} where - where this tool runs for this feature
 * @property {string} feature - what needs it, in words a message can quote
 * @property {string} source - how the number was established
 * @property {string} [notFloor] - why this gate stops nobody
 * @property {string} [onlyWhen] - the deploys it applies to, when not all
 */

/** @type {readonly FloorRow[]} */
export const RUNTIME_FLOORS = Object.freeze([
  // Docker Engine. Only servers: a laptop's local Docker has no proven floor.
  {
    id: 'engine-start-interval',
    tool: 'docker-engine',
    min: '25.0.0',
    where: ['server'],
    feature: 'the db healthcheck in docker-compose.prod.yml sets start_interval',
    source:
      'Real Compose 2.24.4, 2.32.4, 2.40.3 and 5.0.0 against a stub API 1.43 stop with "can\'t set healthcheck.start_interval as feature require Docker Engine v25 or later"; against 25.0.0 / API 1.44 they send the container create. Compose 5.7.0 has dropped its check, so on an older daemon it would be ignored instead',
  },
  {
    id: 'engine-save-platform',
    tool: 'docker-engine',
    min: '28.0.0',
    where: ['server'],
    feature: 'image delivery saves one platform of each image',
    source: 'The save help lists no --platform in docker:27.5.1-cli and lists it in 28.0.0',
    notFloor:
      'layer-delta-remote.sh asks the save help and leaves the flag out when it is missing (86aeb04f). Servers built before the Docker install was unified run 27.5.1 and stay deployable without a rebuild, so a floor here would stop them for nothing',
  },
  {
    id: 'engine-buildkit',
    tool: 'docker-engine',
    min: '23.0.0',
    where: ['laptop'],
    feature: 'carbon/Dockerfile uses `RUN --mount`, which needs BuildKit',
    source:
      'Docker documents BuildKit as the default builder from 23.0. Not run: no old daemon was started',
    notFloor:
      'not proven by a run, and a local build that fails names BuildKit itself. A compose deploy without local Docker builds on the server instead',
  },

  // Docker Compose. One floor for server and laptop: see compose-merge-tags.
  {
    id: 'compose-merge-tags',
    tool: 'compose',
    min: '2.24.4',
    where: ['server', 'laptop'],
    feature: 'the project compose files need `!reset` and `!override` merging',
    source:
      'Real binaries, `config -q` on the real files. Prod with every add-on first passes at 2.24.4 and every release tested after it. 2.23.3 fails "ports must be a list" (no !reset), 2.24.0 to 2.24.3 fail on merging. Dev with add-ons also fails on 2.24.0 to 2.24.3, and dev alone on 2.24.1. Dev files alone parse on 2.23.3 and older, so a laptop under the floor is refused for the prod files (docker-up.js --prod) and because a floor cannot carve out that band',
  },
  {
    id: 'compose-config-content',
    tool: 'compose',
    min: '2.23.1',
    where: ['server'],
    feature: 'the socket proxy configs in docker-compose.prod.yml use inline `content:`',
    source:
      'Real binaries: 2.23.0 fails "configs.app-docker-proxy-haproxy Additional property content is not allowed", 2.23.1 parses it',
  },
  {
    id: 'compose-pull-policy',
    tool: 'compose',
    min: '2.22.0',
    where: ['server'],
    feature: 'the deploy pulls with `--policy missing`',
    source: '`pull --help` lists no --policy in 2.21.0 and lists it in 2.22.0',
  },
  {
    id: 'compose-wait-timeout',
    tool: 'compose',
    min: '2.17.0',
    where: ['server'],
    feature: 'add-ons start with `up --wait --wait-timeout`',
    source: 'Present in `up --help` on 2.17.0, the oldest compose-bin image',
  },
  {
    id: 'compose-ps-json-lines',
    tool: 'compose',
    min: '2.21.0',
    where: ['laptop'],
    feature: 'the `ps --format json` output moved to JSON Lines',
    source:
      'Real binaries against a stub API with two containers: 2.20.3 prints one array, 2.21.0 prints one object per line',
    notFloor: 'parseComposePs (src/lib/status/compose-ps.js) reads both shapes',
  },

  // kubectl. Only the k8s tiers use it. The floor was 1.27 until a run showed
  // the reason given for it was wrong: see kubectl-kustomize-url.
  {
    id: 'kubectl-patch-subresource',
    tool: 'kubectl',
    min: '1.24.0',
    where: ['laptop'],
    feature: '`kubectl patch --subresource=status` clears an ACME failure backoff',
    source: '`patch --help` lists no --subresource on 1.23.17 and lists it on 1.24.16',
    onlyWhen: 'k8s and k8s-ha deploys',
  },
  {
    id: 'kubectl-kustomize-url',
    tool: 'kubectl',
    min: '1.23.0',
    where: ['laptop'],
    feature: '`kubectl kustomize` renders every kustomization, cert-manager from its release URL',
    source:
      'All 19 kustomizations, the real cert-manager URL included, render byte-identical on 1.23.17, 1.25.16 (kustomize v4.5.7), 1.26.9 (v4.5.7) and 1.27.9 (v5.0.1)',
    notFloor:
      'no version tested fails, so kustomize v5 is not required, which is what the old 1.27 floor claimed',
    onlyWhen: 'k8s and k8s-ha deploys',
  },

  // OpenSSH.
  {
    id: 'ssh-accept-new',
    tool: 'openssh',
    min: '7.6.0',
    where: ['laptop'],
    feature: 'every ssh call pins host keys with StrictHostKeyChecking=accept-new',
    source:
      'Real clients, `ssh -G`: 7.5p1 fails \'unsupported option "accept-new"\', 7.6p1 and 7.7p1 accept it',
  },
  {
    id: 'ssh-askpass-require',
    tool: 'openssh',
    min: '8.4.0',
    where: ['laptop'],
    feature: 'SSH_ASKPASS_REQUIRE=never stops any password dialog',
    source: 'OpenSSH 8.4 release notes, as cited in src/cli.js. Not run',
    notFloor:
      'an older ssh ignores the variable, and BatchMode=yes plus SSH_ASKPASS=/bin/false still stop a prompt',
  },

  // Pulumi. Both rows are conditional, so src/lib/deploy/preflight.js decides
  // when each applies.
  {
    id: 'pulumi-backend-checksum',
    tool: 'pulumi',
    min: '3.256.0',
    where: ['laptop'],
    feature: 'a provider that pins request_checksum_calculation on the state backend URL',
    source:
      'pulumi/pulumi PR #24109, first released in 3.256.0. Live 2026-08-20: Scaleway compose-ha failed this way on 3.231.0. Not re-run',
    onlyWhen: 'providers that pin a checksum mode',
  },
  {
    id: 'pulumi-worker-trigger',
    tool: 'pulumi',
    min: '3.226.0',
    where: ['laptop'],
    feature: 'static k8s workers rejoin a replaced master through replacementTrigger',
    source:
      'The option arrived in 3.208.0 and 3.226.0 fixed it firing on dependency changes, per Pulumi release notes. Not re-run',
    onlyWhen: 'k8s and k8s-ha deploys',
  },

  // Node.
  {
    id: 'node-engines',
    tool: 'node',
    min: nodeEnginesFloor(),
    where: ['laptop'],
    feature: 'package.json engines.node, which covers util.parseEnv in src/lib/dotenv.js',
    source: 'Computed from the lockfile by scripts/sync-node-version.js; run by CI engines-min',
  },

  // k3s. We pick the version, so a flag can only break on a bump.
  {
    id: 'k3s-registry-endpoint',
    tool: 'k3s',
    min: null,
    where: ['server'],
    feature: 'master-init.sh passes --disable-default-registry-endpoint',
    source: 'In the k3s server docs. First release not established',
    notFloor: 'we install the k3s version, so this must simply hold on any k3s bump',
  },
]);

/**
 * Normalize a version a tool printed to `major.minor.patch`, or null when the
 * text is not a version. Strict on purpose: it matches at the start of the
 * string (the `v` is optional), so a sentence or a template that rendered to
 * nothing cannot be read as a low number. `OpenSSH_9.6p1 ...` is the one
 * spelling with a prefix.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function parseVersion(raw) {
  const text = String(raw ?? '').trim();
  const ssh = /^OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(text);
  if (ssh) return `${ssh[1]}.${ssh[2]}.0`;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?=$|[-+~\s])/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? 0}` : null;
}

/**
 * @param {string} a - `major.minor.patch`
 * @param {string} b - `major.minor.patch`
 * @returns {number} negative / 0 / positive, like a comparator
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * One row by id. Throws on an unknown id: that is a typo in our code.
 *
 * @param {string} id
 * @returns {FloorRow}
 */
export function rowFor(id) {
  const row = RUNTIME_FLOORS.find((r) => r.id === id);
  if (!row) throw new Error(`runtime-floors: no row ${JSON.stringify(id)}`);
  return row;
}

/**
 * The row that sets a tool's unconditional floor in one place: the highest
 * `min` among the rows that stop someone. Null when nothing does.
 *
 * @param {FloorRow['tool']} tool
 * @param {Where} where
 * @returns {FloorRow | null}
 */
export function floorFor(tool, where) {
  const rows = RUNTIME_FLOORS.filter(
    (r) => r.tool === tool && r.where.includes(where) && r.min && !r.notFloor && !r.onlyWhen,
  );
  if (rows.length === 0) return null;
  return rows.reduce((top, r) => (compareVersions(r.min, top.min) > 0 ? r : top));
}

/**
 * Judge a version a tool printed against a floor. Only `too-old` may refuse.
 *
 * @param {FloorRow['tool']} tool
 * @param {Where} where
 * @param {string | null | undefined} raw - exactly what the tool printed
 * @param {FloorRow | null} [floor] - a specific row, for a conditional floor
 * @returns {{ verdict: 'ok' | 'too-old' | 'unreadable', found: string | null, floor: FloorRow | null }}
 */
export function judgeVersion(tool, where, raw, floor = floorFor(tool, where)) {
  if (!floor?.min) return { verdict: 'ok', found: parseVersion(raw), floor: null };
  const found = parseVersion(raw);
  if (!found) return { verdict: 'unreadable', found: null, floor };
  return { verdict: compareVersions(found, floor.min) < 0 ? 'too-old' : 'ok', found, floor };
}

/**
 * The one refusal: what was found, what is needed and what to do.
 *
 * @param {object} args
 * @param {FloorRow['tool']} args.tool
 * @param {string} args.found
 * @param {FloorRow} args.floor
 * @param {string} [args.subject] - where it was found, such as `on 203.0.113.7`
 * @param {string} args.fix - the one thing to do next
 * @returns {string}
 */
export function tooOldMessage({ tool, found, floor, subject, fix }) {
  const label = TOOL_LABELS[tool];
  const where = subject ? ` ${subject}` : '';
  return [
    `${label} ${found}${where} is too old.`,
    '',
    `  Found:   ${label} ${found}`,
    `  Needed:  ${floor.min} or newer, because ${floor.feature}`,
    `  Do this: ${fix}`,
  ].join('\n');
}

/**
 * The one warning for a version nothing can be concluded from.
 *
 * @param {object} args
 * @param {FloorRow['tool']} args.tool
 * @param {string | null | undefined} args.raw - what came back
 * @param {string} [args.subject]
 * @returns {string}
 */
export function unreadableMessage({ tool, raw, subject }) {
  const where = subject ? ` ${subject}` : '';
  const text = String(raw ?? '').trim();
  const said = text ? `, it said "${text.slice(0, 80)}"` : '';
  return `Could not read the ${TOOL_LABELS[tool]} version${where}${said}. Continuing without checking it.`;
}

/**
 * Judge `kubectl version --client -o json`: a message when the client is
 * proven older than its floor, otherwise null. Output that cannot be read
 * proves nothing and is not refused. Reads `major` and `minor` rather than
 * `gitVersion`: a vendor build can carry any suffix there, and a minor like
 * `28+` still counts.
 *
 * @param {string} versionJson
 * @returns {string | null}
 */
export function kubectlFloorProblem(versionJson) {
  let client;
  try {
    client = JSON.parse(versionJson)?.clientVersion;
  } catch {
    return null;
  }
  const major = Number.parseInt(client?.major ?? '', 10);
  const minor = Number.parseInt(client?.minor ?? '', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  const { verdict, floor, found } = judgeVersion(
    'kubectl',
    'laptop',
    `${major}.${minor}`,
    rowFor('kubectl-patch-subresource'),
  );
  if (verdict !== 'too-old' || !floor || !found) return null;
  return tooOldMessage({
    tool: 'kubectl',
    found: `${major}.${minor}`,
    floor,
    fix: `Install kubectl ${floor.min} or newer, then run the deploy again.`,
  });
}

/** `major.minor` of a version, or null. */
const majorMinor = (raw) => {
  const v = parseVersion(raw);
  return v ? v.split('.').slice(0, 2).map(Number) : null;
};

/**
 * Kubernetes supports kubectl within one minor of the cluster. Outside that a
 * deploy usually still works, so this is a warning and never a failure.
 *
 * @param {{ client?: string | null, server?: string | null }} versions
 * @returns {string | null} the warning, or null when in range or unreadable
 */
export function kubectlSkewWarning({ client, server } = {}) {
  const c = majorMinor(client);
  const s = majorMinor(server);
  if (!c || !s || c[0] !== s[0] || Math.abs(c[1] - s[1]) <= 1) return null;
  const [have, want] = [`${c[0]}.${c[1]}`, `${s[0]}.${s[1]}`];
  return (
    `kubectl ${have} is more than one minor version from this cluster (${want}). ` +
    'Kubernetes only supports kubectl within one minor of the cluster. The deploy continues, ' +
    `and if a kubectl step fails, install kubectl ${want} first.`
  );
}
