import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findEnvDrift } from '../../../src/lib/project.js';

// Live incident 2026-08-22 (vibecarbon-web): billing + SMTP secrets were
// hand-copied into .env.local only, deploy shipped the empty .env baseline,
// and prod answered "Billing is not configured". findEnvDrift is the
// deploy-time guard that names such keys before the bundle ships.
function makeProjectDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-env-drift-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('findEnvDrift', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string>) => {
    const dir = makeProjectDir(files);
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length) {
      try {
        rmSync(dirs.pop() as string, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('reports a runtime key set in .env.local but missing from .env', () => {
    const dir = make({
      '.env': 'SITE_URL=https://example.com\n',
      '.env.local': 'SITE_URL=https://example.com\nSTRIPE_SECRET_KEY=rk_live_abc\n',
    });
    expect(findEnvDrift(dir)).toEqual(['STRIPE_SECRET_KEY']);
  });

  it('reports a runtime key set in .env.local but empty in .env', () => {
    const dir = make({
      '.env': "SMTP_PASS=''\n",
      '.env.local': "SMTP_PASS='re_123'\n",
    });
    expect(findEnvDrift(dir)).toEqual(['SMTP_PASS']);
  });

  it('does not report operator-secret keys (they are .env.local-only by design)', () => {
    const dir = make({
      '.env': '',
      '.env.local': 'HETZNER_API_TOKEN=tok\nCLOUDFLARE_API_TOKEN=tok2\n',
    });
    expect(findEnvDrift(dir)).toEqual([]);
  });

  it('does not report keys that are non-empty in .env, even when values differ', () => {
    // .env is the deploy baseline; a differing .env.local value is a local
    // override, not missing production config.
    const dir = make({
      '.env': 'JWT_SECRET=prod-secret\n',
      '.env.local': 'JWT_SECRET=old-project-secret\n',
    });
    expect(findEnvDrift(dir)).toEqual([]);
  });

  it('does not report keys that are empty in .env.local too', () => {
    const dir = make({
      '.env': 'STRIPE_WEBHOOK_SECRET=\n',
      '.env.local': 'STRIPE_WEBHOOK_SECRET=\n',
    });
    expect(findEnvDrift(dir)).toEqual([]);
  });

  it('returns an empty list when .env.local does not exist', () => {
    const dir = make({ '.env': 'SITE_URL=https://example.com\n' });
    expect(findEnvDrift(dir)).toEqual([]);
  });

  it('returns sorted key names for a stable warning message', () => {
    const dir = make({
      '.env': '',
      '.env.local': 'ZED_KEY=1\nALPHA_KEY=2\n',
    });
    expect(findEnvDrift(dir)).toEqual(['ALPHA_KEY', 'ZED_KEY']);
  });
});
