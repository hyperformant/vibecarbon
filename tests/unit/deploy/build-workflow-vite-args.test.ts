import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards that the CI image builder passes the VITE_* build args the client
// bundle reads. Without these the GHCR image (used by compose push/CI mode)
// bakes empty values. They source from repo-level Actions variables seeded by
// `vibecarbon deploy` (seedBuildVars).
describe('vibecarbon-build.yml bakes VITE build args', () => {
  const wf = readFileSync(
    join(process.cwd(), 'carbon/.github/workflows/vibecarbon-build.yml'),
    'utf-8',
  );

  it('has a build-args block', () => {
    expect(wf).toMatch(/build-args:\s*\|/);
  });

  it('passes the project, public-URL and analytics VITE args from repo vars', () => {
    for (const key of [
      'VITE_PROJECT_NAME',
      'VITE_PUBLIC_URL',
      'VITE_PLAUSIBLE_DOMAIN',
      'VITE_PLAUSIBLE_SCRIPT_URL',
    ]) {
      expect(wf).toContain(`${key}=\${{ vars.${key} }}`);
    }
  });
});
