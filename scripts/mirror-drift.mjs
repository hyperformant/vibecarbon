#!/usr/bin/env node
/**
 * Report newer upstream tags for every image in the ghcr mirror set
 * (`MIRRORED_IMAGES`, src/lib/images.js), as a Markdown table on stdout.
 *
 * Run weekly by the `mirror-upstream-drift` job in
 * .github/workflows/publish-images.yml, which writes the table to the job
 * summary and to one GitHub issue. It REPORTS ONLY, never re-pins: a mirror
 * bump is a reviewed edit of {tag, digest, index} in images.js (and the
 * literal compose / k8s copies), because Dependabot cannot see refs that
 * point at our mirror.
 *
 * CEILINGS (`holdFor`): some newer tags must not be taken, and listing them
 * would keep the issue open forever. alpine/k8s stays within one minor of
 * K3S_VERSION (kubectl's skew policy); registry stays on 2.x (3 changed the
 * config format); cluster-autoscaler stays on its minor (it tracks the
 * Kubernetes minor); k3s system images move only with K3S_VERSION, and CSI
 * sidecars only with the CSI driver release, so neither is listed. Held
 * entries are named under the table, not counted. When nothing is
 * actionable the report carries the marker `<!-- mirror-drift: none -->`,
 * which the workflow reads to leave the issue alone.
 *
 * Tags are read from each upstream registry's `/v2/<repo>/tags/list`
 * (anonymous bearer token when the registry asks for one, following `Link`
 * pagination) and filtered to the pinned tag's own shape: same `v` prefix,
 * same number of numeric dot-separated parts, no suffix. So `1.8.1.3` is
 * compared with `1.8.1.4`, never with `1.8.1.3-r0` or `latest`.
 *
 * A lookup that fails is a row saying so, and the script exits 1 after the
 * table is written, so a silently-empty report cannot pass for "no drift".
 *
 * Usage: node scripts/mirror-drift.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALPINE_K8S_MIRROR,
  CSI_SIDECAR_MIRRORS,
  K3S_SYSTEM_IMAGE_MIRRORS,
  MIRRORED_IMAGES,
  REGISTRY_MIRROR,
  upstreamRef,
} from '../src/lib/images.js';

/** The marker the workflow greps for: nothing to take, leave the issue alone. */
export const NO_DRIFT_MARKER = '<!-- mirror-drift: none -->';

/** Registries whose API host differs from the name in an image ref. */
const API_HOST = { 'docker.io': 'registry-1.docker.io' };

/**
 * @param {string} tag
 * @returns {{prefix: string, parts: number[]} | null}
 */
function parseTag(tag) {
  const m = tag.match(/^(v?)(\d+(?:\.\d+)*)$/);
  return m ? { prefix: m[1], parts: m[2].split('.').map(Number) } : null;
}

/**
 * Tags of the same shape as `current` that sort after it, ascending.
 * @param {string} current
 * @param {string[]} tags
 * @returns {string[]}
 */
export function newerTags(current, tags) {
  const base = parseTag(current);
  if (!base) return [];
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  return tags
    .map((tag) => ({ tag, parsed: parseTag(tag) }))
    .filter(
      ({ parsed }) =>
        parsed &&
        parsed.prefix === base.prefix &&
        parsed.parts.length === base.parts.length &&
        cmp(parsed.parts, base.parts) > 0,
    )
    .sort((a, b) => cmp(a.parsed.parts, b.parsed.parts))
    .map(({ tag }) => tag);
}

/** `[major, minor]` of a version string (leading `v` allowed). */
const majorMinor = (v) => v.replace(/^v/, '').split('.').slice(0, 2).map(Number);

/**
 * K3S_VERSION read from k3s.js's source, not imported: k3s.js pulls the whole
 * deploy graph, and the drift job runs with no install step.
 */
export function readK3sVersion(
  file = fileURLToPath(new URL('../src/lib/deploy/k8s/k3s.js', import.meta.url)),
) {
  const v = readFileSync(file, 'utf8').match(/K3S_VERSION = '(v[^']+)'/)?.[1];
  if (!v) throw new Error(`no K3S_VERSION in ${file}`);
  return v;
}

/**
 * Why an entry's newer tags are held back, as {reason, allows(tag)}; null
 * when every newer tag is fair game.
 * @param {import('../src/lib/images.js').MirroredImage} image
 * @param {string} k3sVersion
 */
