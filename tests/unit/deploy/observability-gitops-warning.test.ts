import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { observabilityGitopsWarning } from '../../../src/lib/deploy/k8s/gitops-deploy.js';

// H-9: observability is isolated OUT of k8s/base, and the gitops/Flux path
// reconciles only k8s/base with no Flux wiring for it yet — so a gitops deploy
// won't ship observability. deployK8sGitOps must warn the operator loudly rather
// than silently omit it. This locks in that the warning fires exactly when
// observability is installed.

describe('observabilityGitopsWarning', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-obs-gitops-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when observability is not installed', () => {
    expect(observabilityGitopsWarning(dir)).toBeNull();
  });

  it('warns (and names the gitops path) when observability is installed', () => {
    mkdirSync(join(dir, 'k8s', 'base', 'observability'), { recursive: true });
    writeFileSync(
      join(dir, 'k8s', 'base', 'observability', 'kustomization.yaml'),
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n',
    );
    const warning = observabilityGitopsWarning(dir);
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/gitops/i);
    expect(warning).toMatch(/NOT be deployed|not wired|absent/i);
  });
});
