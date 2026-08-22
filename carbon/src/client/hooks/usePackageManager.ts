import { useCallback, useSyncExternalStore } from 'react';

export type PackageManager = 'npm' | 'pnpm' | 'bun';

/**
 * Whether the docs show the npm / pnpm / bun switcher.
 *
 * Mirrors `SHOW_PACKAGE_MANAGER_PROMPT` in the CLI's src/create.js, which is
 * `false` for the same launch decision: `create` defaults to npm and does not
 * ask. Offering the choice here while the generator does not ask contradicts
 * it, and in a generated project it is worse than inconsistent — that project
 * already has one package manager baked into its lockfile and Dockerfile, so
 * two of the three options produce commands that do not match the repo the
 * reader is looking at.
 *
 * The rewriting machinery below stays intact and simply goes unused, the same
 * way the CLI keeps `-pm pnpm` / `-pm bun` working. Flip this to `true`
 * together with the CLI flag to bring the choice back;
 * tests/unit/docs/package-manager-toggle-parity.test.ts fails if only one of
 * them moves.
 */
export const SHOW_PACKAGE_MANAGER_SWITCHER = false;

const STORAGE_KEY = 'docs-package-manager';
const DEFAULT_PM: PackageManager = 'npm';
const VALID: Set<string> = new Set(['npm', 'pnpm', 'bun']);

// Tiny external store so every hook instance shares the same value
let current: PackageManager = (() => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && VALID.has(v) ? (v as PackageManager) : DEFAULT_PM;
  } catch {
    return DEFAULT_PM;
  }
})();

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot() {
  return current;
}

function setPm(pm: PackageManager) {
  current = pm;
  try {
    localStorage.setItem(STORAGE_KEY, pm);
  } catch {}
  for (const cb of listeners) cb();
}

export function usePackageManager() {
  const pm = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_PM);
  const set = useCallback((v: PackageManager) => setPm(v), []);
  return [pm, set] as const;
}

// Docs are authored against npm (the default for generated projects) and
// rewritten on the fly for readers who picked pnpm or bun. `npx` is left
// alone deliberately — it ships with Node, so `npx vibecarbon …` is the one
// invocation that works for every reader regardless of their choice here.
export function replacePackageManager(text: string, pm: PackageManager): string {
  if (pm === 'npm') return text;

  // "npm run <script>" → "pnpm <script>" / "bun run <script>"
  text = text.replace(/\bnpm run (\S+)/g, (_match, script: string) =>
    pm === 'pnpm' ? `pnpm ${script}` : `bun run ${script}`
  );

  // "npm ci" → the lockfile-respecting install for the target manager
  text = text.replace(/\bnpm ci\b/g, () =>
    pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'bun install --frozen-lockfile'
  );

  // "npm install" → "pnpm install" / "bun install"
  text = text.replace(/\bnpm install\b/g, `${pm} install`);

  // Remaining lifecycle shorthands ("npm test", "npm start", …). bun needs an
  // explicit `run` — bare `bun test` is bun's own test runner, not the script.
  text = text.replace(/\bnpm (test|start|stop|restart)\b/g, (_match, script: string) =>
    pm === 'pnpm' ? `pnpm ${script}` : `bun run ${script}`
  );

  // Any remaining standalone "npm"
  text = text.replace(/\bnpm\b/g, pm);

  return text;
}
