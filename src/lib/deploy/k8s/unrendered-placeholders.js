/**
 * `{{TOKEN}}` placeholders left in the manifests a kustomization builds: the
 * guard that keeps an unfilled template token off a cluster.
 *
 * Two deploy paths apply a project's k8s/base. The CLI deploy renders a temp
 * copy (renderK8sBase) and applies that. Flux applies the committed tree as
 * it is, minus the objects each cluster file strips with `$patch: delete`
 * (the CLI-owned ones whose values are per cluster). Flux cannot fill a
 * token, so every token in what Flux builds reaches the cluster literally:
 * an image of `{{TRAEFIK_IMAGE}}` is an InvalidImageName rollout. That
 * happens when k8s/base and the cluster files come from different template
 * versions, which is what `upgrade -y` left behind for a project whose Flux
 * files `configure cicd` had edited.
 *
 * Text only (the CLI ships no YAML parser): resources are followed through
 * each kustomization's `resources:` list, documents split on `---`, and
 * full-line comments are not read. The template census
 * (tests/unit/deploy/flux-base-placeholder-census.test.ts) checks the
 * template with a real kustomize build; this checks a project's own files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/g;
const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];

/** The text without its full-line comments. */
function uncommented(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function unquote(value) {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** The YAML documents of a file, split on `---` lines. */
function documents(text) {
  return text.split(/^---[ \t]*$/m);
}

/** A document's top-level `kind`, or null. */
function kindOf(doc) {
  const m = uncommented(doc).match(/^kind:[ \t]*(\S.*)$/m);
  return m ? unquote(m[1]) : null;
}

/** A document's `metadata.name`, or null. */
function nameOf(doc) {
  const lines = uncommented(doc).split('\n');
  const start = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (start === -1) return null;
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const lead = line.match(/^[ \t]*/)[0].length;
    if (lead === 0) return null;
    indent ??= lead;
    if (lead !== indent) continue;
    const m = line.match(/^[ \t]*name:[ \t]*(\S.*)$/);
    if (m) return unquote(m[1]);
  }
  return null;
}

/** The entries of a kustomization's block-style `resources:` list. */
function resourcesOf(text) {
  const out = [];
  let inList = false;
  for (const line of uncommented(text).split('\n')) {
    if (/^resources:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (/^\S/.test(line)) {
      inList = false;
      continue;
    }
    const m = line.match(/^\s+-\s+(['"]?)([^'"\s#]+)\1\s*(#.*)?$/);
    if (m) out.push(m[2]);
  }
  return out;
}

function kustomizationFile(dir) {
  return KUSTOMIZATION_FILES.map((f) => join(dir, f)).find((p) => existsSync(p)) ?? null;
}

/**
 * Every placeholder the kustomization at `dir` builds, per file: the
 * kustomization files themselves and each resource document, followed
 * through nested kustomizations. A document whose `kind` and
 * `metadata.name` are in `strip` is not built (a Flux `$patch: delete`).
 * Remote resources are not read.
 *
 * @param {string} dir
 * @param {{ root?: string, strip?: Array<{ kind: string, name: string }> }} [opts]
 *   `root` makes the reported paths relative to it (default: `dir`)
 * @returns {Array<{ file: string, placeholders: string[] }>}
 */
export function unrenderedPlaceholders(dir, { root = dir, strip = [] } = {}) {
  const found = new Map();
  const note = (path, text) => {
    const hits = text.match(PLACEHOLDER);
    if (!hits) return;
    const file = relative(root, path);
    found.set(file, [...new Set([...(found.get(file) ?? []), ...hits])]);
  };
  const stripped = (doc) =>
    strip.some(({ kind, name }) => kind === kindOf(doc) && name === nameOf(doc));
  const seen = new Set();
  const visit = (kdir) => {
    const kfile = kustomizationFile(kdir);
    if (!kfile || seen.has(kfile)) return;
    seen.add(kfile);
    const ktext = readFileSync(kfile, 'utf-8');
    note(kfile, uncommented(ktext));
    for (const entry of resourcesOf(ktext)) {
      if (entry.includes('://')) continue;
      const path = join(kdir, entry);
      if (!existsSync(path)) continue;
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      for (const doc of documents(readFileSync(path, 'utf-8'))) {
        if (!stripped(doc)) note(path, uncommented(doc));
      }
    }
  };
  visit(dir);
  return [...found].map(([file, placeholders]) => ({ file, placeholders }));
}

/**
 * The objects a Flux Kustomization document strips with `$patch: delete`.
 *
 * @param {string} doc
 * @returns {Array<{ kind: string, name: string }>}
 */
function strippedByFlux(doc) {
  const out = [];
  const re =
    /\$patch:[ \t]*delete[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+kind:[ \t]*(\S+)[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+name:[ \t]*(\S+)/g;
  for (const m of uncommented(doc).matchAll(re))
    out.push({ kind: unquote(m[1]), name: unquote(m[2]) });
  return out;
}

/** The project's Flux cluster files, relative to the project. */
function fluxClusterFiles(projectDir) {
  const clusters = join(projectDir, 'k8s', 'flux', 'clusters');
  if (!existsSync(clusters)) return [];
  return readdirSync(clusters, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) =>
      readdirSync(join(clusters, e.name))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => relative(projectDir, join(clusters, e.name, f))),
    )
    .sort();
}

/**
 * Every placeholder Flux would apply from this project: in each cluster file
 * (the deploy workflow applies it as it is) and in what each of its
 * Kustomizations builds from a path in the repo, minus what it strips.
 *
 * @param {string} projectDir
 * @returns {Array<{ file: string, placeholders: string[], via: string }>}
 */
export function fluxPlaceholders(projectDir) {
  const out = [];
  for (const via of fluxClusterFiles(projectDir)) {
    const text = readFileSync(join(projectDir, via), 'utf-8');
    const own = uncommented(text).match(PLACEHOLDER);
    if (own) out.push({ file: via, placeholders: [...new Set(own)], via });
    for (const doc of documents(text)) {
      if (kindOf(doc) !== 'Kustomization') continue;
      const m = uncommented(doc).match(/^[ \t]+path:[ \t]*(\S+)/m);
      if (!m) continue;
      const dir = join(projectDir, unquote(m[1]));
      const inRepo = relative(projectDir, dir);
      if (inRepo.startsWith('..') || isAbsolute(inRepo) || !existsSync(dir)) continue;
      for (const hit of unrenderedPlaceholders(dir, {
        root: projectDir,
        strip: strippedByFlux(doc),
      })) {
        out.push({ ...hit, via });
      }
    }
  }
  return out;
}

/**
 * One line per finding: `<file> would reach the cluster with <tokens>`,
 * naming the cluster file it goes through when that is another file.
 *
 * @param {Array<{ file: string, placeholders: string[], via: string }>} findings
 * @returns {string[]}
 */
export function describeFluxPlaceholders(findings) {
  return findings.map(
    ({ file, placeholders, via }) =>
      `${file} would reach the cluster with ${placeholders.join(', ')}` +
      (via === file ? '' : ` (Flux applies it through ${via})`),
  );
}
