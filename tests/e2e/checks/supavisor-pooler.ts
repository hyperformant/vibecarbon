/**
 * Supavisor pooler verification — closes docs/security.md's long-standing
 * "configured but not yet covered by an automated end-to-end test" caveat.
 *
 * Four assertions, two vantage points:
 *
 *  On-host (ssh → docker compose exec db → psql through the pooler):
 *   - `supavisor_session_tenant_routing`     — SELECT 1 via :5432 (session)
 *   - `supavisor_transaction_tenant_routing` — SELECT 1 via :6543 (transaction)
 *  Both authenticate as the tenant user (`postgres.<PROJECT_NAME>`), so they
 *  prove migrate ran, the tenant seed (volumes/pooler/pooler.exs) landed, and
 *  the pgbouncer get_auth auth_query resolves roles.
 *
 *  External (raw TCP from the runner to the public domain):
 *   - `supavisor_external_reachability_5432` / `_6543` — dials the port and
 *     sends a Postgres SSLRequest; ANY 1-byte answer ('S' or 'N') proves the
 *     operator-CIDR firewall rule + host port-publish path end to end (e2e
 *     widens the allowlist to 0.0.0.0/0, so the runner is in scope). No `pg`
 *     dependency needed — reachability, not auth, is the claim here.
 *
 * Compose-only: k8s deploys run no Supavisor (chart doesn't ship it).
 */

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import type { VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';
import { resolveCheckIp } from './health.js';

/**
 * Remote probe body, wrapped in single quotes by the compose exec wrapper —
 * so it must contain NO single quote in any branch (same invariant as
 * backup-evidence's probe; pinned by the unit test). Always exits 0: the
 * verdict lives in TypeScript, parsed from the KEY=value lines.
 */
export function buildPoolerProbeCommand(projectName: string, postgresPassword: string): string {
  const url = (port: number) =>
    `postgres://postgres.${projectName}:${postgresPassword}@supavisor:${port}/postgres`;
  const probe =
    `s_out=$(PGCONNECT_TIMEOUT=10 psql "${url(5432)}" -tAc "select 1" 2>&1 | tr -d "\\n"); ` +
    'echo "SESSION_OUT=${s_out}"; ' +
    `t_out=$(PGCONNECT_TIMEOUT=10 psql "${url(6543)}" -tAc "select 1" 2>&1 | tr -d "\\n"); ` +
    'echo "TRANSACTION_OUT=${t_out}"; ' +
    'exit 0';
  return `cd /opt/${projectName} && docker compose exec -T db bash -c '${probe}'`;
}

export function parsePoolerProbeOutput(out: string): { session: string; transaction: string } {
  const grab = (key: string) => {
    const line = out.split('\n').find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : '';
  };
  return { session: grab('SESSION_OUT'), transaction: grab('TRANSACTION_OUT') };
}

/**
 * Dial `host:port`, send a Postgres SSLRequest (len=8, code=80877103), and
 * resolve with the single-byte answer ('S' = TLS ready, 'N' = plaintext).
 * Either byte proves a Postgres-speaking listener answered through the
 * firewall. Rejects on timeout/refusal.
 */
function realDialTcp(host: string, port: number, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`dial ${host}:${port} timed out`)));
    socket.on('error', fail);
    socket.on('connect', () => {
      const sslRequest = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
      socket.write(sslRequest);
    });
    socket.once('data', (buf) => {
      socket.destroy();
      resolve(buf.toString('latin1', 0, 1));
    });
  });
}

function realExecRemote(ip: string, sshKeyPath: string, cmd: string): string {
  // SECURITY: all arguments come from trusted test config, never user input.
  return execFileSync('ssh', [...e2eSshOpts(10), '-i', sshKeyPath, `root@${ip}`, cmd], {
    encoding: 'utf-8',
    timeout: 90_000,
    stdio: 'pipe',
  }).trim();
}