export function holdFor(image, k3sVersion) {
  const [k3sMajor, k3sMinor] = majorMinor(k3sVersion);
  const sameRepo = (other) => other.repo === image.repo && (other.upstream ?? '') === (image.upstream ?? '');
  if (K3S_SYSTEM_IMAGE_MIRRORS.some(sameRepo)) {
    return { reason: 'moves with K3S_VERSION (k3s-images.txt)', allows: () => false };
  }
  const csi = Object.values(CSI_SIDECAR_MIRRORS).flatMap((specs) =>
    specs.flatMap((spec) => Object.values(spec.containers)),
  );
  if (csi.some(sameRepo)) {
    return { reason: 'moves with the CSI driver release', allows: () => false };
  }
  if (sameRepo(ALPINE_K8S_MIRROR)) {
    return {
      reason: `kubectl stays within one minor of k3s ${k3sVersion}`,
      allows: (tag) => {
        const [major, minor] = majorMinor(tag);
        return major === k3sMajor && minor <= k3sMinor + 1;
      },
    };
  }
  if (sameRepo(REGISTRY_MIRROR)) {
    return { reason: 'registry stays on 2.x (3 changed the config format)', allows: (tag) => majorMinor(tag)[0] === 2 };
  }
  if (image.repo === 'autoscaling/cluster-autoscaler') {
    return {
      reason: 'cluster-autoscaler stays on its Kubernetes minor',
      allows: (tag) => majorMinor(tag).join('.') === majorMinor(image.tag).join('.'),
    };
  }
  return null;
}

/** GET with one anonymous-token retry when the registry answers 401. */
async function registryGet(url, token) {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (res.status !== 401 || token) return { res, token };
  const challenge = res.headers.get('www-authenticate') ?? '';
  const field = (k) => challenge.match(new RegExp(`${k}="([^"]+)"`))?.[1];
  const realm = field('realm');
  if (!realm) return { res, token };
  const q = new URLSearchParams();
  if (field('service')) q.set('service', field('service'));
  if (field('scope')) q.set('scope', field('scope'));
  const tokenRes = await fetch(`${realm}?${q}`);
  if (!tokenRes.ok) throw new Error(`token ${tokenRes.status} from ${realm}`);
  const body = await tokenRes.json();
  const fresh = body.token ?? body.access_token;
  return registryGet(url, fresh);
}

/** Every tag of `repo` on `registry`, across `Link` pages. */
async function listTags(registry, repo) {
  const host = API_HOST[registry] ?? registry;
  let url = `https://${host}/v2/${repo}/tags/list?n=1000`;
  let token;
  const tags = [];
  while (url) {
    const got = await registryGet(url, token);
    token = got.token;
    if (!got.res.ok) throw new Error(`${got.res.status} listing ${host}/${repo}`);
    tags.push(...((await got.res.json()).tags ?? []));
    const next = got.res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next ? new URL(next, `https://${host}`).href : null;
  }
  return tags;
}

/**
 * The Markdown report: actionable rows in a table, held entries named below,
 * and the no-drift marker when there is nothing to take.
 * @param {Array<{upstream: string, pinned: string, newer: string[], hold: string | null, error?: string}>} entries
 */
export function renderReport(entries) {
  const rows = entries
    .filter((e) => e.error || e.newer.length > 0)
    .map((e) => `| ${e.upstream} | ${e.pinned} | ${e.error ? `lookup failed: ${e.error}` : e.newer.join(', ')} |`);
  const held = [...new Set(entries.filter((e) => e.hold).map((e) => `- ${e.upstream} (${e.pinned}): ${e.hold}`))];
  return [
    '## Mirror drift: newer upstream tags',
    '',
    'Report only. To bump one, edit its {tag, digest, index} in src/lib/images.js and',
    'the literal compose / k8s copies; publish-images mirrors it on merge.',
    '',
    ...(rows.length
      ? ['| upstream | pinned | newer |', '| --- | --- | --- |', ...rows]
      : [NO_DRIFT_MARKER, 'Nothing to take.']),
    '',
    ...(held.length ? ['Held back by a ceiling (not counted):', '', ...held, ''] : []),
  ].join('\n');
}

async function main() {
  const k3sVersion = readK3sVersion();
  const entries = [];
  for (const image of MIRRORED_IMAGES) {
    const upstream = upstreamRef(image).split(':')[0];
    const registry = upstream.split('/')[0];
    const hold = holdFor(image, k3sVersion);
    try {
      const all = newerTags(image.tag, await listTags(registry, image.repo));
      const newer = hold ? all.filter((t) => hold.allows(t)) : all;
      entries.push({ upstream, pinned: image.tag, newer, hold: hold?.reason ?? null });
    } catch (err) {
      entries.push({ upstream, pinned: image.tag, newer: [], hold: null, error: err.message });
    }
  }
  process.stdout.write(renderReport(entries));
  if (entries.some((e) => e.error)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
