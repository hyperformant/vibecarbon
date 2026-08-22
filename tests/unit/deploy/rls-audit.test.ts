import { describe, expect, it } from 'vitest';
import {
  composeRlsAuditShell,
  RLS_AUDIT_SQL,
  rlsAuditFailureMessage,
} from '../../../src/lib/deploy/rls-audit.js';

describe('RLS audit SQL', () => {
  it('selects public tables with RLS disabled, excluding extension-owned', () => {
    expect(RLS_AUDIT_SQL).toContain("n.nspname = 'public'");
    expect(RLS_AUDIT_SQL).toContain("c.relkind = 'r'");
    expect(RLS_AUDIT_SQL).toContain('NOT c.relrowsecurity');
    // extension-owned tables (deptype 'e') are excluded → no false positives
    expect(RLS_AUDIT_SQL).toContain("deptype = 'e'");
  });
});

describe('rlsAuditFailureMessage', () => {
  it('names the tables and their count, and refuses to deploy', () => {
    const msg = rlsAuditFailureMessage('orders, invoices');
    expect(msg).toContain('orders, invoices');
    expect(msg).toContain('2 table(s)');
    expect(msg).toContain('ENABLE ROW LEVEL SECURITY');
    expect(msg.toLowerCase()).toContain('refusing to deploy');
  });
});

describe('composeRlsAuditShell', () => {
  const shell = composeRlsAuditShell();

  it('runs the audit SQL via docker compose exec and exits 1 on any finding', () => {
    expect(shell).toContain('docker compose exec -T db psql');
    expect(shell).toContain(RLS_AUDIT_SQL);
    expect(shell).toMatch(/if \[ -n "\$UNPROTECTED" \]; then[\s\S]*exit 1; fi/);
  });

  it('confirms success on a clean schema (does not silently pass)', () => {
    expect(shell).toContain('RLS audit passed');
  });
});
