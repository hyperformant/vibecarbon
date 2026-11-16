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

describe('C-1: the replication role SQL handles idempotent re-runs', () => {
  it('creates the role when missing and always sets the password', async () => {
    const { replicationRoleSql } = await import('../../../src/lib/deploy/replication-slot.js');
    const sql = replicationRoleSql('testreplpass');
    expect(sql).toMatch(/CREATE ROLE replicator/);
    expect(sql).toMatch(/^ALTER ROLE replicator WITH PASSWORD 'testreplpass';$/m);
  });
});
