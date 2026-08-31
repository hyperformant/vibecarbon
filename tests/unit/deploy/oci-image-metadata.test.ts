/**
 * Drift guard for the OCI metadata that makes this org's ghcr package pages
 * self-documenting.
 *
 * ghcr builds a container package's description from exactly one input:
 * `org.opencontainers.image.description`. There is no UI field to type one into
 * and no API to set one, so an image published without that label renders as a
 * bare list of tags — which is what all three of this org's packages looked
 * like before 2026-08-05. The label is therefore load-bearing documentation
 * that lives nowhere else, and it is invisible from inside the repo: nothing
 * fails, nothing warns, the page just goes blank again. Hence this file.
 *
 * What it pins:
 *   (a) every image THIS repo publishes to ghcr.io/hyperformant declares a
 *       description, and it is real prose rather than a placeholder;
 *   (b) `.source`/`.licenses` equal package.json's `repository.url`/`license`,
 *       so the two copies can never drift;
 *   (c) `.title` equals the ghcr package name from src/lib/images.js, so a
 *       renamed package can't leave a label pointing at the old name;
 *   (d) the LABEL block sits after the last RUN, where editing prose cannot
 *       invalidate a build layer;
 *   (e) the upstream-image MIRROR job stays annotation-free. That one is a
 *       two-way guard — see the block above `mirror-upstream-images` in
 *       .github/workflows/publish-images.yml. `imagetools
 *       create --annotation` is silently DISCARDED for a Docker-media-type
 *       source, so an annotation flag there would look like documentation and
 *       do nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARBON_AUTOSCALER_IMAGE, DB_IMAGE } from '../../../src/lib/images.js';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const packageJson = JSON.parse(read('package.json'));

/** package.json's canonical repo URL, in the form ghcr matches on. */
const SOURCE_URL = packageJson.repository.url.replace(/\.git$/, '');
const LICENSE = packageJson.license;

/** The ghcr package name is the last path segment of the image ref. */
const packageName = (imageRef: string) => imageRef.split('/').pop() as string;

/**
 * Every image this repo publishes to the org's ghcr namespace, with the package
 * page it documents. If you are here because the "knows about every Dockerfile"
 * test failed, a new publishable image appeared — give it a description rather
 * than widening the exclusion.
 *
 * DELIBERATELY ABSENT: carbon/Dockerfile and carbon/db/Dockerfile. Those build
 * the GENERATED project's images, which are published to the customer's own
 * ghcr namespace by carbon/.github/workflows/vibecarbon-build.yml. Stamping our
 * repo URL and our license onto a customer's image would be wrong on both
 * counts, and their package page is theirs to describe.
 */
const OWNED_IMAGES = [
  {
    dockerfile: join('docker', 'carbon-autoscaler', 'Dockerfile'),
    packageName: packageName(CARBON_AUTOSCALER_IMAGE),
    // Our code end to end, so a single SPDX expression is honest here.
    declaresLicense: true,
  },
  {
    dockerfile: join('docker', 'postgres-walg', 'Dockerfile'),
    packageName: packageName(DB_IMAGE),
    // Overwhelmingly upstream bits (PostgreSQL, the supabase extension set,
    // wal-g) under a mix of licenses; our contribution is one RUN layer. Any
    // single SPDX expression would be a compliance claim we cannot back, and an
    // absent label reads as "unknown" — which is the truth. See the Dockerfile.
    declaresLicense: false,
  },
  {
    dockerfile: join('docker', 'wal-g', 'Dockerfile'),
    packageName: 'wal-g',
    // Entirely upstream wal-g source (Apache-2.0) compiled by us — but the
    // static binary embeds dozens of Go module licenses, so the same
    // "absent reads as unknown" reasoning as postgres-walg applies.
    declaresLicense: false,
  },
] as const;

/** Collapse backslash continuations so each entry is one logical instruction. */
function logicalInstructions(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** `key="value"` pairs across every LABEL instruction in the file. */
function labels(dockerfile: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const instruction of logicalInstructions(dockerfile)) {
    if (!/^LABEL\s/.test(instruction)) continue;
    for (const [, key, value] of instruction.matchAll(/([\w.]+)="([^"]*)"/g)) {
      out[key] = value;
    }
  }
  return out;
}

