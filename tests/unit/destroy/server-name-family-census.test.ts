/**
 * SERVER-NAME FAMILY CENSUS (2026-08-10 destroy-gap sweep).
 *
 * The compose tiers' destroy paths find servers BY NAME. That is only as
 * complete as the list of names they try, and `scale`'s temporary
 * `${project}-${env}[-${role}]-new` was missing from it for as long as scale
 * has existed — a killed mid-scale run left two live servers that a GREEN
 * destroy reported as "no leaked resources" (see src/lib/destroy/server-naming.js
 * for the receipt).
 *
 * A fix that only adds `-new` to the list fixes one spelling. This census makes
 * the CLASS loud instead: it walks src/ for every `${projectName}-${environment}`
 * name literal, normalizes the suffix, and requires each one to be classified.
 * Add a new suffix — `-temp`, `-restore`, `-canary` — and this test fails until
 * somebody says whether it names a SERVER (in which case the destroy family must
 * cover it) or something else.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  environmentServerNames,
  scaleReplacementNames,
} from '../../../src/lib/destroy/server-naming.js';

const SRC_DIR = fileURLToPath(new URL('../../../src', import.meta.url));

/** The name head every environment-scoped resource literal starts with. */
const HEADS = [
  '`${projectName}-${environment}',
  '`${projectConfig.projectName}-${environment}',
  '`${projectName}-${envName}',
  '`${projectName}-${stackEnv}',
];

function jsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Blank out comment lines. Prose spells these names constantly (every RCA
 * comment in destroy.js quotes the literal it fixed), and a doc edit must not
 * be able to fail a census about executable naming. Line-prefix filtering is
 * enough here — no name literal is built inside a comment-continued line.
 */
function codeLinesOnly(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') ? '' : line;
    })
    .join('\n');
}

/**
 * Read the template-literal text between `from` and the literal's closing
 * backtick, tracking `${...}` nesting so an interpolation containing its own
 * nested template (scale.js's `${server.role ? `-${server.role}` : ''}`) is
 * consumed whole instead of terminating the scan on its inner backtick.
 */
function readSuffix(source: string, from: number): string {
  let i = from;
  let depth = 0;
  let out = '';
  while (i < source.length) {
    const c = source[i];
    if (depth === 0 && c === '`') return out;
    if (c === '$' && source[i + 1] === '{') {
      depth += 1;
      out += '${';
      i += 2;
      continue;
    }
    if (depth > 0 && c === '{') depth += 1;
    if (depth > 0 && c === '}') depth -= 1;
    out += c;
    i += 1;
  }
  return out;
}

/** Collapse every top-level interpolation to a bare `${}` placeholder. */
function normalizeSuffix(suffix: string): string {
  let i = 0;
  let depth = 0;
  let out = '';
  while (i < suffix.length) {
    const c = suffix[i];
    if (c === '$' && suffix[i + 1] === '{') {
      if (depth === 0) out += '${}';
      depth += 1;
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

type ResourceClass = 'server' | 'firewall' | 'ssh-key' | 'load-balancer';

/**
 * Every environment-scoped name suffix src/ builds today, and what kind of
 * resource each one names. `${}` is any interpolated component (a role, a
 * stack, a region). An unlisted suffix fails the census by design.
 */
const SUFFIX_CLASS: Record<string, ResourceClass> = {
  // Compose-single's server, and the k8s cluster-name base.
  '': 'server',
  // scale.js's `${server.role ? `-${server.role}` : ''}` — the permanent name.
  '${}': 'server',
  // scale.js's blue-green replacement, alive only mid-scale.
  '${}-new': 'server',
  // ha-role-swap's `-${stack}` stack-identity probe.
  '-${}': 'server',
  '-primary': 'server',
  '-standby': 'server',
  '-firewall': 'firewall',
  '-primary-firewall': 'firewall',
  '-standby-firewall': 'firewall',
  // k8s-ha's `-${clusterRole}-firewall`.
  '-${}-firewall': 'firewall',
  '-key': 'ssh-key',
  '-ha-key': 'ssh-key',
  // compose destroy's `-${composeRegion}-key`.
  '-${}-key': 'ssh-key',
  '-lb': 'load-balancer',
};

interface Occurrence {
  suffix: string;
  where: string;
}

function collectOccurrences(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of jsFilesUnder(SRC_DIR)) {
    const source = codeLinesOnly(readFileSync(file, 'utf-8'));
    for (const head of HEADS) {
      let idx = source.indexOf(head);
      while (idx !== -1) {
        const line = source.slice(0, idx).split('\n').length;
        found.push({
          suffix: normalizeSuffix(readSuffix(source, idx + head.length)),
          where: `${file.slice(SRC_DIR.length + 1)}:${line}`,
        });
        idx = source.indexOf(head, idx + head.length);
      }
    }
  }
  return found;
}

describe('environment server-name family census', () => {
  const occurrences = collectOccurrences();

  it('finds the name literals at all (guards the scanner itself)', () => {
    // A scanner that silently matched nothing would make every assertion below
    // vacuously pass — the exact shape of failure this census exists to catch.
    expect(occurrences.length).toBeGreaterThan(20);
  });

  it('every environment-scoped name suffix in src/ is classified', () => {
    const unclassified = occurrences
      .filter((o) => !Object.hasOwn(SUFFIX_CLASS, o.suffix))
      .map((o) => `${o.where} → suffix ${JSON.stringify(o.suffix)}`);
    expect(
      unclassified,
      'A new environment-scoped name appeared. If it names a SERVER, add it to ' +
        'environmentServerNames() in src/lib/destroy/server-naming.js (destroy finds ' +
        'compose servers by name — an unlisted name leaks silently). Then classify it here.',
    ).toEqual([]);
  });

  it('the destroy family covers every server-classified suffix, permanent and transient', () => {
    const family = environmentServerNames({ projectName: 'acme', environment: 'e2' });
    // The renderings of the server-classified suffixes above: the bare base,
    // both HA roles, and each one's mid-scale `-new` twin.
    for (const base of ['acme-e2', 'acme-e2-primary', 'acme-e2-standby']) {
      expect(family, `permanent name ${base}`).toContain(base);
      expect(family, `transient name ${base}-new`).toContain(`${base}-new`);
    }
  });

  it('scale is the only source of transient names, and they are all -new', () => {
    const transient = scaleReplacementNames({ projectName: 'acme', environment: 'e2' });
    expect(transient.length).toBeGreaterThan(0);
    for (const name of transient) expect(name.endsWith('-new')).toBe(true);
    // Every suffix classified as a server must be either a permanent shape or
    // the `-new` shape — a second transient spelling would need its own
    // teardown wiring, so make adding one loud here too.
    const serverSuffixes = Object.entries(SUFFIX_CLASS)
      .filter(([, kind]) => kind === 'server')
      .map(([suffix]) => suffix);
    for (const suffix of serverSuffixes) {
      const isReplacement = suffix.endsWith('-new');
      const isPermanent = ['', '${}', '-${}', '-primary', '-standby'].includes(suffix);
      expect(isReplacement || isPermanent, `server suffix ${JSON.stringify(suffix)}`).toBe(true);
    }
  });
});
