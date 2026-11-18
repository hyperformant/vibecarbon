import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { copyK8sTemplate } from '../../../src/create.js';
import { REPO_ROOT } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

/**
 * Every Flux Kustomization the template ships builds a directory a new
 * project has. From the first public release the cluster files carried a
 * second Kustomization at ./k8s/overlays/production-nbg1 (primary) and
 * ./k8s/overlays/production-hel1 (standby), overlays no project ever got.
 * On every cluster `configure cicd` set up, that Kustomization failed its
 * build on every reconcile, and the workflow never noticed: it waits on
 * vibecarbon-base only.
 *
 * A Flux path is relative to the root of the repository its GitRepository
 * clones, which is the project itself, so each path is resolved in the k8s/
 * tree `create` lays down, by create's own copy (copyK8sTemplate).
 */

type Doc = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: { path?: string; sourceRef?: { kind?: string; name?: string }; url?: string };
};

const CLUSTERS = join(REPO_ROOT, 'carbon/k8s/flux/clusters');
const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];

/** Every cluster file, by directory walk, so a new cluster or file is covered. */
const clusterFiles = readdirSync(CLUSTERS)
  .filter((name) => statSync(join(CLUSTERS, name)).isDirectory())
  .flatMap((cluster) =>
    readdirSync(join(CLUSTERS, cluster))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `${cluster}/${f}`),
  )
  .sort();

const docsOf = (file: string) =>
  (loadAll(readFileSync(join(CLUSTERS, file), 'utf-8')) as Doc[]).filter(Boolean);

const isFluxKustomization = (d: Doc) =>
  d.kind === 'Kustomization' && /^kustomize\.toolkit\.fluxcd\.io\//.test(d.apiVersion ?? '');

/** The k8s/ tree a new project gets, copied by create's own rule. */
function createdK8sTree(): string {
  const dir = createTempDir('vc-flux-paths-');
  copyK8sTemplate(dir, { PROJECT_NAME: 'proj', GITHUB_OWNER: 'proj' });
  return dir;
}

describe('Flux Kustomization paths', () => {
  it('the walk is real: both cluster files, each with at least one Kustomization', () => {
    expect(clusterFiles).toEqual(expect.arrayContaining(['primary/vibecarbon.yaml']));
    expect(clusterFiles).toEqual(expect.arrayContaining(['standby/vibecarbon.yaml']));
    for (const file of clusterFiles) {
      expect(docsOf(file).filter(isFluxKustomization).length, file).toBeGreaterThan(0);
    }
  });

  describe.each(clusterFiles)('%s', (file) => {
    const docs = docsOf(file);
    const repos = docs.filter((d) => d.kind === 'GitRepository');

    it('clones the project itself, so its paths are relative to the project root', () => {
      expect(repos.map((r) => r.spec?.url)).toEqual([
        'https://github.com/{{GITHUB_OWNER}}/{{PROJECT_NAME}}',
      ]);
    });

    it.each(docs.filter(isFluxKustomization).map((d) => [d.metadata?.name, d] as const))(
      'Kustomization %s builds a directory a new project has',
      (name, ks) => {
        expect(ks.spec?.sourceRef, `${name} reads the project's GitRepository`).toEqual({
          kind: 'GitRepository',
          name: repos[0]?.metadata?.name,
        });
        const path = ks.spec?.path;
        expect(path, `${name} names its path (Flux would build the whole repo)`).toBeTruthy();
        const project = createdK8sTree();
        const dir = join(project, path as string);
        const inProject = relative(project, dir);
        expect(
          inProject.startsWith('..') || isAbsolute(inProject),
          `${name}: ${path} is outside the project`,
        ).toBe(false);
        expect(
          existsSync(dir) && statSync(dir).isDirectory(),
          `${name}: ${path} is not in a new project's tree. Flux fails this Kustomization's ` +
            'build on every reconcile. Point it at a directory create lays down, or ship that ' +
            'directory in carbon/k8s.',
        ).toBe(true);
        expect(
          KUSTOMIZATION_FILES.some((f) => existsSync(join(dir, f))),
          `${name}: ${path} has no kustomization.yaml`,
        ).toBe(true);
      },
    );
  });
});