describe.each(OWNED_IMAGES)(
  'ghcr.io/hyperformant/$packageName package page metadata',
  ({ dockerfile, packageName: pkg, declaresLicense }) => {
    const contents = read(dockerfile);
    const label = labels(contents);
    const why =
      `\n\n${dockerfile} publishes ghcr.io/hyperformant/${pkg}. ` +
      `org.opencontainers.image.description is the ONLY thing ghcr renders as that page's ` +
      `description — there is no UI field and no API for it, so dropping the label silently ` +
      `blanks the page.`;

    it('declares a description', () => {
      expect(label['org.opencontainers.image.description'], why).toBeDefined();
    });

    it('the description is real prose, not a stub', () => {
      // A one-liner that says "postgres" documents nothing. The floor is low on
      // purpose — this catches a placeholder, it does not grade the writing.
      const description = label['org.opencontainers.image.description'] ?? '';
      expect(
        description.length,
        `description is ${description.length} chars${why}`,
      ).toBeGreaterThan(80);
      expect(description, 'unrendered template placeholder in the description').not.toMatch(
        /\{\{|\$\{|TODO|FIXME/,
      );
    });

    it('the description survives HTML-ish rendering', () => {
      // The label is written once and read on a web page we do not control. An
      // angle-bracketed `<placeholder>` is at the mercy of whatever ghcr does
      // with HTML-looking text, and a silently swallowed word beats no warning
      // at all. Spell it out in prose instead.
      expect(
        label['org.opencontainers.image.description'],
        'angle brackets in a description can be eaten as markup on the package page',
      ).not.toMatch(/[<>]/);
    });

    it('titles itself with the ghcr package name from src/lib/images.js', () => {
      // Renaming the package without renaming the label would leave the page
      // announcing a name that no longer exists.
      expect(label['org.opencontainers.image.title']).toBe(pkg);
    });

    it("sources itself from package.json's repository.url", () => {
      // One canonical URL for the repo, asserted rather than copy-pasted. ghcr
      // links a repo's README to a package only when the two share an owner, so
      // this value is also what makes that link possible at all.
      expect(label['org.opencontainers.image.source']).toBe(SOURCE_URL);
    });

    it(
      declaresLicense
        ? "declares package.json's license"
        : 'declares no license (aggregate of upstream licenses — see the Dockerfile)',
      () => {
        if (declaresLicense) {
          expect(label['org.opencontainers.image.licenses']).toBe(LICENSE);
        } else {
          expect(label['org.opencontainers.image.licenses']).toBeUndefined();
        }
      },
    );

    it('puts the LABEL block after the last RUN so prose edits cost no rebuild', () => {
      // LABEL is config metadata, not a filesystem layer. Placed above the
      // build work it would still produce a correct image, but every reworded
      // sentence would invalidate the cache for everything below it.
      const instructions = logicalInstructions(contents);
      const lastRun = instructions.findLastIndex((i) => /^RUN\s/.test(i));
      const firstLabel = instructions.findIndex((i) => /^LABEL\s/.test(i));
      expect(lastRun, `no RUN instruction in ${dockerfile}`).toBeGreaterThan(-1);
      expect(firstLabel, `no LABEL instruction in ${dockerfile}`).toBeGreaterThan(-1);
      expect(firstLabel, `${dockerfile}: LABEL precedes a RUN`).toBeGreaterThan(lastRun);
    });
  },
);

describe('the two descriptions are independently written', () => {
  it('no image reuses another image’s description', () => {
    // Two packages, two purposes. A shared string means one of the pages is
    // lying about what you are about to pull.
    const descriptions = OWNED_IMAGES.map(
      ({ dockerfile }) => labels(read(dockerfile))['org.opencontainers.image.description'],
    );
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe('docker/ holds no undocumented publishable image', () => {
  it('knows about every Dockerfile under docker/', () => {
    // docker/ is exactly "images this repo publishes to our own ghcr org", so a
    // new subdirectory here is a new package page. Triage it into OWNED_IMAGES
    // rather than letting it ship blank.
    const found = readdirSync(join(ROOT, 'docker'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'Dockerfile')
      .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
      .sort();
    expect(found).toEqual(OWNED_IMAGES.map((i) => i.dockerfile).sort());
  });
});

describe('the upstream-image mirror stays annotation-free', () => {
  const WORKFLOW = join('.github', 'workflows', 'publish-images.yml');
  const workflow = read(WORKFLOW);
  // The MIRROR job's body only. The publish job above it builds our own image
  // and is free to use whatever metadata mechanism it likes; this guard is
  // about the one job that must not touch the bits it copies.
  const jobStart = workflow.indexOf('\n  mirror-upstream-images:');
  const mirrorJob = workflow.slice(jobStart);
  // Executable YAML only — the reasoning lives in the comments, which are
  // allowed (and required, below) to spell the flag out.
  const code = mirrorJob
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('isolated the mirror job', () => {
    expect(jobStart, `${WORKFLOW}: mirror-upstream-images job not found`).toBeGreaterThan(-1);
    expect(code).not.toMatch(/build-push-action/);
  });

  it('passes no --annotation to imagetools create', () => {
    // Measured against buildx v0.35.0 on 2026-08-05: `imagetools create`
    // derives its output media type from the SOURCE, upstream's child manifests
    // are application/vnd.docker.distribution.manifest.v2+json, and a Docker
    // manifest LIST has no `annotations` field — so every prefix (bare,
    // index:, manifest:, manifest-descriptor:, index-descriptor:) is accepted
    // without a warning and DISCARDED. The pushed index came out byte-identical
    // to one created with no flag at all. A --annotation line here would read
    // as documentation and do nothing.
    //
    // If upstream moves to OCI media types this becomes legitimate: re-probe
    // with `docker buildx imagetools inspect --raw <upstream ref>`, and when
    // .manifests[].mediaType reads application/vnd.oci.image.manifest.v1+json,
    // add the flag AND rewrite this test and the PACKAGE PAGE note together.
    expect(
      code,
      `${WORKFLOW}: --annotation is a silent no-op for a Docker-media-type source. ` +
        `Read the PACKAGE PAGE block above the mirror-upstream-images job before adding it.`,
    ).not.toMatch(/--annotation/);
  });

  it('keeps the note explaining why the page is bare', () => {
    // Absence with no explanation invites a future "fix" that silently does
    // nothing. The note is the artifact; this pins it in place.
    expect(workflow).toMatch(/#\s*PACKAGE PAGE:/);
    expect(workflow).toMatch(/org\.opencontainers\.image\.description/);
  });

  it('still never rebuilds the mirrored image', () => {
    // The reason a LABEL is off the table for that package in the first place:
    // a LABEL lives in the image config, and writing one means building.
    expect(code).toMatch(/docker buildx imagetools create/);
  });
});
