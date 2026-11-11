import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The temp-dir census (tests/setup/global-setup.ts): every test file runs
 * with os.tmpdir() inside its own temp root, and whatever is left there when
 * the file ends fails it. These are the names it may leave, each with why no
 * test can remove it. The root is removed either way.
 */
export const TEMP_CENSUS_EXEMPT: ReadonlyArray<{ name: RegExp; why: string }> = [
  {
    name: /^automation-/,
    why:
      "the Pulumi automation SDK's default LocalWorkspace workDir: the SDK makes one per " +
      'workspace and never removes it',
  },
  {
    name: /^node-compile-cache$/,
    why: "Node's module compile cache, which corepack's pnpm turns on and keeps across runs",
  },
  {
    name: /^tsx-\d+$/,
    why: "tsx's per-user transform cache, kept across runs",
  },
  {
    name: /^vc-deploy-bundle-/,
    why:
      'executeDeployment (src/lib/deploy/orchestrator.js) never removes the bundle it ' +
      'renders, one dir per deploy: a production leak, still open',
  },
];

/**
 * Directories code under test keeps on purpose and reuses. Each may stay; what
 * a test leaves inside one may not.
 */
export const TEMP_CENSUS_KEPT_ROOTS: ReadonlyArray<{ name: RegExp; why: string }> = [
  {
    name: /^vibecarbon-(\d+|user)$/,
    why:
      'the private per-user root image delta work dirs go in (deltaWorkRoot, ' +
      'src/lib/deploy/layer-delta.js), made 0700 once and reused',
  },
];

/** Every entry in `dir` the census does not allow, relative to `dir`, sorted. */
export function tempLeftovers(dir: string): string[] {
  const left: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (TEMP_CENSUS_EXEMPT.some(({ name }) => name.test(entry.name))) continue;
    if (entry.isDirectory() && TEMP_CENSUS_KEPT_ROOTS.some(({ name }) => name.test(entry.name))) {
      for (const inner of readdirSync(join(dir, entry.name))) left.push(`${entry.name}/${inner}`);
      continue;
    }
    left.push(entry.name);
  }
  return left.sort();
}

/**
 * Close a test file's temp root: remove it, and return the census's complaint
 * about what the file's tests left in `tmp` (the dir os.tmpdir() pointed at),
 * or null when they left nothing it does not allow.
 */
export function closeTempRoot(root: string, tmp: string): string | null {
  const left = tempLeftovers(tmp);
  rmSync(root, { recursive: true, force: true });
  if (left.length === 0) return null;
  return (
    `this file's tests left ${left.join(', ')} in the temp dir (removed now): make temp ` +
    'dirs with createTempDir (tests/_shared/temp-dir.ts) or remove them in afterEach, and ' +
    'hand a temp dir the code under test returns to adoptTempDir'
  );
}
