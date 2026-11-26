/**
 * Census: the tag `configure cicd` checks ghcr for before it hands a cluster
 * to Flux (FLUX_APP_TAG, assertAppImageBuilt in ghcr-pull-secret.js) is the
 * tag Flux rolls the app to: every app image line in the template's k8s/base
 * ends with it. A base that moved to another tag would have the handover
 * check one image while Flux deploys another.
 *
 * Scope: every file under carbon/k8s/base.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLUX_APP_TAG } from '../../../src/lib/deploy/k8s/ghcr-pull-secret.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';

const APP_IMAGE = 'image: ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}:';

const appImageLines = () =>
  sourceFiles(join(REPO_ROOT, 'carbon', 'k8s', 'base'), { relativeTo: REPO_ROOT }).flatMap((file) =>
    readRepoFile(file)
      .split('\n')
      .map((line, i) => ({ at: `${file}:${i + 1}`, line: line.trim() }))
      .filter(({ line }) => line.startsWith(APP_IMAGE)),
  );

describe('Flux rolls the app to the tag the handover checks', () => {
  it('finds the app image lines (the scan is not vacuous)', () => {
    expect(appImageLines().length).toBeGreaterThan(0);
  });

  it(`every app image line in carbon/k8s/base ends with :${FLUX_APP_TAG}`, () => {
    const other = appImageLines().filter(({ line }) => line !== `${APP_IMAGE}${FLUX_APP_TAG}`);
    expect(other).toEqual([]);
  });
});
