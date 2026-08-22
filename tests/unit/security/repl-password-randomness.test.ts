import { describe, expect, it } from 'vitest';
import { generateReplPassword } from '../../../src/lib/secrets.js';

describe('C-1: replication password', () => {
  it('generates a fresh password per call', () => {
    const samples = new Set();
    for (let i = 0; i < 20; i++) samples.add(generateReplPassword());
    expect(samples.size).toBe(20);
  });

  it('uses base64url characters only (URL/shell safe)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateReplPassword()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('is at least 32 characters (192 bits of entropy from 24 random bytes)', () => {
    for (let i = 0; i < 10; i++) {
      expect(generateReplPassword().length).toBeGreaterThanOrEqual(32);
    }
  });

  it('never returns the legacy hardcoded value', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateReplPassword()).not.toBe('repl_password');
    }
  });
});

describe('C-1: legacy hardcoded password removed from deploy code', () => {
  it('compose/ha.js and k8s/ha/index.js no longer contain the literal "repl_password"', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const rel of ['src/lib/deploy/compose/ha.js', 'src/lib/deploy/k8s/ha/index.js']) {
      const content = readFileSync(join(process.cwd(), rel), 'utf-8');
      expect(content).not.toMatch(/repl_password/);
    }
  });
});

describe('C-1: primary-init.sql handles idempotent re-runs', () => {
  it('primary-init.sql has both CREATE and ALTER branches', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const content = readFileSync(join(process.cwd(), 'carbon', 'ha', 'primary-init.sql'), 'utf-8');
    expect(content).toMatch(/CREATE ROLE replicator/);
    expect(content).toMatch(/ALTER ROLE replicator/);
  });

  it('primary-init.sql ships the {{REPL_PASSWORD}} placeholder (not a literal credential)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const content = readFileSync(join(process.cwd(), 'carbon', 'ha', 'primary-init.sql'), 'utf-8');
    // Rendered by k8s/ha/index.js via replaceAll('{{REPL_PASSWORD}}', …).
    expect(content).toContain('{{REPL_PASSWORD}}');
    expect(content).not.toMatch(/repl_password/);
  });
});

// standby-init.sh + activate-standby.sh were deleted (finding #7): unreferenced
// dead scripts encoding known-broken approaches (no replication slot, NodePort
// 30432, bare-service scale no-ops). The live k8s-HA path is
// src/lib/deploy/k8s/ha/index.js setupReplication.
describe('C-1: dead HA scripts removed', () => {
  it('carbon/ha no longer ships standby-init.sh or activate-standby.sh', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(process.cwd(), 'carbon', 'ha', 'standby-init.sh'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'carbon', 'ha', 'activate-standby.sh'))).toBe(false);
  });
});
