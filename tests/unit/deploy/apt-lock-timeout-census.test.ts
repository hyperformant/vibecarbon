/**
 * Census: every apt-get we emit onto a freshly-booted node must wait for the
 * dpkg lock instead of dying on it.
 *
 * Ubuntu runs unattended-upgrades on first boot and it holds
 * /var/lib/dpkg/lock-frontend for seconds to minutes. apt's DEFAULT is to try
 * the lock once and exit 100. Every apt-get we run lands inside that window,
 * so whether a deploy survives is a coin flip on how long unattended-upgrades
 * takes. Live v2 (vultr/compose-ha) 2026-08-20 lost it at configure-replication:
 *
 *   E: Could not get lock /var/lib/dpkg/lock-frontend.
 *      It is held by process 10401 (unattended-upgr)
 *
 * The fix is `-o DPkg::Lock::Timeout=N` on every invocation (src/lib/deploy/
 * apt.js has the RCA and the live verification). This census is the thing
 * that keeps it applied: the shell templates under carbon/ cannot import
 * APT_LOCK_OPT, so nothing but an enumerating test stops the next apt-get
 * from shipping bare — which is exactly how this class survived three
 * separate per-site mitigations without ever getting a root fix.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { APT_LOCK_OPT, APT_LOCK_TIMEOUT_SECONDS, aptGet } from '../../../src/lib/deploy/apt.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Roots that can ship an apt-get onto a node we provision. */
const ROOTS = [join(ROOT, 'src'), join(ROOT, 'carbon')];
const EXTS = ['.js', '.sh', '.yaml', '.yml'];
const EXTRA_FILES = ['Dockerfile'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next', 'build']);

/**
 * Sites that legitimately need no lock timeout, each with the reason it is
 * exempt. Keeping them enumerated (rather than un-walked) means an exemption
 * has to be argued for in this list instead of silently existing.
 */
const EXEMPT: Record<string, string> = {
  // carbon/db/Dockerfile was exempt here while it ran apt-get in an image
  // build; the PG17/Alpine move removed its last apt-get, so the census is
  // exemption-free. Argue any new entry in a comment like this one.
};

// A site is a literal `apt-get …` OR a call to the shared helper — the .js
// sites that route through aptGet() emit no literal, and a census that only
// looked for the literal would stop seeing them the moment they were fixed.
const APT_GET = /\bapt-get\s|\baptGet\(/;
// A line satisfies the census by carrying the literal option, or by
// interpolating the shared constant (the .js sites import APT_LOCK_OPT).
const HAS_TIMEOUT = /DPkg::Lock::Timeout|APT_LOCK_OPT|aptGet\(/;

function isComment(line: string, file: string): boolean {
  const t = line.trim();
  if (file.endsWith('.js')) return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  return t.startsWith('#');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((x) => e.endsWith(x)) || EXTRA_FILES.includes(e)) out.push(p);
  }
  return out;
}

function aptSites() {
  const sites: { rel: string; line: number; text: string }[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(ROOT, file);
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (!APT_GET.test(line)) return;
          // Comments must never satisfy OR trip the census: an explanatory
          // comment that names apt-get is not a call site, and one that names
          // DPkg::Lock::Timeout must not vouch for the code beneath it.
          if (isComment(line, file)) return;
          sites.push({ rel, line: i + 1, text: line.trim() });
        });
    }
  }
  return sites;
}

describe('apt lock-timeout census', () => {
  it('every apt-get site in src/ and carbon/ waits for the dpkg lock', () => {
    const offenders = aptSites()
      .filter((s) => !(s.rel in EXEMPT))
      .filter((s) => !HAS_TIMEOUT.test(s.text));

    expect(
      offenders,
      `apt-get without ${APT_LOCK_OPT} — these fail outright when ` +
        'unattended-upgrades holds dpkg lock-frontend on first boot:\n' +
        offenders.map((o) => `  ${o.rel}:${o.line}  ${o.text}`).join('\n'),
    ).toEqual([]);
  });

  it('finds the whole known class, so the census cannot pass vacuously', () => {
    const sites = aptSites();
    // wireguard.js (2) + apt.js helper (1) + 4 cloud-init programs (8)
    // + 6 k3s init scripts (12) + the exempt Dockerfile (2).
    expect(sites.length).toBeGreaterThanOrEqual(20);

    // The three groups must each still be represented — a refactor that moves
    // one group out from under the walk would otherwise silently shrink the
    // census while still passing.
    const files = new Set(sites.map((s) => s.rel));
    expect(files).toContain('src/lib/deploy/wireguard.js');
    for (const p of ['digitalocean', 'linode', 'vultr', 'scaleway']) {
      expect(files).toContain(`src/lib/iac/programs/${p}-compose.js`);
    }
    for (const s of ['supabase', 'master', 'worker', 'do-supabase', 'do-master', 'do-worker']) {
      expect(files).toContain(`carbon/cloud-init/k3s/${s}-init.sh`);
    }
  });

  it('every exemption names a file that still exists and still has an apt-get', () => {
    // A stale exemption is a hole: it would keep excusing a path that has
    // since moved onto a provisioned node.
    const byFile = new Set(aptSites().map((s) => s.rel));
    for (const rel of Object.keys(EXEMPT)) {
      expect(byFile, `exemption for ${rel} is stale — no apt-get there any more`).toContain(rel);
    }
  });

  it('the fuser poll loop does not come back', () => {
    // The k3s scripts used to pre-poll `fuser` on three lock files. It never
    // checked lock-frontend (the lock that actually fails us) and, being a
    // pre-check, it was TOCTOU. Letting apt block on the real locks replaces
    // it; a re-added loop would be a timer racing the thing apt already does
    // correctly.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = readFileSync(file, 'utf-8');
        if (/fuser\s+\/var\/lib\/dpkg\/lock/.test(text)) offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders, 'dpkg lock poll loop reintroduced').toEqual([]);
  });
});

describe('the shared apt constant', () => {
  it('APT_LOCK_OPT is the apt option apt actually parses', () => {
    // Positional detail matters: apt only honours -o before the subcommand,
    // and the key is case-sensitive.
    expect(APT_LOCK_OPT).toBe(`-o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}`);
    expect(aptGet('install -y curl')).toBe(
      `apt-get -o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS} install -y curl`,
    );
  });

  it('the timeout is finite and long enough to outlast a first-boot upgrade run', () => {
    // Negative would mean "wait forever", turning a wedged dpkg into a hung
    // step with no error. Too short and we are back to losing the coin flip.
    expect(APT_LOCK_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(120);
    expect(Number.isFinite(APT_LOCK_TIMEOUT_SECONDS)).toBe(true);
  });
});
