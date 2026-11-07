/**
 * Drift guards for BOTH images in the cluster-autoscaler pod
 * (docker/carbon-autoscaler/Dockerfile,
 * .github/workflows/publish-images.yml, src/lib/images.js).
 * Mirrors tests/unit/lib/images.test.ts's style for the DB image, plus
 * structural pins specific to these two images:
 *
 * (a) the Dockerfile's `npm install` pins the same two gRPC dep ranges as
 *     root package.json — a version bump in one without the other would
 *     silently ship a mismatched runtime dep inside the image;
 * (b) the publish workflow's `grep -oP` tag-resolution patterns actually
 *     match the current images.js lines — a rename of an exported const
 *     would otherwise fail silently in CI (empty $GITHUB_OUTPUT, not a
 *     visible test failure) until the next push-triggered publish run;
 * (c) EVERY deploy-facing reference to the upstream cluster-autoscaler image
 *     resolves through `clusterAutoscalerImageRef()` — no file may pin
 *     `registry.k8s.io/autoscaling/cluster-autoscaler` outside a comment.
 *     That mirror exists because registry.k8s.io 403s Hetzner IP ranges; see
 *     the incident block in src/lib/images.js.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARBON_AUTOSCALER_IMAGE,
  CARBON_AUTOSCALER_TAG,
  CLUSTER_AUTOSCALER_DIGEST,
  CLUSTER_AUTOSCALER_IMAGE,
  CLUSTER_AUTOSCALER_TAG,
  CLUSTER_AUTOSCALER_UPSTREAM_IMAGE,
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  clusterAutoscalerUpstreamRef,
  manifestImageValues,
} from '../../../src/lib/images.js';

const ROOT = process.cwd();
const DOCKERFILE_PATH = join(ROOT, 'docker', 'carbon-autoscaler', 'Dockerfile');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'publish-images.yml');
const MIRROR_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'mirror-images.yml');
const PACKAGE_JSON_PATH = join(ROOT, 'package.json');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('carbon-autoscaler image ref', () => {
  it('is the pre-published amd64 tag (no project/sha/timestamp)', () => {
    expect(CARBON_AUTOSCALER_IMAGE).toBe('ghcr.io/hyperformant/carbon-autoscaler');
    expect(CARBON_AUTOSCALER_TAG).toBe('0.1.5');
    expect(carbonAutoscalerImageRef()).toBe(`${CARBON_AUTOSCALER_IMAGE}:${CARBON_AUTOSCALER_TAG}`);
  });

  it('ref is stable — never per-deploy unique', () => {
    expect(carbonAutoscalerImageRef()).toBe(carbonAutoscalerImageRef());
    expect(carbonAutoscalerImageRef()).not.toMatch(/dirty|\d{14}/); // no -dirty / timestamp
  });
});

describe('Dockerfile runtime dep pins match root package.json', () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  // Every package on the Dockerfile's npm-install line, parsed generically so
  // adding a dep to the image without matching root package.json fails here.
  const installLine = dockerfile.match(/npm install[^\\\n]*/)?.[0] ?? '';
  const installed = [...installLine.matchAll(/((?:@[\w-]+\/)?[\w.-]+)@(\^?[\d][\w.^~-]*)/g)].map(
    (m) => [m[1], m[2]] as const,
  );

  it('parses at least the four known runtime deps from the install line', () => {
    const names = installed.map(([n]) => n);
    for (const dep of ['@grpc/grpc-js', '@grpc/proto-loader', 'undici', '@clack/prompts']) {
      expect(names).toContain(dep);
    }
  });

  it.each(installed)(
    '%s range in the Dockerfile matches package.json exactly',
    (depName, dockerfileRange) => {
      const packageJsonRange = packageJson.dependencies?.[depName];
      expect(
        packageJsonRange,
        `${depName} not found in root package.json dependencies`,
      ).toBeDefined();
      expect(dockerfileRange).toBe(packageJsonRange);
    },
  );

  it('image runs as a NUMERIC user (kubelet cannot verify runAsNonRoot for a named USER)', () => {
    // Field-proven 2026-07-27: USER carbon → CreateContainerConfigError under
    // the deployment's runAsNonRoot securityContext; numeric uid:gid required.
    expect(dockerfile).toMatch(/^USER \d+:\d+$/m);
  });
});

