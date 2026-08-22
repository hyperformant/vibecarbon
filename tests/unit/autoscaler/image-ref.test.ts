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
  CLUSTER_AUTOSCALER_IMAGE,
  CLUSTER_AUTOSCALER_TAG,
  CLUSTER_AUTOSCALER_UPSTREAM_IMAGE,
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  clusterAutoscalerUpstreamRef,
} from '../../../src/lib/images.js';

const ROOT = process.cwd();
const DOCKERFILE_PATH = join(ROOT, 'docker', 'carbon-autoscaler', 'Dockerfile');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'publish-images.yml');
const PACKAGE_JSON_PATH = join(ROOT, 'package.json');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('carbon-autoscaler image ref', () => {
  it('is the pre-published amd64 tag (no project/sha/timestamp)', () => {
    expect(CARBON_AUTOSCALER_IMAGE).toBe('ghcr.io/hyperformant/carbon-autoscaler');
    expect(CARBON_AUTOSCALER_TAG).toBe('0.1.3');
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
    // mirror that copied v1.32.7 under a different tag would silently unpin
    // every cluster. Both refs derive from CLUSTER_AUTOSCALER_TAG, so they
    // cannot diverge.
    expect(clusterAutoscalerUpstreamRef().split(':').pop()).toBe(CLUSTER_AUTOSCALER_TAG);
    expect(clusterAutoscalerImageRef().split(':').pop()).toBe(CLUSTER_AUTOSCALER_TAG);
  });
});

describe('cluster-autoscaler image ref (ghcr mirror of the upstream image)', () => {
  it('deploys from our ghcr org, at upstream’s exact tag', () => {
    expect(CLUSTER_AUTOSCALER_IMAGE).toBe('ghcr.io/hyperformant/cluster-autoscaler');
    expect(CLUSTER_AUTOSCALER_UPSTREAM_IMAGE).toBe(
      'registry.k8s.io/autoscaling/cluster-autoscaler',
    );
    expect(CLUSTER_AUTOSCALER_TAG).toBe('v1.32.7');
    expect(clusterAutoscalerImageRef()).toBe(
      `${CLUSTER_AUTOSCALER_IMAGE}:${CLUSTER_AUTOSCALER_TAG}`,
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

  it('is a version tag, never a digest pin (house rule) and never per-deploy unique', () => {
    expect(clusterAutoscalerImageRef()).not.toContain('@sha256:');
    expect(clusterAutoscalerImageRef()).toBe(clusterAutoscalerImageRef());
    expect(clusterAutoscalerImageRef()).not.toMatch(/dirty|\d{14}/);
  });
});

describe('every cluster-autoscaler reference site is pinned to the constant', () => {
  it('the shipped Deployment runs the mirrored image', () => {
    const deployment = read('carbon/k8s/base/cluster-autoscaler/deployment.yaml');
    // Literal, not a placeholder: this manifest also ships into the customer's
    // repo, where `kubectl apply -k k8s/base/cluster-autoscaler/` (the usage
    // its own kustomization.yaml documents) has no deploy-time patch step.
    expect(deployment).toContain(`image: ${clusterAutoscalerImageRef()}`);
  });

  it('applyK3sManifests re-pins BOTH container images in one `set image` call', () => {
    // Belt-and-braces for projects generated before the mirror landed: their
    // checked-in copy of the manifest still carries the registry.k8s.io ref,
    // and `vibecarbon deploy` applies from the PROJECT dir, not from carbon/.
    // The set-image makes src/lib/images.js authoritative at deploy time
    // regardless of what the project's manifest says.
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    const setImage = k3s.match(/'set',\s*\n\s*'image',[\s\S]{0,400}?\]/)?.[0];
    expect(setImage, 'kubectl set image call not found in k3s.js').toBeDefined();
    expect(setImage).toMatch(/`carbon-autoscaler=\$\{carbonAutoscalerImageRef\(\)\}`/);
    expect(setImage).toMatch(/`cluster-autoscaler=\$\{clusterAutoscalerImageRef\(\)\}`/);
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
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
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
    expect(workflow).toMatch(/GHCR_ORG_PAT/);
    // Both jobs must be bound to the environment that holds the PAT.
    const jobEnvironments = [...workflow.matchAll(/^\s{4}environment:\s*(\S+)/gm)].map((m) => m[1]);
    expect(jobEnvironments.length).toBeGreaterThanOrEqual(2);
    for (const env of jobEnvironments) expect(env).toBe('e2e-infra');
  });

  /**
   * Upstream's REAL index for v1.32.7, captured 2026-07-31 from
   * https://registry.k8s.io/v2/autoscaling/cluster-autoscaler/manifests/v1.32.7,
   * plus the attestation-shaped entry that OCI-era indexes add. Note the
   * mediaType: it is the DOCKER manifest type, not the OCI `image.manifest`
   * one — a jq filter written against the OCI type selects nothing here, which
   * is exactly the bug this fixture exists to catch.
   */
  const UPSTREAM_INDEX = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifests: [
      {
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        digest: 'sha256:b3a67e07244033d36adc1cbe236fdbf9729b968f9c1c47477e26547a78131c81',
        platform: { architecture: 'amd64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        digest: 'sha256:d2f8a85ff48287ea3e8fa0e3d39e93bb72927fc535febdfa786cf358cef6d221',
        platform: { architecture: 'arm64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        digest: 'sha256:286d76ffabc9c2f9eef068de345bf3bb86f29989463a4aaa6550c7ad9f1f7629',
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

  it('is re-runnable: it pins the source by digest resolved at run time', () => {
    // Resolving the amd64 digest from the tag and re-pushing the same index
    // makes a re-run a no-op rather than a new image. (A digest resolved
    // inside the job is NOT a digest pin in a template — the house rule is
    // about refs that ship in manifests, and the mirrored ref is a tag.)
    expect(code).toMatch(/imagetools inspect/);
    expect(code).toMatch(/\$\{?DIGEST/);
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
