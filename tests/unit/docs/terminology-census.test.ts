/**
 * Positioning/terminology census — drift fails CI, not a future audit.
 * Axes pinned by the readme-multiprovider-positioning-design spec,
 * the marketing-claims-architecture-direction spec (the
 * pivot: no ownership framing, no counting claims, no subordinating "reference provider"
 * language, no hardcoded self-repo raw.githubusercontent URLs), and
 * the 4s-claims-architecture spec (the four-pillar registry:
 * Sovereign · Agnostic · Grounded · Agentic canonical order, banned framings — metal
 * ownership, provider counting, hyperscaler/composed-claim retirees, named-framework
 * compliance claims — and the provider × scenario support grid as the sole enumeration
 * surface).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTierSupported,
  DigitalOceanProvider,
  PROVIDERS,
} from '../../../src/lib/providers/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// User-facing surfaces — the "living docs" inventory, minus the two
// deliberate exemptions below.
// LICENSE files exempt (legal text).
//
// Deliberately NOT here, do not "helpfully" add:
// - docs/ROADMAP.md: a living tracker with dated tails — its shipped-item
//   entries are write-once historical
//   record (e.g. "Diamond tier retired", or citing a milestone whose actual
//   PR title contained "reference provider"). Adding it would either force
//   rewriting history to sound current (wrong) or drown the census in
//   false positives on legitimate dated citations.
// - carbon/content/docs/analytics.mdx (part of the carbon/content/** Tier-1
//   entry): its one "open source" hit describes third-party Plausible
//   Analytics, not Vibecarbon — true, unrelated to the Fair Source/FSL ban.
//   carbon/content/** isn't swept as a blanket glob for the same reason:
//   it's the generated project's own docs, which routinely describe
//   third-party tools by their real licensing. The one ban that does reach
//   it — named-framework compliance — is pinned by its own targeted check
//   below, so the whole-file exemption doesn't leave that family unguarded.
const SURFACES = [
  'README.md',
  'FEATURES.md',
  'TERMS.md',
  'AGENTS.md',
  'carbon/AGENTS.md',
  'docs/technical.md',
  'docs/design.md',
  'docs/tests.md',
  'docs/security.md',
  'docs/rto-rpo.md',
  'docs/deploy-hetzner.md',
  'docs/deploy-digitalocean.md',
  'docs/integrations/observability.md',
  'docs/integrations/n8n.md',
  'carbon/PRODUCTION.md',
  'carbon/README.md',
];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

// Recursively collect every .js file under a directory (used to walk src/ —
// the census must cover the CLASS, not a hardcoded list of known offenders).
function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// Recursively collect every .ts/.tsx file under a directory, for the
// carbon/src class-sweep (Task 8K). Excludes test/spec files (this repo's
// carbon tests live under carbon/tests/, not carbon/src/, but the filter is
// kept defensive) and carbon/src/client/locales, which is JSON-only and
// already swept by its own loop below.
const LOCALES_DIR_NAME = join('carbon', 'src', 'client', 'locales');
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full.endsWith(LOCALES_DIR_NAME)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Recursively collect every .md file under a directory, for the agent-memory
// retired-terms sweep below.
function walkMdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMdFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

// Every SURFACES doc plus every locale JSON, labelled for failure messages —
// shared by the bans that must hold across both (Task 8 A/B/C/E).
const LOCALE_DIR = join(ROOT, 'carbon', 'src', 'client', 'locales');
const LOCALE_FILES = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
function surfacesAndLocales(): Array<[string, string]> {
  const entries: Array<[string, string]> = SURFACES.map((rel) => [rel, read(rel)]);
  for (const f of LOCALE_FILES) {
    entries.push([`locales/${f}`, readFileSync(join(LOCALE_DIR, f), 'utf-8')]);
  }
  return entries;
}

// matchAll -> ±60-char context snippets, the file's established failure-
// reporting convention (see the "open source" ban above) — reused by every
// Task 8 assertion below so a failure shows the offending sentence, not just
// a filename.
function contextHits(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) =>
    text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 60),
  );
}

// ---- README architecture diagram <-> launch-assets support grid (Task 8G) ----
// Both encode the same provider x deploy-mode facts in different shapes: the
// README is a mermaid flowchart (mode nodes fanning into provider-list
// nodes), launch-assets.md is a markdown table. Extracting both into
// mode -> Set<provider> lets the test compare real facts instead of just
// checking the four provider names appear somewhere in each file.
function normalizeProviderName(name: string): string {
  if (/Hetzner/i.test(name)) return 'Hetzner';
  if (/DigitalOcean/i.test(name)) return 'DigitalOcean';
  if (/Linode/i.test(name)) return 'Linode';
  if (/Vultr/i.test(name)) return 'Vultr';
  if (/scaleway/i.test(name)) return 'Scaleway';
  return name.trim();
}

function _extractReadmeGrid(text: string): Record<string, Set<string>> {
  const codeToName: Record<string, string> = {};
  for (const m of text.matchAll(/CLI --> (\w+)\["([a-z0-9-]+)</g)) {
    codeToName[m[1]] = m[2];
  }
  const modeToProviders: Record<string, Set<string>> = {};
  const groupLine = /^\s*([A-Za-z0-9]+(?:\s*&\s*[A-Za-z0-9]+)*)\s*-->\s*P\d\[\("([^"]+)"\)\]/gm;
  for (const m of text.matchAll(groupLine)) {
    const codes = m[1].split('&').map((s) => s.trim());
    const providers = new Set(m[2].split('·').map((s) => normalizeProviderName(s)));
    for (const code of codes) {
      const name = codeToName[code];
      if (name) modeToProviders[name] = providers;
    }
  }
  return modeToProviders;
}

function _extractLaunchAssetsGrid(text: string): Record<string, Set<string>> {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => /\|\s*Deploy mode\s*\|/.test(l));
  const header = lines[headerIdx]
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const providers = header.slice(1).map(normalizeProviderName);
  const modeToProviders: Record<string, Set<string>> = {};
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    const modeMatch = cells[0].match(/`([a-z0-9-]+)`/);
    if (!modeMatch) continue;
    const set = new Set<string>();
    for (let j = 1; j < cells.length; j++) {
      if (cells[j] === '✅') set.add(providers[j - 1]);
    }
    modeToProviders[modeMatch[1]] = set;
  }
  return modeToProviders;
}

describe('terminology census', () => {
  it('never brands the project "open source" (Fair Source / FSL only)', () => {
    // No carve-out: the old "becomes MIT open source two years after
    // publication" sentence was rewritten (Task 6) to "converts to the MIT
    // license two years after publication" precisely so this ban can be
    // absolute on swept surfaces. LICENSE files stay exempt by not being in
    // SURFACES.
    for (const rel of SURFACES) {
      // These docs hard-wrap prose, so the phrase can straddle a line break
      // ("open\nsource") and slip past a line-local match — normalize
      // whitespace first, the same way the launch-assets check below does.
      const text = read(rel).replace(/\s+/g, ' ');
      const hits = [...text.matchAll(/open[- ]source/gi)].map((m) =>
        text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 60),
      );
      expect(hits, `${rel}: ${hits.join(' | ')}`).toEqual([]);
    }
  });

  it('never mentions the retired Diamond tier', () => {
    for (const rel of SURFACES) {
      expect(read(rel)).not.toMatch(/\bDiamond\b/);
    }
  });

  it('never calls DigitalOcean a "reference provider" in user-facing text', () => {
    for (const rel of SURFACES) {
      expect(read(rel)).not.toMatch(/reference[- ]provider/i);
    }
  });

  it('agent-memory notes carry no retired terms (Diamond, reference provider) when present', () => {
    // carbon/.claude/agent-memory/ is gitignored per-checkout agent scratch:
    // it is absent from CI clones and from fresh worktrees, so the existsSync
    // guard is load-bearing, not defensive padding — without it this test
    // fails everywhere but a dev machine that happens to have run agents.
    // Where it DOES exist it is read back into agent context, which makes a
    // stale "Diamond tier" or "reference provider" note a source that
    // reintroduces the exact vocabulary the surfaces above ban. This bites on
    // dev machines via the pre-push gate.
    const memoryDir = join(ROOT, 'carbon', '.claude', 'agent-memory');
    if (!existsSync(memoryDir)) return;
    const offenders: string[] = [];
    for (const file of walkMdFiles(memoryDir)) {
      const text = readFileSync(file, 'utf-8');
      for (const [label, pattern] of [
        ['Diamond', /\bDiamond\b/g],
        ['reference provider', /reference[- ]provider/gi],
      ] as Array<[string, RegExp]>) {
        const hits = contextHits(text, pattern);
        if (hits.length) {
          offenders.push(`${file.slice(ROOT.length + 1)} [${label}]: ${hits.join(' | ')}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no doc mentions VITE_ENABLED_LANGUAGES — the mechanism no longer exists in code', () => {
    // Language selection moved to `vibecarbon configure globalization`
    // (2026-08-13); no build-time env var gates locales any more. Because the
    // name is absent from the code paths that could implement it, ANY doc hit
    // is drift by construction — there is nothing it could correctly be
    // describing.
    //
    // It was a VITE_ prefixed build-time variable, so a revival lands in
    // carbon/src (the Vite app), not just the root CLI — the premise walk must
    // cover both or it proves nothing about the surface that would actually
    // host it. Scoped to code directories on purpose: the name legitimately
    // survives in a historical migration comment
    // (carbon/supabase/migrations/00005_localization_languages.sql), which
    // records the move away from the mechanism and must not trip this.
    const codeFiles = [
      ...walkJsFiles(join(ROOT, 'src')),
      ...walkJsFiles(join(ROOT, 'carbon', 'src')),
      ...walkTsFiles(join(ROOT, 'carbon', 'src')),
    ];
    expect(codeFiles.length, 'the premise walk found no code files').toBeGreaterThan(100);
    const codeHits = codeFiles
      .filter((f) => readFileSync(f, 'utf-8').includes('VITE_ENABLED_LANGUAGES'))
      .map((f) => f.slice(ROOT.length + 1));
    expect(
      codeHits,
      `VITE_ENABLED_LANGUAGES is back in code (${codeHits.join(', ')}) — this ban assumed the ` +
        'mechanism was gone. Either the revival is intentional (delete this test) or it is a regression.',
    ).toEqual([]);

    const docs = [
      ...SURFACES,
      ...readdirSync(join(ROOT, 'carbon', 'content', 'docs'))
        .filter((f) => f.endsWith('.mdx'))
        .map((f) => join('carbon', 'content', 'docs', f)),
    ];
    const offenders = docs.filter((rel) => read(rel).includes('VITE_ENABLED_LANGUAGES'));
    expect(
      offenders,
      `These docs still describe VITE_ENABLED_LANGUAGES: ${offenders.join(', ')}. ` +
        'Point them at `vibecarbon configure globalization` instead.',
    ).toEqual([]);
  });

  it('states the k8s-ha Hetzner-only caveat wherever DO mode support is enumerated', () => {
    for (const rel of ['README.md', 'FEATURES.md', 'docs/deploy-digitalocean.md']) {
      const text = read(rel);
      if (/compose-ha.*k8s/is.test(text) && /DigitalOcean/i.test(text)) {
        expect(text, rel).toMatch(/k8s-ha[^.\n]*Hetzner-only/i);
      }
    }
  });

  it('tier naming is exactly Graphite / Fullerene / Agency where tiers appear', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/Graphite/);
    expect(readme).toMatch(/Fullerene/);
    expect(readme).toMatch(/\$149/);
  });

  it('launch pricing is phrased "retail $299", never "was $299"', () => {
    // $299 is the standing retail price, not a price that was ever charged and
    // then cut. "was $299" is a false scarcity claim about our own history —
    // the kind of thing a consumer-protection regulator reads literally.
    let qualifying = 0;
    for (const rel of SURFACES) {
      const text = read(rel);
      if (!text.includes('$149') || !text.includes('$299')) continue;
      qualifying++;
      const hits = contextHits(text, /was \$299/gi);
      expect(hits, `${rel}: ${hits.join(' | ')} — say "retail $299", not "was $299"`).toEqual([]);
      expect(
        text,
        `${rel} pairs $149 with $299 but never says "retail $299" — the discount needs its ` +
          'anchor spelled out, or the two numbers read as an unexplained contradiction.',
      ).toContain('retail $299');
    }
    // Every assertion above sits behind a `continue`: if the price pairing ever
    // vanished from all surfaces this test would pass while checking nothing.
    // README.md and TERMS.md both carry it today.
    expect(
      qualifying,
      'No SURFACE pairs $149 with $299 any more. If pricing copy moved, move this guard with it ' +
        'rather than leaving it green and inert.',
    ).toBeGreaterThan(0);
  });

  // Was a blanket ban while the repo was still moving orgs. The move has
  // happened and `hyperformant` is the permanent home, so absolute asset URLs
  // are now REQUIRED rather than forbidden — npm renders the README outside
  // the repo, where a relative <img src> resolves to nothing and the banner
  // shows as a broken image. The guard is kept, re-pointed: any OTHER owner in
  // a self-repo raw URL is stale and still fails.
  it('self-repo raw.githubusercontent.com asset URLs name the current org, never a stale one', () => {
    for (const rel of SURFACES) {
      expect(read(rel), rel).not.toMatch(
        /raw\.githubusercontent\.com\/(?!hyperformant\/)[^/]+\/vibecarbon/i,
      );
    }
  });

  it('never uses pivot-banned framings ("servers you own", "two cloud providers", "two clouds")', () => {
    for (const rel of SURFACES) {
      const text = read(rel);
      expect(text, `${rel}: servers you own`).not.toMatch(/servers? you own/i);
      expect(text, `${rel}: two cloud providers`).not.toMatch(/two cloud providers/i);
      expect(text, `${rel}: two clouds`).not.toMatch(/\btwo clouds\b/i);
    }
  });

  it('locale files carry no banned terms (Diamond, reference provider, open-source branding, pivot literals)', () => {
    const localeDir = join(ROOT, 'carbon', 'src', 'client', 'locales');
    for (const f of readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
      const text = readFileSync(join(localeDir, f), 'utf-8');
      expect(text, `${f}: Diamond`).not.toMatch(/\bDiamond\b/);
      expect(text, `${f}: reference provider`).not.toMatch(/reference[- ]provider/i);
      // "Open Source Templates" is the single allowed use (2026-08-14 pillar
      // copy): the carbon template genuinely ships MIT. The CLI stays Fair
      // Source — any other "open source" is still banned. Claims-registry
      // rule 5 records the exception.
      const openSourceUses = (text.match(/open[- ]source(?:[- ]templates?)?/gi) ?? []).filter(
        (m) => !/templates?$/i.test(m),
      );
      expect(openSourceUses, `${f}: open source outside "Open Source Templates"`).toEqual([]);
      expect(text, `${f}: servers you own`).not.toMatch(/servers? you own/i);
      expect(text, `${f}: two cloud providers`).not.toMatch(/two cloud providers/i);
      expect(text, `${f}: two clouds`).not.toMatch(/\btwo clouds\b/i);
    }
  });

  it('never calls DigitalOcean a "reference provider" anywhere in src/ (strings or comments)', () => {
    const srcDir = join(ROOT, 'src');
    const offenders: string[] = [];
    for (const file of walkJsFiles(srcDir)) {
      const text = readFileSync(file, 'utf-8');
      if (/reference[- ]provider/i.test(text)) offenders.push(file.slice(ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  // ---- Task 8: four-pillar vocabulary + retired message-house terms ----

  it('SURFACES + locales never use metal-ownership framing ("servers you own", "held, not leased", plural "your (own) servers"), in any locale spelling', () => {
    // Plural "your servers" only — singular "your server" (e.g. "SSH into
    // your server") is legitimate technical usage and stays legal per the
    // 2026-08-09 registry's permanent ban. The optional "own" catches the
    // "your own servers" spelling that shipped in the FAQ until 9ba0b419.
    const pattern = /servers you own|held, not leased|your (own )?servers/gi;
    // The same ban, translated: the locale files carry the marketing FAQ in
    // five languages, where an English-only pattern is blind. These are the
    // stems of the pre-9ba0b419 q8 closing sentence in each non-English
    // locale (de/es/fr/pt); each verified zero-hit against the fixed files
    // before being pinned here.
    const translated = /eigenen Servern|propios servidores|propres serveurs|próprios servidores/gi;
    for (const [rel, text] of surfacesAndLocales()) {
      const hits = contextHits(text, pattern);
      expect(hits, `${rel}: ${hits.join(' | ')}`).toEqual([]);
      const translatedHits = contextHits(text, translated);
      expect(translatedHits, `${rel} (translated): ${translatedHits.join(' | ')}`).toEqual([]);
    }
  });

  it('SURFACES + locales never use retired composed-claim vocabulary (hyperscaler, "answers to you", "scaled at cost", "visible all the way down")', () => {
    const pattern = /hyperscaler|answers to you|scaled at cost|visible all the way down/gi;
    for (const [rel, text] of surfacesAndLocales()) {
      const hits = contextHits(text, pattern);
      expect(hits, `${rel}: ${hits.join(' | ')}`).toEqual([]);
    }
  });

  it('SURFACES + locales never render the retired Scalable-paired pillar enumeration, in any locale spelling', () => {
    // Pre-2026-08-10 message house paired "Scalable" with another pillar
    // ("Scalable & Secure" and its translations). Verified against every
    // locale file before adding this: fr.json legitimately contains
    // "évolutivité" (features-tier scale copy, landing.scale.subheading) —
    // this pattern requires a following "&"/"e"/"y" pair-connector per
    // language, which "évolutivité et de résilience" does not have, so it
    // does not collide. JS \b is ASCII-based and does not reliably bound
    // accented characters, so these patterns lean on explicit connectors
    // rather than \b around the accented words themselves.
    const pattern = /Scalable\s*&|Skalierbar\s*&|Évolutif\s*&|Escalável\s+e\b|Escalable\s+y\b/gi;
    for (const [rel, text] of surfacesAndLocales()) {
      const hits = contextHits(text, pattern);
      expect(hits, `${rel}: ${hits.join(' | ')}`).toEqual([]);
    }
  });

  it('SURFACES + locales never name a compliance framework as a claim (GDPR, SOC 2, HIPAA, PCI-DSS, ISO 27001, CCPA)', () => {
    // Registry's gated-claims table: named-framework compliance claims are
    // gated on the Controls Engine shipping; live copy states only the
    // posture. Commit 1d0799f0 cleaned the three known hits (FEATURES.md,
    // README.md, carbon/README.md); this pins the ban so the class can't
    // regress on any SURFACES doc or locale.
    const pattern = /GDPR|SOC ?2|HIPAA|PCI[- ]DSS|ISO ?27001|CCPA/gi;
    for (const [rel, text] of surfacesAndLocales()) {
      const hits = contextHits(text, pattern);
      expect(hits, `${rel}: ${hits.join(' | ')}`).toEqual([]);
    }
  });

  it('carbon/content/docs/analytics.mdx names no compliance framework (targeted — the file is deliberately not in SURFACES)', () => {
    // Same shape as the launch-assets check below: a file kept out of
    // SURFACES for one legitimate reason still gets the bans that do reach
    // it. Here the exemption is the "Open source" bullet describing
    // Plausible Analytics' own licensing (see the SURFACES comment), which a
    // whole-file sweep would fail on a true statement about a third-party
    // tool. The named-framework ban (family E) applies regardless: the
    // analytics doc states the mechanism — no cookies, no cross-site
    // tracking — and leaves the legal conclusion to the reader.
    const text = read('carbon/content/docs/analytics.mdx');
    const hits = contextHits(text, /GDPR|SOC ?2|HIPAA|PCI[- ]DSS|ISO ?27001|CCPA/gi);
    expect(hits, `carbon/content/docs/analytics.mdx: ${hits.join(' | ')}`).toEqual([]);
  });

  it('any pillar enumeration on a SURFACE follows registry order (Sovereign, Agnostic, Grounded, Agentic)', () => {
    const REGISTRY_ORDER = ['sovereign', 'agnostic', 'grounded', 'agentic'];
    const PILLAR_WORD = '(?:Sovereign|Agnostic|Grounded|Agentic)';
    // Consecutive pillar words joined only by "·", ",", or "and" — a
    // conservative separator set so this doesn't fire on two pillars that
    // merely appear in the same paragraph's separate sentences.
    const enumRe = new RegExp(
      `\\b${PILLAR_WORD}\\b(?:\\s*(?:·|,|and)\\s*\\b${PILLAR_WORD}\\b){1,3}`,
      'gi',
    );
    const wordRe = new RegExp(PILLAR_WORD, 'gi');
    for (const rel of SURFACES) {
      const text = read(rel);
      for (const m of text.matchAll(enumRe)) {
        const found = [...m[0].matchAll(wordRe)].map((w) => w[0].toLowerCase());
        const expected = REGISTRY_ORDER.filter((p) => found.includes(p));
        expect(found, `${rel}: "${m[0]}"`).toEqual(expected);
      }
    }
  });

  // NOTE: two launch-copy checks lived here (banned-phrase sweep + a
  // README/launch-grid parity check). They guarded a marketing document
  // that is not part of this repository, so they could only ever fail.
  // The README-side extraction they shared is still exercised by the
  // provider-coverage test below.

  it('every registered provider is named in README.md, FEATURES.md and the deployment docs page', () => {
    // The registry is the truth: registering a provider in
    // src/lib/providers/index.js is what makes `-provider <id>` work, and a
    // provider a customer can deploy to but cannot find in the docs is
    // shipped-and-invisible. Scaleway was exactly that until ef0caf53.
    // Derived from PROVIDERS so a sixth provider is enforced on the day it is
    // registered, with no test edit.
    const enumerations = ['README.md', 'FEATURES.md', 'carbon/content/docs/deployment.mdx'];
    const providers = Object.values(PROVIDERS).map((P) => normalizeProviderName(P.NAME));
    expect(providers.length, 'PROVIDERS is empty — the registry import broke').toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const rel of enumerations) {
      const text = read(rel);
      for (const name of providers) {
        // Word-anchored, and the name is escaped before it becomes a pattern:
        // a bare substring test is satisfied by an incidental mention like
        // `SCALEWAY_SECRET_KEY` in the API-token column, which is NOT the
        // provider being named as a supported provider. Escaping keeps a
        // future registry name containing a regex metacharacter from
        // silently becoming a different pattern.
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
          offenders.push(`${rel}: never names ${name}`);
        }
      }
    }
    expect(
      offenders,
      `${offenders.join('\n')}\nEvery provider in src/lib/providers/index.js must appear in ` +
        'each provider enumeration, with its supported deploy modes.',
    ).toEqual([]);
  });

  it("banner-generator.py's COPY block names no provider and no banned framing; README's banner alt matches the script's ALT string", () => {
    const bannerText = readFileSync(join(ROOT, 'scripts', 'banner-generator.py'), 'utf-8');
    const start = bannerText.indexOf('HEAD_A, HEAD_B');
    const end = bannerText.indexOf(
      '# ---------------------------------------------------------------- theme tokens',
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const copyBlock = bannerText.slice(start, end);

    expect(copyBlock).not.toMatch(/Hetzner|DigitalOcean|Linode|Vultr|Scaleway/i);
    expect(copyBlock).not.toMatch(
      /open[- ]source|\bDiamond\b|reference[- ]provider|servers? you own|two cloud|hyperscaler|answers to you|scaled at cost|visible all the way down|GDPR|SOC ?2|HIPAA|PCI[- ]DSS|ISO ?27001|CCPA/i,
    );

    // ALT is built from concatenated Python string literals across three
    // lines; extract and join them the same way Python's implicit
    // concatenation would, then compare against README's rendered alt text.
    const altAssignment = bannerText.match(/ALT = \(([\s\S]*?)\)/);
    expect(altAssignment).not.toBeNull();
    const scriptAlt = [...(altAssignment as RegExpMatchArray)[1].matchAll(/"([^"]*)"/g)]
      .map((m) => m[1])
      .join('');
    const readmeAltMatch = read('README.md').match(/src="[^"]*banner-light\.svg" alt="([^"]*)"/);
    expect(readmeAltMatch).not.toBeNull();
    expect((readmeAltMatch as RegExpMatchArray)[1]).toBe(scriptAlt);
  });

  it("every locale's landing.hero.subheading is exactly 2 sentences", () => {
    // carbon/src/client/components/Hero.tsx:518 does
    //   const [first, second] = subheading.split(/\.\s+/);
    // Only the first two destructured elements are ever bound/rendered — a
    // third sentence produced by the same split silently disappears from
    // the page, so this pins the sentence count at the copy source.
    for (const f of LOCALE_FILES) {
      const json = JSON.parse(readFileSync(join(LOCALE_DIR, f), 'utf-8'));
      const subheading: string = json.landing.hero.subheading;
      const sentences = subheading.split(/\.\s+/);
      expect(sentences, `${f}: "${subheading}"`).toHaveLength(2);
    }
  });

  it('FEATURES.md quotes the real DigitalOcean k8s-ha capability-gate error byte-identically', () => {
    // Mirror-with-drift-guard: import the real provider + guard function
    // (src/lib/providers/index.js) and trigger the actual thrown error,
    // rather than duplicating its format string — so a future wording
    // change to assertTierSupported() fails this test instead of silently
    // leaving FEATURES.md stale.
    let message = '';
    try {
      assertTierSupported(DigitalOceanProvider, 'k8s-ha');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(read('FEATURES.md')).toContain(message);
  });

  it('carbon/src file text never carries the open-source/Diamond/reference-provider/pivot/metal-ownership/composed-claim/named-framework banned terms', () => {
    const carbonSrcRoot = join(ROOT, 'carbon', 'src');
    const files = walkTsFiles(carbonSrcRoot);
    expect(files.length).toBeGreaterThan(100); // sanity: the walk actually found the tree

    const patterns: Array<[string, RegExp]> = [
      ['open source', /open[- ]source/gi],
      ['Diamond', /\bDiamond\b/g],
      ['reference provider', /reference[- ]provider/gi],
      ['servers you own', /servers? you own/gi],
      ['two cloud providers', /two cloud providers/gi],
      ['two clouds', /\btwo clouds\b/gi],
      ['metal ownership', /servers you own|held, not leased|your (own )?servers/gi],
      [
        'retired composed-claim vocabulary',
        /hyperscaler|answers to you|scaled at cost|visible all the way down/gi,
      ],
      ['named-framework compliance', /GDPR|SOC ?2|HIPAA|PCI[- ]DSS|ISO ?27001|CCPA/gi],
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const [label, pattern] of patterns) {
        const hits = contextHits(text, pattern);
        if (hits.length) {
          offenders.push(`${file.slice(ROOT.length + 1)} [${label}]: ${hits.join(' | ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the template homepage never talks "SaaS" (Brandon\'s directive: not on the stock homepage copy)', () => {
    const files = [
      ...readdirSync(join(ROOT, 'carbon', 'src', 'client', 'components', 'sections'))
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => join(ROOT, 'carbon', 'src', 'client', 'components', 'sections', f)),
      join(ROOT, 'carbon', 'src', 'client', 'pages', 'HomePreview.tsx'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      const hits = contextHits(text, /\bSaaS\b/gi);
      if (hits.length) offenders.push(`${file.slice(ROOT.length + 1)}: ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