export interface SupavisorPoolerOptions {
  /** Public FQDN — target for the external reachability dials. */
  domain: string;
  masterIp: string | undefined;
  sshKeyPath: string | undefined;
  projectName: string;
  postgresPassword: string;
  /** Which lifecycle phase invoked us — recorded in details for triage. */
  phase: string;
  /** Seam for unit tests; defaults to the real SSH exec. */
  execRemote?: (ip: string, keyPath: string, cmd: string) => string;
  /** Seam for unit tests; defaults to the real TCP/SSLRequest dial. */
  dialTcp?: (host: string, port: number, timeoutMs?: number) => Promise<string>;
}

function timer() {
  const start = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - start) / 1_000_000n);
}

export async function runSupavisorPoolerChecks(
  options: SupavisorPoolerOptions,
): Promise<VerificationResult[]> {
  const {
    domain,
    masterIp,
    sshKeyPath,
    projectName,
    postgresPassword,
    phase,
    execRemote = realExecRemote,
    dialTcp = realDialTcp,
  } = options;
  const results: VerificationResult[] = [];

  // --- On-host tenant routing (both modes) --------------------------------
  const hostElapsed = timer();
  let parsed = { session: '', transaction: '' };
  let sshError: string | null = null;
  if (!masterIp || !sshKeyPath) {
    sshError = 'masterIp/sshKeyPath unavailable — cannot run the on-host probe';
  } else {
    try {
      const out = execRemote(
        masterIp,
        sshKeyPath,
        buildPoolerProbeCommand(projectName, postgresPassword),
      );
      parsed = parsePoolerProbeOutput(out);
    } catch (err) {
      sshError = err instanceof Error ? err.message : String(err);
    }
  }
  const hostMs = hostElapsed();
  for (const [mode, value] of [
    ['session', parsed.session],
    ['transaction', parsed.transaction],
  ] as const) {
    const ok = !sshError && value === '1';
    results.push({
      checkName: `supavisor_${mode}_tenant_routing`,
      status: ok ? 'pass' : 'fail',
      responseTimeMs: hostMs,
      ...(ok
        ? {}
        : {
            errorMessage:
              sshError ??
              `psql via pooler (${mode} mode) returned "${value}" — expected "1". ` +
                'Tenant seed (volumes/pooler/pooler.exs) or pgbouncer auth (volumes/db/pooler.sql) likely missing.',
          }),
      details: { phase, mode },
    });
  }

  // --- External reachability through the operator-scoped firewall ---------
  // Dial the public-DNS-resolved address, not the name: a raw TCP dial has
  // no Host/SNI to preserve, and net.connect-by-name sits on the OS
  // resolver, which is not trustworthy for a record the run just created
  // (e4 2026-08-29: an intermediary resolver cached NODATA mid-run for the
  // zone's SOA minimum TTL). Fall back to the name if public DNS is
  // unreachable — same policy as dnsSafeFetch.
  const dialHost = (await resolveCheckIp(domain).catch(() => null)) ?? domain;
  for (const port of [5432, 6543] as const) {
    const dialElapsed = timer();
    let status: 'pass' | 'fail' = 'pass';
    let errorMessage: string | undefined;
    let answer: string | undefined;
    try {
      answer = await dialTcp(dialHost, port);
      if (answer !== 'S' && answer !== 'N') {
        status = 'fail';
        errorMessage = `unexpected SSLRequest answer byte ${JSON.stringify(answer)} from ${domain}:${port}`;
      }
    } catch (err) {
      status = 'fail';
      const msg = err instanceof Error ? err.message : String(err);
      errorMessage =
        `${msg} — pooler port ${port} unreachable from the runner; the cloud firewall ` +
        'should scope it to operator CIDRs (e2e widens them to 0.0.0.0/0).';
    }
    results.push({
      checkName: `supavisor_external_reachability_${port}`,
      status,
      responseTimeMs: dialElapsed(),
      ...(errorMessage ? { errorMessage } : {}),
      details: { phase, port, answer },
    });
  }

  return results;
}
