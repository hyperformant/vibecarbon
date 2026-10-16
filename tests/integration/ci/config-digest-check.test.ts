/**
 * Executes the "Check the pushed image is the smoke-tested one" step of
 * .github/workflows/native-multiarch-image.yml exactly as written, under bash,
 * with a `docker` shim on PATH that answers `docker buildx imagetools inspect
 * --raw <name>@<digest>` from fixtures (a stand-in for the registry).
 *
 * The step is the only thing between a pushed digest and the merge, so it must
 * fail closed. The fixtures mirror what buildx really pushes: by default the
 * push build carries a provenance attestation, so the pushed digest names an
 * index of [image manifest, attestation manifest] and buildx reports no config
 * digest for it (the first real run failed on exactly that). The step reads
 * the image manifest's config digest out of the registry and compares it with
 * the smoke build's. (Static pins live in
 * tests/unit/deploy/workflow-platforms.test.ts.)
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string };
const wf = loadYaml(
  readFileSync(join(process.cwd(), '.github/workflows/native-multiarch-image.yml'), 'utf8'),
) as { jobs: { build: { steps: Step[] } } };
const script = wf.jobs.build.steps.find(
  (s) => s.name === 'Check the pushed image is the smoke-tested one',
)?.run;

const NAME = 'ghcr.io/example/img';
const d = (c: string) => `sha256:${c.repeat(64)}`;
const CONFIG = d('c');
const OTHER_CONFIG = d('e');
const IMAGE = d('1'); // the platform image manifest
const ATTEST = d('2'); // its provenance attestation manifest
const INDEX = d('3'); // what an attested push reports as its digest
const TWO = d('4'); // an index holding two images
const BARE = d('5'); // an unattested push: a bare manifest
const WEIRD = d('6'); // something that is neither

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const imageEntry = (digest: string, arch: string) => ({
  mediaType: OCI_MANIFEST,
  digest,
  size: 482,
  platform: { architecture: arch, os: 'linux' },
});
const attestEntry = {
  mediaType: OCI_MANIFEST,
  digest: ATTEST,
  size: 566,
  annotations: {
    'vnd.docker.reference.digest': IMAGE,
    'vnd.docker.reference.type': 'attestation-manifest',
  },
  platform: { architecture: 'unknown', os: 'unknown' },
};
const manifest = (config: string) => ({
  schemaVersion: 2,
  mediaType: OCI_MANIFEST,
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config, size: 900 },
  layers: [],
});

const dir = mkdtempSync(join(tmpdir(), 'config-digest-check-'));
const registry = join(dir, 'registry');
mkdirSync(registry);
const put = (digest: string, body: unknown) =>
  writeFileSync(join(registry, digest.replace(':', '_')), JSON.stringify(body));

put(INDEX, {
  schemaVersion: 2,
  mediaType: OCI_INDEX,
  manifests: [imageEntry(IMAGE, 'arm64'), attestEntry],
});
put(TWO, {
  schemaVersion: 2,
  mediaType: OCI_INDEX,
  manifests: [imageEntry(IMAGE, 'arm64'), imageEntry(BARE, 'amd64')],
});
put(IMAGE, manifest(CONFIG));
put(BARE, manifest(CONFIG));
put(WEIRD, { schemaVersion: 2, mediaType: 'application/vnd.example.thing+json' });

// `docker buildx imagetools inspect --raw <name>@<digest>`: print the fixture,
// or fail like a registry miss. Any other invocation is a test bug.
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'docker'),
  `#!/usr/bin/env bash
set -euo pipefail
[ "$1 $2 $3 $4" = "buildx imagetools inspect --raw" ] || { echo "unexpected: docker $*" >&2; exit 98; }
case "$5" in "${NAME}@"*) ;; *) echo "wrong repository: $5" >&2; exit 97;; esac
f="${registry}/$(echo "\${5#*@}" | tr : _)"
[ -f "$f" ] || { echo "ERROR: $5: not found" >&2; exit 1; }
cat "$f"
`,
);
chmodSync(join(bin, 'docker'), 0o755);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(SMOKED: string, DIGEST: string, PLATFORM = 'linux/arm64') {
  return spawnSync('bash', ['-c', script ?? 'exit 99'], {
    env: { PATH: `${bin}:${process.env.PATH}`, SMOKED, DIGEST, NAME, PLATFORM },
    encoding: 'utf8',
  });
}

describe('config digest check step', () => {
  it('is found in the workflow', () => {
    expect(script).toBeTruthy();
  });

  it('attested push (an index) whose image is the smoked one: passes', () => {
    const r = check(CONFIG, INDEX);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(CONFIG);
  });

  it('attested push whose image differs from the smoked one: fails', () => {
    const r = check(OTHER_CONFIG, INDEX);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is not the smoke-tested');
  });

  it('unattested push (a bare manifest) that matches: passes', () => {
    expect(check(CONFIG, BARE).status).toBe(0);
  });

  it('the pushed image is another platform: fails', () => {
    const r = check(CONFIG, INDEX, 'linux/amd64');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is linux/arm64, not linux/amd64');
  });

  it('the pushed index holds more than one image: fails', () => {
    const r = check(CONFIG, TWO);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('holds 2 images, not one');
  });

  it('the pushed digest is neither an image nor an index: fails', () => {
    const r = check(CONFIG, WEIRD);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not an image or index');
  });

  it('the pushed digest is not in the registry: fails', () => {
    expect(check(CONFIG, d('9')).status).not.toBe(0);
  });

  it('both inputs missing: fails (two empty strings must not compare equal)', () => {
    const r = check('', '');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('smoke build reported no image config digest');
  });

  it('the push reported no digest: fails before asking the registry', () => {
    const r = check(CONFIG, '');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('push build reported no digest');
  });

  it('the smoke build reported no config digest: fails', () => {
    expect(check('', INDEX).status).not.toBe(0);
  });
});
