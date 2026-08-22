import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mutateAppHealthRoute,
  mutateConfigMapManifest,
  WARM_REDEPLOY_APP_FILE,
  WARM_REDEPLOY_CONFIGMAP_KEY,
  WARM_REDEPLOY_MANIFEST_FILE,
  WARM_REDEPLOY_ROUTE_URL_PATH,
  warmRedeployMarker,
} from '../../e2e/utils/warm-redeploy-mutations.js';

/**
 * The `warm-redeploy-change` e2e step edits two files in the generated project
 * and then asserts both edits reached the cluster. If a mutator's ANCHOR rots
 * (someone reshapes the template), the step would either throw at an unhelpful
 * place or — much worse — write the file back unchanged and then "prove" that
 * an unchanged file is live. That is the vacuous-guard failure mode.
 *
 * So these tests run the mutators against the REAL template files the CLI
 * copies into a project (`carbon/k8s/base/config/configmap.yaml`,
 * `carbon/src/server/routes/health.ts`), not hand-written fixtures. A template
 * reshape fails here, in the unit tier, instead of 40 minutes into an e2e run.
 */

const REPO_ROOT = process.cwd();
const TEMPLATE_MANIFEST = join(REPO_ROOT, 'carbon', WARM_REDEPLOY_MANIFEST_FILE);
const TEMPLATE_APP = join(REPO_ROOT, 'carbon', WARM_REDEPLOY_APP_FILE);

describe('warmRedeployMarker', () => {
  it('produces a value safe for YAML, a TS string literal, and a URL body compare', () => {
    const marker = warmRedeployMarker('e3-mf4k2p');
    expect(marker).toBe('e2e-warm-e3-mf4k2p');
    expect(marker).toMatch(/^[a-z0-9-]+$/);
  });

  it('strips characters that would need quoting or escaping downstream', () => {
    const marker = warmRedeployMarker('e3 / \'"weird"\' 42');
    expect(marker).toMatch(/^[a-z0-9-]+$/);
    expect(marker).not.toContain("'");
    expect(marker).not.toContain('"');
  });

  it('never degenerates to a bare prefix when the seed is entirely stripped', () => {
    expect(warmRedeployMarker('///')).toBe('e2e-warm-run');
  });
});

describe('mutateConfigMapManifest (against the real template)', () => {
  const template = readFileSync(TEMPLATE_MANIFEST, 'utf-8');

  it('inserts the marker key into the ConfigMap data block', () => {
    const out = mutateConfigMapManifest(template, 'e2e-warm-abc');
    expect(out).not.toBe(template);
    expect(out).toContain(`  ${WARM_REDEPLOY_CONFIGMAP_KEY}: "e2e-warm-abc"`);
    // Inserted INSIDE `data:`, not appended after the document.
    const lines = out.split('\n');
    const dataIdx = lines.indexOf('data:');
    expect(lines[dataIdx + 1]).toBe(`  ${WARM_REDEPLOY_CONFIGMAP_KEY}: "e2e-warm-abc"`);
  });

  it('preserves the keys the deploy and the backup CronJob depend on', () => {
    const out = mutateConfigMapManifest(template, 'e2e-warm-abc');
    for (const key of ['SITE_URL', 'DB_HOST', 'KONG_URL', 'BACKUP_RETENTION_DAYS']) {
      expect(out).toContain(`${key}:`);
    }
  });

  it('is idempotent for the same marker', () => {
    const once = mutateConfigMapManifest(template, 'e2e-warm-abc');
    expect(mutateConfigMapManifest(once, 'e2e-warm-abc')).toBe(once);
  });

  it('replaces a stale marker instead of stacking a duplicate YAML key', () => {
    const first = mutateConfigMapManifest(template, 'e2e-warm-one');
    const second = mutateConfigMapManifest(first, 'e2e-warm-two');
    const occurrences = second
      .split('\n')
      .filter((l) => l.trimStart().startsWith(`${WARM_REDEPLOY_CONFIGMAP_KEY}:`));
    expect(occurrences).toHaveLength(1);
    expect(second).toContain('e2e-warm-two');
    expect(second).not.toContain('e2e-warm-one');
  });

  // Mutation test for the guard itself: break the anchor, the mutator must
  // refuse rather than hand back an unchanged file the e2e step would then
  // "verify".
  it('THROWS when the data: anchor is gone rather than silently no-opping', () => {
    const reshaped = template.replace(/^data:$/m, 'data: # reshaped');
    expect(() => mutateConfigMapManifest(reshaped, 'e2e-warm-abc')).toThrow(/no top-level/);
  });
});

describe('mutateAppHealthRoute (against the real template)', () => {
  const template = readFileSync(TEMPLATE_APP, 'utf-8');

  it('adds a marker route that serves the marker as its body', () => {
    const out = mutateAppHealthRoute(template, 'e2e-warm-abc');
    expect(out).not.toBe(template);
    expect(out).toContain("healthRoutes.get('/e2e-warm-marker', (c) => c.text('e2e-warm-abc'));");
  });

  it('registers the route BEFORE the router is exported', () => {
    const out = mutateAppHealthRoute(template, 'e2e-warm-abc');
    expect(out.indexOf('/e2e-warm-marker')).toBeLessThan(out.indexOf('export { healthRoutes };'));
  });

  it('leaves the existing liveness and readiness routes intact', () => {
    const out = mutateAppHealthRoute(template, 'e2e-warm-abc');
    expect(out).toContain("healthRoutes.get('/', (c) =>");
    expect(out).toContain("healthRoutes.get('/ready',");
  });

  it('is idempotent for the same marker', () => {
    const once = mutateAppHealthRoute(template, 'e2e-warm-abc');
    expect(mutateAppHealthRoute(once, 'e2e-warm-abc')).toBe(once);
  });

  it('replaces a stale marker route so the assertion cannot read a stale body', () => {
    const first = mutateAppHealthRoute(template, 'e2e-warm-one');
    const second = mutateAppHealthRoute(first, 'e2e-warm-two');
    const hits = second
      .split('\n')
      .filter((l) => l.includes("healthRoutes.get('/e2e-warm-marker'"));
    expect(hits).toHaveLength(1);
    expect(second).toContain('e2e-warm-two');
    expect(second).not.toContain('e2e-warm-one');
  });

  it('THROWS when the export anchor is gone rather than silently no-opping', () => {
    const reshaped = template.replace('export { healthRoutes };', 'export default healthRoutes;');
    expect(() => mutateAppHealthRoute(reshaped, 'e2e-warm-abc')).toThrow(/anchor/);
  });
});

describe('route path wiring', () => {
  it('the asserted public path matches where index.ts mounts the health router', () => {
    // The e2e step GETs WARM_REDEPLOY_ROUTE_URL_PATH. If the mount point in the
    // template ever moves, that GET would 404 and be misread as "stale image".
    const indexSrc = readFileSync(join(REPO_ROOT, 'carbon/src/server/index.ts'), 'utf-8');
    expect(indexSrc).toContain("app.route('/api/health', healthRoutes);");
    expect(WARM_REDEPLOY_ROUTE_URL_PATH).toBe('/api/health/e2e-warm-marker');
  });
});
