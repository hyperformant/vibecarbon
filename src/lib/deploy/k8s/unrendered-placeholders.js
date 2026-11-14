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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { templatePathFor } from '../../template-paths.js';

/** The template this CLI ships, the source of what `upgrade` writes. */
const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'carbon',
);

/** The workflow that applies a GitOps project's Flux cluster file. */
const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';

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
  // A strip with no name takes every object of its kind.
  const stripped = (doc) =>
    strip.some(({ kind, name }) => kind === kindOf(doc) && (name == null || name === nameOf(doc)));
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

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/** A list item's line read as its key's: `  - target:` as `    target:`. */
const asKey = (line) => line.replace(/^([ \t]*)-[ \t]+/, (_, lead) => `${lead}  `);

/** The `key: value` lines one level under the line at `at`. */
function childFields(lines, at) {
  const parent = indentOf(asKey(lines[at]));
  const fields = {};
  let child = null;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    const lead = indentOf(line);
    if (lead <= parent) break;
    child ??= lead;
    if (lead !== child) continue;
    const m = line.match(/^[ \t]*([\w.$-]+):[ \t]*(.*)$/);
    if (m) fields[m[1]] = unquote(m[2]);
  }
  return fields;
}

/**
 * The objects a Flux Kustomization document strips with `$patch: delete`:
 * each patch's `target` (one with no name takes every object of its kind),
 * or the patch's own kind and name when it has no target. A target that
 * also selects by label or annotation is not read as a strip, so the walk
 * can report more than Flux applies, never less.
 *
 * @param {string} doc
 * @returns {Array<{ kind: string, name: string | null }>}
 */
function strippedByFlux(doc) {
  const lines = uncommented(doc).split('\n');
  const starts = lines.flatMap((l, i) => (/^[ \t]*-[ \t]+(patch|target):/.test(l) ? [i] : []));
  const out = [];
  for (const [n, start] of starts.entries()) {
    const itemIndent = indentOf(lines[start]);
    let end = starts[n + 1] ?? lines.length;
    for (let i = start + 1; i < end; i++) {
      if (lines[i].trim() && indentOf(lines[i]) <= itemIndent) {
        end = i;
        break;
      }
    }
    const item = lines.slice(start, end);
    if (!item.some((l) => /^[ \t]*\$patch:[ \t]*delete[ \t]*$/.test(l))) continue;
    const targetAt = item.findIndex((l) => /^[ \t]*(-[ \t]+)?target:[ \t]*$/.test(l));
    if (targetAt !== -1) {
      const target = childFields(item, targetAt);
      if (!target.kind || target.labelSelector || target.annotationSelector) continue;
      out.push({ kind: target.kind, name: target.name || null });
      continue;
    }
    const patchAt = item.findIndex((l) => /^[ \t]*(-[ \t]+)?patch:[ \t]*\|/.test(l));
    if (patchAt === -1) continue;
    const bodyIndent = indentOf(asKey(item[patchAt]));
    const body = [];
    for (const line of item.slice(patchAt + 1)) {
      if (line.trim() && indentOf(line) <= bodyIndent) break;
      body.push(line);
    }
    // A loop, not Math.min(...spread): a long body would overflow the stack.
    let lead = Number.POSITIVE_INFINITY;
    for (const l of body) if (l.trim()) lead = Math.min(lead, indentOf(l));
    if (!Number.isFinite(lead)) continue;
    const text = body.map((l) => l.slice(lead)).join('\n');
    const kind = kindOf(text);
    const name = nameOf(text);
    if (kind && name) out.push({ kind, name });
  }
  return out;
}

/**
 * The Flux cluster files the project's deploy workflow applies, relative to
 * the project: what puts Flux's Kustomizations on a cluster. The template's
 * workflow applies clusters/primary/vibecarbon.yaml on every cluster, the
 * standby's too. No workflow, none.
 *
 * @param {string} projectDir
 * @returns {string[]}
 */
export function fluxClusterFilesApplied(projectDir) {
  const workflow = join(projectDir, DEPLOY_WORKFLOW);
  if (!existsSync(workflow)) return [];
  // The suffix is checked apart: in the pattern, `[\w.-]+` before `\.ya?ml`
  // would backtrack over a long run of dots.
  const named = uncommented(readFileSync(workflow, 'utf-8')).match(
    /(?<![\w./-])k8s\/flux\/clusters\/[\w.-]+\/[\w.-]+/g,
  );
  return [...new Set(named ?? [])]
    .filter((rel) => /\.ya?ml$/.test(rel) && existsSync(join(projectDir, rel)))
    .sort();
}

/**
 * The placeholders each Kustomization in a cluster file's text builds from a
 * path in the project, minus what it strips.
 *
 * @param {string} projectDir
 * @param {string} clusterText
 * @returns {Array<{ file: string, placeholders: string[] }>}
 */
function builtPlaceholders(projectDir, clusterText) {
  const out = [];
  for (const doc of documents(clusterText)) {
    if (kindOf(doc) !== 'Kustomization') continue;
    const m = uncommented(doc).match(/^[ \t]+path:[ \t]*(\S+)/m);
    if (!m) continue;
    const dir = join(projectDir, unquote(m[1]));
    const inRepo = relative(projectDir, dir);
    if (inRepo.startsWith('..') || isAbsolute(inRepo) || !existsSync(dir)) continue;
    out.push(...unrenderedPlaceholders(dir, { root: projectDir, strip: strippedByFlux(doc) }));
  }
  return out;
}

/**
 * Every placeholder Flux would apply from this project: in each cluster file
 * the deploy workflow applies (it goes on as it is) and in what each of its
 * Kustomizations builds from a path in the repo, minus what it strips.
 *
 * `upgradeStrips` says whether the cluster file this CLI ships strips all of
 * a finding's tokens: then taking the new cluster file (`vibecarbon
 * upgrade`) is the way out. Otherwise no cluster file of ours will, and the
 * token itself has to go.
 *
 * @param {string} projectDir
 * @returns {Array<{ file: string, placeholders: string[], via: string, upgradeStrips: boolean }>}
 */
export function fluxPlaceholders(projectDir) {
  const out = [];
  for (const via of fluxClusterFilesApplied(projectDir)) {
    const text = readFileSync(join(projectDir, via), 'utf-8');
    const own = uncommented(text).match(PLACEHOLDER);
    if (own) out.push({ file: via, placeholders: [...new Set(own)], via, upgradeStrips: false });
    const shipped = join(TEMPLATE_DIR, templatePathFor(via));
    const left = existsSync(shipped)
      ? builtPlaceholders(projectDir, readFileSync(shipped, 'utf-8'))
      : null;
    for (const hit of builtPlaceholders(projectDir, text)) {
      const stays = left?.find((f) => f.file === hit.file)?.placeholders ?? [];
      const upgradeStrips = left !== null && !hit.placeholders.some((p) => stays.includes(p));
      out.push({ ...hit, via, upgradeStrips });
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
