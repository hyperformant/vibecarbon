import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for "Missing Supabase environment variables" after a scale.
 *
 * Vite inlines import.meta.env.VITE_* at build time. The deploy (orchestrator.js)
 * and HA (compose/ha.js) paths pass collectComposeBuildArgs() to buildRemote so
 * the new server's frontend bundle gets the real VITE_SUPABASE_URL/ANON_KEY.
 * scale.js originally rebuilt the app image with NO build args, shipping an empty
 * VITE_SUPABASE_URL and breaking the site post-scale. This is a source-level
 * guard (scale's build step has no unit harness — it's exercised in e2e, which
 * did not verify the frontend after scaling).
 */
describe('scale wires VITE build args into the remote app build', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/scale.js', import.meta.url)),
    'utf8',
  );

  it('imports collectComposeBuildArgs', () => {
    expect(src).toMatch(/import\s*\{\s*collectComposeBuildArgs\s*\}/);
  });

  it('collects build args with projectName + domain', () => {
    expect(src).toMatch(
      /collectComposeBuildArgs\(\s*process\.cwd\(\),\s*\{\s*projectName,\s*domain/,
    );
  });

  it("passes the build args as buildRemote's 5th argument", () => {
    // 4-arg form (no build args) is the bug; the 5th positional must be present.
    expect(src).toMatch(
      /buildRemote\(\s*newIp,\s*sshKeyPath,\s*oldAppImage,\s*process\.cwd\(\),\s*[A-Za-z]/,
    );
  });
});
