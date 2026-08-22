/**
 * Census of mitigation ATTRIBUTION (2026-08-15).
 *
 * Background: the attribution audit of 2026-08-15 classified 48
 * attribution-bearing commits (10 proven-external / 15 asserted-external /
 * 23 ours) and found five documented cases where an asserted "flake" later
 * proved to be our own defect (5a82331d, 8e45726c, 3dd719ac, 0fbb296f,
 * d592ec6f). The failure mode is structural: an external attribution
 * asserted from error text alone carries no proof debt, so mitigation
 * layers accrete against it unchallenged — seven layers deep in
 * src/lib/iac/index.js before the 2026-08-14 post-mortem called it.
 *
 * THIS test is the accumulator those incidents lacked. It walks the
 * mitigation machinery (transient classifiers via the sibling census's
 * REGISTRY, retry-ladder delay constants via its own detector) and requires
 * every site to be registered in docs/mitigations.yml under a root-cause
 * CLASS with an explicit attribution. The registry then enforces the
 * standing rule (AGENTS.md "Mitigation policy"):
 *
 *   1 mitigation per root-cause class, with proof of RCA. A second
 *   mitigation for the same class is prohibited until a root-cause change
 *   has LANDED — growing an unlanded class requires visibly bumping its
 *   frozenSites cap in a file whose header forbids exactly that.
 *
 * Rules mechanized below:
 *   R1 anti-masking — every INFRA_PATTERNS reason (the e2e flake-retry
 *      gate) maps to a class whose attribution is NOT 'ours'. Our own
 *      defects must never be eligible for scenario auto-retry (the
 *      2026-04-27 quota row retried our own leaked servers as "infra").
 *   R2 layering cap — a class with >1 site and no landed root fix must
 *      carry frozenSites, and its site count may not exceed it.
 *   R3 proof debt — attribution 'external-asserted' requires an existing
 *      proof-debt spec (the discriminating experiment that would settle
 *      the attribution). Asserting is allowed; asserting for free is not.
 *   R4 evidence floor — attribution 'external-proven' requires evidence
 *      citing something hard: a run id, request id, upstream issue, URL,
 *      or commit hash. Error text and adjacency do not prove attribution.
 *   R5 coverage — every detected site is registered exactly once, and
 *      every registered detectable site is still detected (no stale rows).
 *
 * Accepted limits (mirrors the sibling censuses): watchdogs, mutexes,
 * poll gates, and inline backoff loops carry no detectable signature —
 * they are registered manually with `detectable: false` and the stale
 * check exempts them. A delay constant named outside the *DELAY(S)_MS
 * convention escapes the ladder detector; the positive controls at the
 * bottom keep the detectors themselves honest.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { INFRA_PATTERNS } from '../../e2e/utils/classify-failure.js';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const REGISTRY_PATH = 'docs/mitigations.yml';
const SIBLING_CENSUS = 'tests/unit/lib/transient-classifier-census.test.ts';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ROOT_FIX_RE = /^(landed: [0-9a-f]{7,40}|open: docs\/.+\.md|n\/a)$/;
/** Hard evidence: run id, request id, upstream issue, URL, or commit hash. */
const HARD_EVIDENCE_RE =
  /(\brun \d{6,}|request[- ]id|\btx[0-9a-f]|#\d{2,}|https?:\/\/|\b[0-9a-f]{7,40}\b)/i;

const SiteSchema = z.object({
  site: z.string().regex(/^[^\s:]\S* :: \S.*$/, 'site must be "<file> :: <name>"'),
  detectable: z.boolean().optional(),
  notes: z.string().optional(),
});

const ClassSchema = z.object({
  class: z.string().regex(/^[a-z0-9][a-z0-9-]+$/),
  attribution: z.enum(['external-proven', 'external-asserted', 'ours']),
  evidence: z.string().min(20),
  rootFix: z.string().regex(ROOT_FIX_RE).optional(),
  proofDebtSpec: z.string().optional(),
  frozenSites: z.number().int().positive().optional(),
  sites: z.array(SiteSchema).default([]),
});

const RegistrySchema = z.object({
  version: z.literal(1),
  classes: z.array(ClassSchema).min(1),
  flakeRetry: z.array(z.object({ reason: z.string().min(1), class: z.string() })),
});

type Registry = z.infer<typeof RegistrySchema>;

function loadRegistry(): Registry {
  const raw = readFileSync(join(ROOT, REGISTRY_PATH), 'utf-8');
  const parsed = RegistrySchema.safeParse(load(raw));
  if (!parsed.success) {
    throw new Error(`${REGISTRY_PATH} failed schema validation:\n${parsed.error.message}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** Retry-ladder delay constants: SCREAMING_SNAKE ending in DELAY_MS/DELAYS_MS. */
const LADDER_RE = /\bconst\s+([A-Z][A-Z0-9_]*DELAYS?_MS)\s*=/;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function walkFiles(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walkFiles(join(dir, entry.name), ext, out);
      }
    } else if (entry.name.endsWith(ext)) {
      out.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return out;
}

/** `file :: NAME` for every ladder constant in src/**.js and tests/e2e/**.ts. */
function detectLadderSites(): Set<string> {
  const sites = new Set<string>();
  const files = [
    ...walkFiles(join(ROOT, 'src'), '.js'),
    ...walkFiles(join(ROOT, 'tests/e2e'), '.ts'),
  ];
  for (const file of files) {
    for (const line of readFileSync(join(ROOT, file), 'utf-8').split('\n')) {
      if (isCommentLine(line)) continue;
      const m = LADDER_RE.exec(line);
      if (m) sites.add(`${file} :: ${m[1]}`);
    }
  }
  return sites;
}

/**
 * The classifier population is owned by the sibling census — scrape its
 * REGISTRY literals so the two censuses cannot drift: a classifier row added
 * there immediately demands a class assignment here.
 */
function scrapeClassifierSites(): Set<string> {
  const source = readFileSync(join(ROOT, SIBLING_CENSUS), 'utf-8');
  const sites = new Set<string>();
  for (const m of source.matchAll(/file: '([^']+)',\s*name: '([^']+)'/g)) {
    sites.add(`${m[1]} :: ${m[2]}`);
  }
  return sites;
}

const detected = new Set([...detectLadderSites(), ...scrapeClassifierSites()]);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('mitigation attribution census', () => {
  const registry = loadRegistry();
  const byName = new Map(registry.classes.map((c) => [c.class, c]));

  it('the detectors still see the mitigation population (not vacuously green)', () => {
    // ~45 sites existed when this was written (22 classifiers + 23 ladders).
    // A collapse toward zero means the sweep went blind — fix the detectors.
    expect(detectLadderSites().size).toBeGreaterThanOrEqual(15);
    expect(scrapeClassifierSites().size).toBeGreaterThanOrEqual(18);
  });

  it('R5: every detected mitigation site is registered in exactly one class', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const c of registry.classes) {
      for (const s of c.sites) {
        if (seen.has(s.site)) duplicates.push(`${s.site} (${seen.get(s.site)} AND ${c.class})`);
        seen.set(s.site, c.class);
      }
    }
    expect(duplicates, 'a site may belong to one root-cause class only').toEqual([]);
    const unregistered = [...detected].filter((k) => !seen.has(k));
    expect(
      unregistered,
      'New mitigation site(s) detected. Before registering: does an existing class already ' +
        'cover this root cause? If yes and its root fix has not landed, the layering cap ' +
        'below will refuse the addition — that is the point. Read the header of ' +
        `${REGISTRY_PATH} and AGENTS.md "Mitigation policy" first.`,
    ).toEqual([]);
  });

  it('R5: every registered detectable site is still detected (no stale rows)', () => {
    const stale: string[] = [];
    for (const c of registry.classes) {
      for (const s of c.sites) {
        if (s.detectable === false) continue;
        if (!detected.has(s.site)) stale.push(`${c.class}: ${s.site}`);
      }
    }
    expect(
      stale,
      'These registry sites no longer match a detected mitigation — renamed, moved, or ' +
        'deleted. Update the row (or mark detectable: false with notes) so the registry ' +
        'stays an honest inventory.',
    ).toEqual([]);
  });

  it('R2: a class with >1 site and no landed root fix is frozen at its declared size', () => {
    const violations: string[] = [];
    for (const c of registry.classes) {
      const landed = c.rootFix?.startsWith('landed: ') ?? false;
      if (c.sites.length <= 1 || landed) continue;
      if (c.frozenSites === undefined) {
        violations.push(`${c.class}: ${c.sites.length} sites, no frozenSites declared`);
      } else if (c.sites.length > c.frozenSites) {
        violations.push(
          `${c.class}: ${c.sites.length} sites exceeds frozenSites ${c.frozenSites} — ` +
            'the root cause has not been fixed; adding another mitigation layer to this ' +
            'class is exactly the accretion the 2026-08-14 Pulumi post-mortem documents. ' +
            'Land the root-cause change (rootFix: "landed: <commit>") instead.',
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("R3: every 'external-asserted' class carries an existing proof-debt spec", () => {
    const violations: string[] = [];
    for (const c of registry.classes) {
      if (c.attribution !== 'external-asserted') continue;
      if (!c.proofDebtSpec) {
        violations.push(`${c.class}: asserted-external with no proofDebtSpec`);
      } else if (!existsSync(join(ROOT, c.proofDebtSpec))) {
        violations.push(`${c.class}: proofDebtSpec does not exist: ${c.proofDebtSpec}`);
      }
    }
    expect(
      violations,
      'An external attribution asserted from error text alone is a hypothesis, not a fact ' +
        '(5 documented flips to "ours": 5a82331d, 8e45726c, 3dd719ac, 0fbb296f, d592ec6f). ' +
        'File the discriminating experiment that would settle it.',
    ).toEqual([]);
  });

  it("R4: every 'external-proven' class cites hard evidence", () => {
    const violations: string[] = [];
    for (const c of registry.classes) {
      if (c.attribution !== 'external-proven') continue;
      if (!HARD_EVIDENCE_RE.test(c.evidence)) {
        violations.push(`${c.class}: evidence cites nothing hard — "${c.evidence}"`);
      }
    }
    expect(
      violations,
      'Proven means a run id, request id, upstream issue, URL, or commit hash — not error ' +
        'text, not timing adjacency, not "stopped after retry".',
    ).toEqual([]);
  });

  it("R7: an 'ours' class may not carry mitigation sites — our bugs get fixes, not retries", () => {
    // The 2026-08-16 hardening, from the recurring-mitigation audit: every
    // class this registry ever attributed to our own code (state-backend
    // concurrency, control-plane racing, admits-too-early gates, uplink
    // contention) accumulated ladders for months while the trigger stayed.
    // The policy is now structural: a mitigation SITE may only exist for an
    // externally-caused failure. An `ours` entry is a transient placeholder
    // while its root fix is being built (rootFix: "open: <spec>"), and landing
    // the fix deletes the sites and then the class — it never converts them
    // into "tripwires", because an absorber that fires silently is camouflage,
    // not a tripwire.
    const violations: string[] = [];
    for (const c of registry.classes) {
      if (c.attribution !== 'ours') continue;
      if ((c.sites?.length ?? 0) > 0) {
        violations.push(
          `${c.class}: attribution is ours with ${c.sites.length} mitigation site(s)`,
        );
      }
    }
    expect(
      violations,
      'A retry for our own bug is a band-aid. Root-fix the trigger and delete the sites; if the ' +
        'cause is genuinely external, prove it and re-attribute with evidence.',
    ).toEqual([]);
  });

  it("R: every 'ours' class declares its root fix (landed or open spec)", () => {
    const violations: string[] = [];
    for (const c of registry.classes) {
      if (c.attribution !== 'ours') continue;
      if (!c.rootFix || c.rootFix === 'n/a') {
        violations.push(`${c.class}: attribution is ours but rootFix is ${c.rootFix ?? 'missing'}`);
      }
    }
    expect(violations, 'Owning a cause means owning its fix — landed commit or open spec.').toEqual(
      [],
    );
  });

  it('R: every rootFix "open:" and proofDebtSpec path exists on disk', () => {
    const violations: string[] = [];
    for (const c of registry.classes) {
      const openPath = c.rootFix?.startsWith('open: ') ? c.rootFix.slice('open: '.length) : null;
      if (openPath && !existsSync(join(ROOT, openPath))) {
        violations.push(`${c.class}: rootFix spec does not exist: ${openPath}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('R1: the flake-retry mapping covers every INFRA_PATTERNS reason, both directions', () => {
    const infraReasons = new Set(INFRA_PATTERNS.map((p) => p.reason));
    const mapped = new Set(registry.flakeRetry.map((r) => r.reason));
    expect(
      [...infraReasons].filter((r) => !mapped.has(r)),
      'INFRA_PATTERNS reason(s) missing from the flakeRetry mapping — every reason eligible ' +
        'for scenario auto-retry must declare which root-cause class it belongs to.',
    ).toEqual([]);
    expect(
      [...mapped].filter((r) => !infraReasons.has(r)),
      'Stale flakeRetry reason(s) — no longer present in INFRA_PATTERNS.',
    ).toEqual([]);
  });

  it("R1: no flake-retry-eligible reason maps to a class whose attribution is 'ours'", () => {
    const violations: string[] = [];
    for (const row of registry.flakeRetry) {
      const cls = byName.get(row.class);
      if (!cls) {
        violations.push(`"${row.reason}" maps to unknown class ${row.class}`);
      } else if (cls.attribution === 'ours') {
        violations.push(
          `"${row.reason}" maps to '${row.class}' (attribution: ours) — our own defects must ` +
            'never be eligible for flake auto-retry; that is how the quota row hid our leaked ' +
            'servers (71b24027, reclassified 2026-08-15).',
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('class names referenced anywhere resolve, and are unique', () => {
    expect(new Set(registry.classes.map((c) => c.class)).size).toBe(registry.classes.length);
    for (const row of registry.flakeRetry) {
      expect(byName.has(row.class), `flakeRetry class not defined: ${row.class}`).toBe(true);
    }
  });
});

describe('detector sanity (not vacuously permissive)', () => {
  it('LADDER_RE flags delay constants in any position, singular or plural', () => {
    expect(LADDER_RE.exec('const FOO_RETRY_DELAYS_MS = [1000];')?.[1]).toBe('FOO_RETRY_DELAYS_MS');
    expect(LADDER_RE.exec('  const BAR_DELAY_MS = 5_000;')?.[1]).toBe('BAR_DELAY_MS');
    expect(LADDER_RE.exec('export const PUSH_SETTLE_DELAYS_MS = [1, 2];')?.[1]).toBe(
      'PUSH_SETTLE_DELAYS_MS',
    );
  });

  it('LADDER_RE ignores camelCase locals and comment lines', () => {
    expect(LADDER_RE.exec('const fooDelaysMs = [1000];')).toBeNull();
    expect(isCommentLine('// const OLD_RETRY_DELAYS_MS = [1];')).toBe(true);
    expect(isCommentLine(' * const OLD_RETRY_DELAYS_MS = [1];')).toBe(true);
  });

  it('the sibling-census scrape sees single-line and multi-line REGISTRY rows', () => {
    const scraped = scrapeClassifierSites();
    // One known single-line row and one known multi-line row. (The multi-line
    // probe moved 2026-08-15 when STATE_BACKEND_THROTTLE_PATTERN was deleted
    // with the classifier rebuild; TRANSIENT_S3_ERROR_RE is a stable
    // multi-line row in the same registry.)
    expect(scraped.has('src/lib/fetch-retry.js :: TRANSIENT_STATUS')).toBe(true);
    expect(scraped.has('src/lib/providers/s3-base.js :: TRANSIENT_S3_ERROR_RE')).toBe(true);
  });

  it('the evidence floor rejects assertion-shaped evidence and accepts hard citations', () => {
    expect(HARD_EVIDENCE_RE.test('the error stopped happening after we retried')).toBe(false);
    expect(HARD_EVIDENCE_RE.test('matches the outages we have actually seen')).toBe(false);
    expect(HARD_EVIDENCE_RE.test('request-id tx000af1-nbg1-prod1-ceph5 in the 403 body')).toBe(
      true,
    );
    expect(HARD_EVIDENCE_RE.test('sustained 4h on run 31857911325')).toBe(true);
    expect(HARD_EVIDENCE_RE.test('upstream cert-manager#8960 matches our text')).toBe(true);
  });
});
