import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * CLASS (run 33319907805, hetzner k8s + k8s-ha backup, 2026-08-30): a COMMENT
 * added inside the backup CronJob's `kubectl exec … bash -c '…'` wrapper
 * contained an apostrophe ("can't") — which CLOSED the single-quoted inner
 * script mid-comment and made the outer script unparseable. The container
 * died instantly on every backup trigger. The file's own comments warned
 * about exactly this ("a literal single quote here would end the bash -c
 * single-quoted wrapper above"), but a warning comment is not an invariant.
 *
 * This census makes it one: every embedded shell script in the template —
 * (a) each `command: [bash|sh, -c, <script>]` block scalar in the k8s
 * manifests, (b) each *.sh under carbon/backup and carbon/cloud-init, and
 * (c) the BODY of every nested single-quoted `bash -c '…'` wrapper inside
 * those scripts (with the sanctioned `'"${VAR}"'` interpolation dance
 * substituted) — must pass `bash -n`.
 *
 * The nested-body check is the one that catches the 2026-08-30 bug shape: a
 * stray apostrophe shifts the quote boundaries, so the extracted "body"
 * becomes syntactically invalid (or the outer script does).
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CARBON = join(ROOT, 'carbon');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build']);

function walk(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, pred));
    else if (pred(entry)) out.push(full);
  }
  return out;
}

function bashN(script: string, label: string): void {
  try {
    execFileSync('bash', ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    throw new Error(`bash -n failed for ${label}:\n${stderr}`);
  }
}

/** Every `command: [bash|sh, -c, <script>]` in a parsed YAML doc, recursively. */
function shellCommandScripts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    const [bin, flag, script] = node;
    if (
      typeof bin === 'string' &&
      /(^|\/)(bash|sh)$/.test(bin) &&
      flag === '-c' &&
      typeof script === 'string'
    ) {
      out.push(script);
    }
    for (const item of node) shellCommandScripts(item, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) shellCommandScripts(v, out);
  }
  return out;
}

/**
 * Bodies of nested single-quoted `bash -c '…'` wrappers. The sanctioned
 * shell interpolation dance (`'"${VAR}"'` / `'"$VAR"'`) closes and reopens
 * the quote to splice a value; substitute those spans with a placeholder
 * FIRST so the body extraction sees one contiguous quoted string — exactly
 * how the wrapper behaves at runtime. Any OTHER single quote inside the
 * body (an apostrophe in a comment, an unquoted value) shifts the closing
 * boundary and yields a truncated body that bash -n rejects.
 */
function nestedBashCBodies(script: string): string[] {
  const spliced = script.replace(/'"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"'/g, 'SPLICED_VALUE');
  const bodies: string[] = [];
  const re = /bash -c '([^']*)'/g;
  for (const m of spliced.matchAll(re)) bodies.push(m[1]);
  return bodies;
}

describe('every embedded shell script in the template parses (bash -n)', () => {
  const yamlFiles = walk(join(CARBON, 'k8s'), (n) => /\.ya?ml$/.test(n));
  const shFiles = [
    ...walk(join(CARBON, 'backup'), (n) => n.endsWith('.sh')),
    ...walk(join(CARBON, 'cloud-init'), (n) => n.endsWith('.sh')),
  ];

  it('census still sees the known embedded-shell surfaces', () => {
    // Sanity: if these walks go blind, the assertions below guard nothing.
    expect(yamlFiles.some((f) => f.endsWith('backup/cronjob.yaml'))).toBe(true);
    expect(shFiles.some((f) => f.endsWith('compose-backup.sh'))).toBe(true);
  });

  it.each(yamlFiles.map((f) => [f.slice(CARBON.length + 1), f] as const))(
    '%s: k8s command scripts and their nested bash -c bodies parse',
    (rel, file) => {
      for (const doc of loadAll(readFileSync(file, 'utf-8'))) {
        for (const script of shellCommandScripts(doc)) {
          bashN(script, `${rel} (command block)`);
          for (const body of nestedBashCBodies(script)) {
            bashN(body, `${rel} (nested bash -c body)`);
          }
        }
      }
    },
  );

  it.each(shFiles.map((f) => [f.slice(CARBON.length + 1), f] as const))(
    '%s: script and its nested bash -c bodies parse',
    (rel, file) => {
      const script = readFileSync(file, 'utf-8');
      bashN(script, rel);
      for (const body of nestedBashCBodies(script)) {
        bashN(body, `${rel} (nested bash -c body)`);
      }
    },
  );
});
