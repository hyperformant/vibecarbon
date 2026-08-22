import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

// Fake child for the async `spawn` path — used both by
// waitForSupabaseStorageSchema's probe (execKubectlOnce, always did this)
// and, after the runCommandAsync migration, by applyMigrations' per-file
// psql exec too (previously spawnSync, now routed through the shared async
// exec layer, which itself calls `spawn`).
function makeFakeChild(stdout = '1', exitCode = 0): EventEmitter {
  const c = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: () => void;
  };
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = () => {};
  setImmediate(() => {
    c.stdout.write(stdout);
    c.stdout.end();
    c.stderr.end();
    c.emit('close', exitCode);
  });
  return c;
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(() => makeFakeChild('1', 0)),
  };
});

const k3sModulePromise = import('../../../src/lib/deploy/k8s/k3s.js');

function makeProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'vc-mig-'));
  mkdirSync(join(projectDir, 'supabase', 'migrations'), { recursive: true });
  return projectDir;
}

describe('applyMigrations (PR 1C)', () => {
  it('runs every .sql file in lex order via kubectl exec -i ... psql', async () => {
    const { applyMigrations } = await k3sModulePromise;
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    const recordedInputs: string[] = [];
    mocked.mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes('-tA')) {
        // waitForSupabaseStorageSchema's probe — column already exists.
        return makeFakeChild('3', 0) as unknown as ReturnType<typeof spawn>;
      }
      // A migration apply — capture the piped SQL from stdin.
      const child = makeFakeChild('', 0);
      child.stdin.on('data', (chunk) => recordedInputs.push(chunk.toString()));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn);

    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'supabase', 'migrations', '00002_b.sql'), '-- 2nd');
    writeFileSync(join(projectDir, 'supabase', 'migrations', '00001_a.sql'), '-- 1st');

    await applyMigrations({ kubeconfig: '/tmp/kc', projectDir });

    // Calls: one storage-schema probe (-tA), one per migration file, and one
    // post-migration RLS audit (-tAc). Migration applies are the ones that are
    // neither probe (-tA) nor audit (-tAc).
    const isProbeOrAudit = (c: unknown[]) => {
      const a = c[1] as string[];
      return a.includes('-tA') || a.includes('-tAc');
    };
    const migrationCalls = mocked.mock.calls.filter((c) => !isProbeOrAudit(c));
    expect(migrationCalls.length).toBe(2);
    // The RLS audit runs after the migrations (ground-truth backstop).
    const auditCall = mocked.mock.calls.find((c) => (c[1] as string[]).includes('-tAc'));
    expect(auditCall, 'applyMigrations must run the post-migration RLS audit').toBeDefined();
    const auditArgv = (auditCall as unknown[])[1] as string[];
    expect(auditArgv.join(' ')).toContain('relrowsecurity');
    const firstArgv = migrationCalls[0][1] as string[];
    const secondArgv = migrationCalls[1][1] as string[];
    expect(firstArgv).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      '-i',
      'supabase-supabase-db-0',
      '--',
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ]);
    // Second migration call uses the same argv — the SQL is piped via stdin.
    expect(secondArgv).toEqual(firstArgv);
    // Order: 00001 before 00002.
    expect(recordedInputs[0]).toContain('-- 1st');
    expect(recordedInputs[1]).toContain('-- 2nd');
  });

  it('throws on first failing migration with helpful message', async () => {
    const { applyMigrations } = await k3sModulePromise;
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    // The storage-schema probe succeeds; every migration-apply call fails.
    mocked.mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes('-tA')) {
        return makeFakeChild('3', 0) as unknown as ReturnType<typeof spawn>;
      }
      return makeFakeChild('', 1) as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn);

    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'supabase', 'migrations', '00001_init.sql'), 'BAD SQL;');

    await expect(applyMigrations({ kubeconfig: '/tmp/kc', projectDir })).rejects.toThrow(
      /00001_init\.sql/,
    );
  });

  it('skips silently when supabase/migrations does not exist', async () => {
    const { applyMigrations } = await k3sModulePromise;
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();

    const projectDir = mkdtempSync(join(tmpdir(), 'vc-mig-empty-'));
    await expect(applyMigrations({ kubeconfig: '/tmp/kc', projectDir })).resolves.toBeUndefined();
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe('waitForSupabaseStorageSchema', () => {
  it('waits for file_size_limit + allowed_mime_types, not just public (the columns 00001_init inserts)', async () => {
    // k8s-ha standby failure 2026-07-11: the guard passed as soon as
    // storage.buckets.public existed, but the app migration INSERTs public,
    // file_size_limit AND allowed_mime_types — added by a LATER storage-api
    // migration — so the migration raced ahead and failed with
    // "column file_size_limit of relation buckets does not exist". The guard
    // must wait for all three.
    const { waitForSupabaseStorageSchema } = await k3sModulePromise;
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    const probeSqls: string[] = [];
    mocked.mockImplementation((() => {
      const c = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill: () => void;
      };
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      c.kill = () => {};
      let sql = '';
      c.stdin.on('data', (chunk) => {
        sql += chunk.toString();
      });
      c.stdin.on('finish', () => {
        probeSqls.push(sql);
        // Report "all requested columns present": '3' for the 3-column guard,
        // '1' for the legacy single-column ('public') probe — so BOTH the old
        // and fixed code complete and the assertion below is what distinguishes.
        c.stdout.write(sql.includes('file_size_limit') ? '3' : '1');
        c.stdout.end();
        c.stderr.end();
        c.emit('close', 0);
      });
      return c as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn);

    await waitForSupabaseStorageSchema({ kubeconfig: '/tmp/kc', maxWaitSec: 5 });

    const sql = probeSqls.join('\n');
    expect(sql).toContain('file_size_limit');
    expect(sql).toContain('allowed_mime_types');
  });
});

describe('reloadPostgrest', () => {
  it('issues NOTIFY pgrst reload schema via kubectl exec on the db pod', async () => {
    const { reloadPostgrest } = await k3sModulePromise;
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    // execKubectlOnce uses the async spawn path — exit 0.
    mocked.mockImplementation(() => makeFakeChild('', 0) as unknown as ReturnType<typeof spawn>);

    await reloadPostgrest({ kubeconfig: '/tmp/kc' });

    expect(mocked).toHaveBeenCalledTimes(1);
    const [bin, argv] = mocked.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('kubectl');
    expect(argv).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      '-i',
      '--request-timeout=15s',
      'supabase-supabase-db-0',
      '--',
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      'postgres',
      '-c',
      "NOTIFY pgrst, 'reload schema'",
    ]);
  });

  it('is best-effort — does not throw when the reload exec fails', async () => {
    const { reloadPostgrest } = await k3sModulePromise;
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    // Non-zero exit (e.g. db-channel disabled / pod momentarily unreachable).
    mocked.mockImplementation(() => makeFakeChild('', 1) as unknown as ReturnType<typeof spawn>);

    await expect(reloadPostgrest({ kubeconfig: '/tmp/kc' })).resolves.toBeUndefined();
  });
});
