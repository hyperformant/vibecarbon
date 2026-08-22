import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards that the CI image builder passes the VITE_* build args. Without these
// the GHCR image (used by compose push/CI mode) bakes empty VITE_SUPABASE_*
// and the SPA crashes at page load. They source from repo-level Actions
// variables seeded by `vibecarbon deploy` (seedBuildVars).
describe('vibecarbon-build.yml bakes VITE build args', () => {
  const wf = readFileSync(
    join(process.cwd(), 'carbon/.github/workflows/vibecarbon-build.yml'),
    'utf-8',
  );

  it('has a build-args block', () => {
    expect(wf).toMatch(/build-args:\s*\|/);
  });

  it('passes the Supabase + public-URL VITE args from repo vars', () => {
    for (const key of [
      'VITE_PROJECT_NAME',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'VITE_PUBLIC_URL',
      'VITE_PLAUSIBLE_DOMAIN',
      'VITE_PLAUSIBLE_SCRIPT_URL',
    ]) {
      expect(wf).toContain(`${key}=\${{ vars.${key} }}`);
    }
  });
});