describe('publish workflow tag-resolution grep matches images.js', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const imagesJs = readFileSync(join(ROOT, 'src', 'lib', 'images.js'), 'utf8');

  // Pull each `grep -oP "<PATTERN>"` string out of the workflow and convert
  // it to an equivalent JS RegExp (grep -oP's \K becomes a plain capture), so
  // these tests fail the moment a workflow grep pattern and an images.js
  // export name drift apart — whitespace between the const name/`=`/quote is
  // tolerated on both sides, same as the workflow's own `\s*` does at run
  // time.
  const grepPatterns = [...workflow.matchAll(/grep -oP "([^"]+)"/g)].map((m) => m[1]);
  const resolve = (pattern: string) => {
    const jsPattern = pattern.replace('\\K', '');
    const [, prefix] = jsPattern.match(/^(.*?)\[\^'\]\+$/) ?? [];
    expect(prefix, `unexpected grep pattern shape: ${pattern}`).toBeDefined();
    return imagesJs.match(new RegExp(`${prefix}([^']+)`))?.[1];
  };

  it('every grep in the workflow resolves against images.js (none silently empty)', () => {
    // An unresolved pattern writes an empty value into $GITHUB_OUTPUT and the
    // job then pushes/mirrors a ref like ":" — a silent CI failure, not a
    // visible one. Every pattern must hit.
    expect(grepPatterns.length).toBeGreaterThanOrEqual(2);
    for (const pattern of grepPatterns) {
      expect(
        resolve(pattern),
        `grep -oP "${pattern}" resolves to nothing in images.js`,
      ).toBeTruthy();
    }
  });

  it('resolves exactly the constants the publish job needs', () => {
    const results = grepPatterns.map(resolve);
    // publish job (carbon-autoscaler sidecar — the image we BUILD).
    expect(results).toContain(CARBON_AUTOSCALER_IMAGE);
    expect(results).toContain(CARBON_AUTOSCALER_TAG);
  });

  it('no longer greps the MIRROR refs — those come from the matrix generator', () => {
    // The mirror set outgrew grep. It used to be two scalar constants
    // (cluster-autoscaler only, #222); it is now a list of (repo, tag) tuples
    // spanning the CSI sidecars too, which no `grep -oP` can express — it would
    // need one pattern per entry, and a pattern that matches nothing writes an
    // empty ref like ":" into $GITHUB_OUTPUT instead of failing. The workflow
    // now runs scripts/mirror-matrix.mjs, which IMPORTS src/lib/images.js, so
    // there is no pattern left to drift. Guarded end-to-end by
    // tests/unit/deploy/k8s-image-mirrors.test.ts, which executes that script.
    for (const pattern of grepPatterns) {
      expect(pattern).not.toContain('CLUSTER_AUTOSCALER');
    }
  });

  it('the CA tag still feeds source and mirror from ONE constant', () => {
    // The property #222's "grep the tag once" test protected, restated against
    // the constants themselves rather than against the (now retired) grep: a
    // mirror that copied one version under a different tag would silently unpin
    // every cluster. Both refs derive from CLUSTER_AUTOSCALER_TAG, so they
    // cannot diverge.
    expect(clusterAutoscalerUpstreamRef().split(':').pop()).toBe(CLUSTER_AUTOSCALER_TAG);
    expect(clusterAutoscalerImageRef().split('@')[0].split(':').pop()).toBe(CLUSTER_AUTOSCALER_TAG);
  });
});

describe('cluster-autoscaler image ref (ghcr mirror of the upstream image)', () => {
  it('deploys from our ghcr org, at upstream’s exact tag', () => {
    expect(CLUSTER_AUTOSCALER_IMAGE).toBe('ghcr.io/hyperformant/cluster-autoscaler');
    expect(CLUSTER_AUTOSCALER_UPSTREAM_IMAGE).toBe(
      'registry.k8s.io/autoscaling/cluster-autoscaler',
    );
    expect(CLUSTER_AUTOSCALER_TAG).toBe('v1.37.0');
    expect(clusterAutoscalerImageRef()).toBe(
      `${CLUSTER_AUTOSCALER_IMAGE}:${CLUSTER_AUTOSCALER_TAG}@${CLUSTER_AUTOSCALER_DIGEST}`,
    );
    expect(clusterAutoscalerUpstreamRef()).toBe(
      `${CLUSTER_AUTOSCALER_UPSTREAM_IMAGE}:${CLUSTER_AUTOSCALER_TAG}`,
    );
  });

  it('the deploy-facing ref never points at registry.k8s.io', () => {
    // The whole point: registry.k8s.io routes by client IP to a cloud backend
    // whose GCP leg intermittently 403s datacenter ranges (Hetzner included).
    expect(clusterAutoscalerImageRef()).not.toContain('registry.k8s.io');
    expect(clusterAutoscalerImageRef()).toMatch(/^ghcr\.io\//);
  });

  it('is upstream’s version tag plus upstream’s amd64 digest, never per-deploy unique', () => {
    // Every shipped ref is digest-pinned (tests/unit/deploy/image-digest-census.test.ts).
    // The mirror copies upstream's linux/amd64 manifest verbatim, so the
    // digest is the same on both hosts; the fixture below is that manifest.
    expect(CLUSTER_AUTOSCALER_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(clusterAutoscalerImageRef()).toMatch(/:v1\.37\.0@sha256:[a-f0-9]{64}$/);
    expect(clusterAutoscalerImageRef()).toBe(clusterAutoscalerImageRef());
    expect(clusterAutoscalerImageRef()).not.toMatch(/dirty|\d{14}/);
  });
});

describe('every cluster-autoscaler reference site is pinned to the constant', () => {
  it('the shipped Deployment runs the mirrored image', () => {
    const deployment = read('carbon/k8s/base/cluster-autoscaler/deployment.yaml');
    // A token the deploy fills from its version set, so a patch reaches a
    // deploy with no CLI release. The manifest is applied by the deploy, never
    // directly, and a leftover token fails loud before the apply.
    expect(deployment).toContain('image: "{{CLUSTER_AUTOSCALER_IMAGE}}"');
    expect(manifestImageValues().CLUSTER_AUTOSCALER_IMAGE).toBe(clusterAutoscalerImageRef());
  });

  it('applyK3sManifests renders the sidecar image and re-pins the autoscaler image', () => {
    // Belt-and-braces for projects generated before the mirror landed: their
    // checked-in copy of the manifest still carries the registry.k8s.io ref,
    // and `vibecarbon deploy` applies from the PROJECT dir, not from carbon/.
    // The set-image makes src/lib/images.js authoritative at deploy time
    // regardless of what the project's manifest says.
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    const setImage = k3s.match(/'set',\s*\n\s*'image',[\s\S]{0,400}?\]/)?.[0];
    expect(setImage, 'kubectl set image call not found in k3s.js').toBeDefined();
    expect(setImage).toMatch(/`cluster-autoscaler=\$\{clusterAutoscalerImageRef\(\)\}`/);
    expect(k3s).toMatch(
      /renderManifestImages\(manifests\)\.replaceAll\(\s*'\{\{CARBON_AUTOSCALER_IMAGE\}\}',\s*carbonAutoscalerImageRef\(\),\s*\)/,
    );
    expect(k3s).toMatch(
      /import \{[^}]*clusterAutoscalerImageRef[^}]*\} from '\.\.\/\.\.\/images\.js'/,
    );
  });

  it('no deploy-facing file pins the upstream ref outside a comment', () => {
    // src/lib/images.js is the ONE place the upstream ref may appear as a
    // literal — it is the mirror's source of truth, consumed by the mirror
    // workflow through a grep. Anywhere else it would be a pull that bypasses
    // the mirror, i.e. the 403 back in the deploy path.
    const offenders: string[] = [];
    for (const rel of sweepFiles()) {
      if (rel === join('src', 'lib', 'images.js')) continue;
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('autoscaling/cluster-autoscaler')) return;
          if (/^\s*(#|\/\/|\*|-\s*#)/.test(line)) return; // comments may name it
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, 'these sites bypass clusterAutoscalerImageRef()').toEqual([]);
  });
});

describe('mirror job copies the manifest — never rebuilds, never multi-arch', () => {
  // publish-images.yml's own job and the mirror job it calls.
  const workflow = `${readFileSync(WORKFLOW_PATH, 'utf8')}\n${readFileSync(MIRROR_WORKFLOW_PATH, 'utf8')}`;
  // Executable YAML only; comments are where the reasoning lives.
  const code = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('uses a registry-side manifest copy (imagetools create), not a build', () => {
    // A rebuild would produce different bits under upstream's version tag.
    expect(code).toMatch(/docker buildx imagetools create/);
  });

  it('selects the linux/amd64 child manifest only', () => {
    // vibecarbon is x86-64 only (see tests/unit/deploy/workflow-platforms.test.ts);
    // copying upstream's full index would haul arm64/s390x/ppc64le blobs into
    // our org for nothing.
    expect(code).toMatch(/architecture\s*==\s*"amd64"/);
    expect(code).not.toMatch(/arm64|aarch64/);
  });

  it('authenticates to ghcr the same way the publish job does', () => {
    // Pins SAMENESS, not a particular credential. This asserted `GHCR_ORG_PAT`
    // literally until 2026-08-22, when ghcr auth moved to the built-in
    // GITHUB_TOKEN (the repo now lives in the org that owns the packages, so a
    // long-lived org PAT bought nothing but a 90-day renewal). Pinning the
    // name made the guard fail on an improvement while still permitting the
    // thing it exists to prevent: two jobs drifting onto different credentials
    // and one of them silently losing push access.
    const passwords = [
      ...workflow.matchAll(
        /registry:\s*ghcr\.io[\s\S]{0,160}?password:\s*\$\{\{\s*secrets\.(\w+)\s*\}\}/g,
      ),
    ].map((m) => m[1]);
    expect(
      passwords.length,
      'expected a ghcr login in every publishing job',
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(passwords).size, `ghcr logins disagree: ${passwords.join(', ')}`).toBe(1);
    const jobEnvironments = [...workflow.matchAll(/^\s{4}environment:\s*(\S+)/gm)].map((m) => m[1]);
    expect(jobEnvironments.length).toBeGreaterThanOrEqual(2);
    for (const env of jobEnvironments) expect(env).toBe('e2e-infra');
  });

  /**
   * Upstream's REAL index for v1.37.0, captured 2026-11-05 with `docker buildx
   * imagetools inspect --raw`, plus the attestation-shaped entry that OCI-era
   * indexes add. Upstream moved from the Docker manifest types to the OCI ones
   * between 1.32 and 1.37, which is why the job selects by platform: a jq filter
   * written against one media type would select nothing on the other.
   */
  const UPSTREAM_INDEX = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:c239e40cc745d9e0f1ba7c2272eaab44ca4586cd053f13ba8c8a4a6b27b18294',
        platform: { architecture: 'amd64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:ff9c0bd82fb45e747ed3cbafe6b3ebbd5361fb672be4eb1dac9ec6fe9951dfd1',
        platform: { architecture: 'arm64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:2c1313074e4a2b4cb2326edb249b679d17fc8fa39b413ad8df5e09ee1c771e1a',
        platform: { architecture: 's390x', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.in-toto+json',
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        platform: { architecture: 'unknown', os: 'unknown' },
      },
    ],
  };

  const hasJq = (() => {
    try {
      execFileSync('jq', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasJq)(
    'its jq program actually selects the amd64 digest from upstream’s index',
    () => {
      // Runs the workflow's OWN jq program — not a paraphrase of it — against a
      // real index. A filter that matches nothing would make the job fail on
      // every run (or, worse, mirror the wrong platform).
      const jqProgram = code.match(/\| jq -r '([^']+)'/)?.[1];
      expect(jqProgram, "no `| jq -r '...'` program found in the mirror job").toBeDefined();
      const out = execFileSync('jq', ['-r', jqProgram as string], {
        input: JSON.stringify(UPSTREAM_INDEX),
        encoding: 'utf8',
      }).trim();
      expect(out).toBe(UPSTREAM_INDEX.manifests[0].digest);
    },
  );

  it('copies the PINNED digest, and fails when upstream’s tag no longer resolves to it', () => {
    // The digest every deployed ref carries comes from src/lib/images.js via
    // the matrix. The job resolves upstream's tag only to prove it still
    // points there; a moved tag fails the leg instead of shipping new bits.
    expect(code).toMatch(/imagetools inspect/);
    expect(code).toMatch(/PINNED: \$\{\{ matrix\.digest \}\}/);
    expect(code).toMatch(/if \[ "\$DIGEST" != "\$PINNED" \]/);
    expect(code).toMatch(/imagetools create --tag "\$DST" "\$\{SRC%:\*\}@\$PINNED"/);
  });

  it('the pinned CA digest is the amd64 child of upstream’s captured index', () => {
    expect(CLUSTER_AUTOSCALER_DIGEST).toBe(UPSTREAM_INDEX.manifests[0].digest);
  });
});

/**
 * Every deploy-facing source file, for the upstream-ref sweep above. Docs and
 * plans are excluded on purpose — they narrate history and MUST be free to
 * name the upstream ref.
 */
function sweepFiles(): string[] {
  const dirs = ['src', join('carbon', 'k8s'), join('.github', 'workflows')];
  const exts = new Set(['.js', '.ts', '.yaml', '.yml', '.json', '.sh']);
  const files: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const abs = join(entry.parentPath, entry.name);
      const rel = relative(ROOT, abs);
      if (rel.split(sep).includes('node_modules')) continue;
      if (!exts.has(extname(entry.name))) continue;
      files.push(rel);
    }
  }
  return files;
}
