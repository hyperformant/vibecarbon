/**
 * Derive the failover scale-up list from what deploy ACTUALLY renders —
 * replaces the former hardcoded failover deployment list (a drift hazard). The
 * zero overlay is the authoritative zero-set; its inverse (with target replicas
 * from the shared values, default 1) is exactly what failover must bring up.
 */

// Extract a top-level `key:` block from a values-file-shaped text: every
// line from (but not including) the `key:` line up to the next line that is
// non-indented AND not a comment (i.e. the next top-level key), or EOF.
// Non-indented comment lines (e.g. section-header comments) don't end the
// block. Returns '' if `key:` isn't present as its own top-level line.
function extractTopLevelBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return '';
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    block.push(line);
  }
  return block.join('\n');
}

export function deriveScaleUpList({ overlayText, sharedValuesText, appManifestText }) {
  // Scope the component scan to the overlay's own `deployment:` block — the
  // overlay also carries a `persistence:` map whose child keys collide with
  // component names (storage, imgproxy, ...) and must never produce
  // duplicate/false scale-up entries.
  const overlayDeploymentBlock = extractTopLevelBlock(overlayText, 'deployment');
  const comps = [...overlayDeploymentBlock.matchAll(/^ {2}([a-z]+):$/gm)].map((m) => m[1]);
  // replicaCount overrides live under the shared values' `deployment:` map,
  // 2-space component indent, 4-space key indent (same shape the overlay
  // uses). Scope the search structurally to the `deployment:` block — other
  // top-level maps (e.g. `environment:`) can hold same-named component keys
  // (env-var LISTS, not deployment config) that must never leak into this.
  const deploymentBlock = extractTopLevelBlock(sharedValuesText, 'deployment');
  const overrideFor = (comp) => {
    if (!deploymentBlock) return 1;
    const m = deploymentBlock.match(
      new RegExp(`^ {2}${comp}:\\n(?:    .*\\n)*?    replicaCount: (\\d+)$`, 'm'),
    );
    return m ? Number(m[1]) : 1;
  };
  const appReplicas = Number(appManifestText.match(/^\s*replicas:\s*(\d+)/m)?.[1] ?? 2);
  return [
    { name: 'app', namespace: 'vibecarbon', replicas: appReplicas },
    ...comps.map((comp) => ({
      name: `supabase-supabase-${comp}`,
      namespace: 'vibecarbon',
      replicas: overrideFor(comp),
    })),
    { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
  ];
}
