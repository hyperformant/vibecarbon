#!/usr/bin/env node
/**
 * Report newer upstream tags for every image in the ghcr mirror set
 * (`MIRRORED_IMAGES`, src/lib/images.js), as a Markdown table on stdout.
 *
 * Run weekly by the `mirror-upstream-drift` job in
 * .github/workflows/publish-images.yml, which appends the table to the job
 * summary. It REPORTS ONLY, never re-pins: a mirror bump is a reviewed edit of
 * {tag, digest} in images.js (and the literal compose / k8s copies), because
 * Dependabot cannot see refs that point at our mirror.
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
import { pathToFileURL } from 'node:url';
import { MIRRORED_IMAGES, upstreamRef } from '../src/lib/images.js';

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

async function main() {
  const rows = [];
  let failed = false;
  for (const image of MIRRORED_IMAGES) {
    const registry = upstreamRef(image).split('/')[0];
    try {
      const newer = newerTags(image.tag, await listTags(registry, image.repo));
      rows.push(`| ${registry}/${image.repo} | ${image.tag} | ${newer.join(', ') || 'none'} |`);
    } catch (err) {
      failed = true;
      rows.push(`| ${registry}/${image.repo} | ${image.tag} | lookup failed: ${err.message} |`);
    }
  }
  process.stdout.write(
    [
      '## Mirror drift: newer upstream tags',
      '',
      'Report only. To bump one, edit its {tag, digest} in src/lib/images.js and the',
      'literal compose / k8s copies; publish-images mirrors it on merge.',
      '',
      '| upstream | pinned | newer |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n'),
  );
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
