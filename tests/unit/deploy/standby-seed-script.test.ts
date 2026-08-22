/**
 * Builder extensions for the standby seed init container (spec
 * 2026-07-16-standby-init-seeding-design.md). The same
 * buildStagedBasebackupScript that powers the failover/restore swap reseeds
 * gains a bounded-retry mode and an env-sourced password so the generated
 * script can live in a ConfigMap (no secrets) and keep retrying until the
 * primary becomes replication-ready.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPrimaryConninfo,
  buildStagedBasebackupScript,
  buildStandbySeedInitScript,
} from '../../../src/lib/deploy/replication.js';

describe('buildPrimaryConninfo passwordExpr', () => {
  it('renders the literal password by default (existing callers)', () => {
    const s = buildPrimaryConninfo({ primaryHost: 'h', replPassword: 'sekrit' });
    expect(s).toContain('password=sekrit');
  });
  it('renders the expression instead when passwordExpr is set', () => {
    const s = buildPrimaryConninfo({ primaryHost: 'h', passwordExpr: '$REPL_PASSWORD' });
    expect(s).toContain('password=$REPL_PASSWORD');
    expect(s).not.toContain('sekrit');
  });
});

describe('buildStagedBasebackupScript retry + env password', () => {
  const base = {
    primaryHost: '10.0.1.2',
    primaryPort: '15433',
    swap: true,
    stagingDir: '/seed-volume/.seed_staging',
    pgdataDir: '/seed-volume/postgres-data',
    label: 'seed-standby',
  };

  it('defaults are byte-compatible: single attempt, literal password, exit 1 on failure', () => {
    const s = buildStagedBasebackupScript({ ...base, replPassword: 'sekrit' });
    expect(s).toContain("PGPASSWORD='sekrit'");
    expect(s).not.toContain('seed_attempt');
    expect(s).not.toContain('$REPL_PASSWORD');
    // connectTimeoutS/deadlineSeconds default to null — no emitted text at all
    expect(s).not.toContain('PGCONNECT_TIMEOUT');
    expect(s).not.toContain('SECONDS');
  });

  it('passwordFromEnv keeps the script secret-free', () => {
    const s = buildStagedBasebackupScript({ ...base, passwordFromEnv: true });
    expect(s).toContain('PGPASSWORD="$REPL_PASSWORD"');
    expect(s).not.toMatch(/PGPASSWORD='/);
  });

  it('basebackupAttempts > 1 wraps basebackup in a bounded loop that wipes staging between attempts', () => {
    const s = buildStagedBasebackupScript({
      ...base,
      passwordFromEnv: true,
      basebackupAttempts: 24,
      basebackupDelayS: 15,
      exhaustExitZero: true,
    });
    expect(s).toContain('seq 1 24');
    expect(s).toContain('sleep 15');
    // staging is cleared before every attempt so a partial fetch never
    // poisons the next attempt or a fallback initdb
    expect(s).toMatch(/rm -rf \/seed-volume\/\.seed_staging/);
    // exhaustion exits 0 (bounded wait + fallback semantics)
    expect(s).toMatch(/exhausted.*exit 0|exit 0[\s\S]{0,120}exhausted/i);
  });

  it('exhaustExitZero=false keeps hard-fail semantics on exhaustion', () => {
    const s = buildStagedBasebackupScript({
      ...base,
      passwordFromEnv: true,
      basebackupAttempts: 3,
      exhaustExitZero: false,
    });
    expect(s).toContain('exit 1');
  });
});

describe('buildStagedBasebackupScript connect timeout + wall-clock deadline', () => {
  const base = {
    primaryHost: '10.0.1.2',
    primaryPort: '15433',
    swap: true,
    stagingDir: '/seed-volume/.seed_staging',
    pgdataDir: '/seed-volume/postgres-data',
    label: 'seed-standby',
    passwordFromEnv: true,
    basebackupAttempts: 24,
    basebackupDelayS: 15,
    exhaustExitZero: true,
  };

  it('connectTimeoutS emits PGCONNECT_TIMEOUT ahead of the basebackup loop', () => {
    const s = buildStagedBasebackupScript({ ...base, connectTimeoutS: 10 });
    expect(s).toContain('export PGCONNECT_TIMEOUT=10');
    // must precede the retry loop, not follow it
    expect(s.indexOf('PGCONNECT_TIMEOUT')).toBeLessThan(s.indexOf('seed_attempt'));
  });

  it('deadlineSeconds adds a bash SECONDS-based wall-clock break inside the retry loop', () => {
    const s = buildStagedBasebackupScript({ ...base, deadlineSeconds: 360 });
    expect(s).toMatch(/\$\{SECONDS\}.*-ge.*360/);
    expect(s).toContain('break');
    // the guard sits between the loop's `for` head and the first `rm -rf`
    // staging wipe of the attempt body — i.e. inside the loop, ahead of any
    // per-attempt work.
    expect(s).toMatch(
      /for seed_attempt in \$\(seq 1 24\); do\n[\s\S]*?\$\{SECONDS\}[\s\S]*?\n\s*rm -rf/,
    );
  });

  it('on deadline-break the existing exhaustion path still runs (seed_ok stays 0)', () => {
    const s = buildStagedBasebackupScript({ ...base, deadlineSeconds: 360 });
    expect(s).toMatch(/if \[ "\$\{seed_ok\}" != "1" \]/);
    expect(s).toMatch(/exhausted.*exit 0|exit 0[\s\S]{0,120}exhausted/i);
  });

  it('both default to null — no emitted text, byte-compat with existing callers', () => {
    const s = buildStagedBasebackupScript(base);
    expect(s).not.toContain('PGCONNECT_TIMEOUT');
    expect(s).not.toContain('SECONDS');
  });
});

describe('buildStandbySeedInitScript', () => {
  const s = buildStandbySeedInitScript();

  it('gates on WALG_ROLE=standby, first boot, and no restore marker', () => {
    expect(s).toMatch(/WALG_ROLE[^\n]*standby/);
    expect(s).toContain('/seed-volume/postgres-data/PG_VERSION');
    expect(s).toMatch(/RESTORE_TARGET/);
    // each gate exits 0 (never blocks a boot it does not own)
    expect((s.match(/exit 0/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('composes the shared builder core (env password, 6-minute budget, exhaust-exit-zero)', () => {
    expect(s).toContain('PGPASSWORD="$REPL_PASSWORD"');
    expect(s).toContain('seq 1 24');
    expect(s).toContain('sleep 15');
    // relay endpoint comes from env, resolved at container runtime
    expect(s).toContain('$SEED_PRIMARY_HOST');
    // conninfo password stays an env expansion — the script must be secret-free
    expect(s).toContain('password=$REPL_PASSWORD');
    expect(s).not.toMatch(/password=[a-z0-9]{8}/i);
  });

  it('bounds the seed window to a real 6-minute wall clock, not just an attempt count', () => {
    // finding: an absent transport (missing NetworkPolicy) makes each
    // pg_basebackup attempt hang at the OS connect timeout with no
    // PGCONNECT_TIMEOUT, turning 24x15s=6min into 50+ minutes and blowing
    // the standby helm --wait --timeout 15m.
    expect(s).toContain('export PGCONNECT_TIMEOUT=10');
    expect(s).toMatch(/\$\{SECONDS\}.*-ge.*360/);
    expect(s).toContain('break');
  });

  it('targets the raw-volume layout used by the helper-pod swap (subPath postgres-data)', () => {
    expect(s).toContain('-D /seed-volume/.seed_staging');
    expect(s).toMatch(/find \/seed-volume\/postgres-data -mindepth 1 -delete/);
  });

  it('renders the conninfo heredoc UNQUOTED so $SEED_PRIMARY_HOST/$REPL_PASSWORD expand at runtime', () => {
    // carry-forward from Task 1 review: passwordFromEnv+conninfo combination,
    // exercised here through the composed script (the real caller Task 1 lacked)
    expect(s).toMatch(/<<REPL_CONNINFO_EOF/);
    expect(s).not.toMatch(/<<'REPL_CONNINFO_EOF'/);
    expect(s).toMatch(/primary_conninfo = '[^\n]*password=\$REPL_PASSWORD[^\n]*'/);
  });
});
