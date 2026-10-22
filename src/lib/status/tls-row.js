/**
 * The TLS row of `vibecarbon status`: does the domain serve a trusted
 * certificate right now, and if not, is issuance still being retried?
 *
 * What it reads, and from where:
 * - a live TLS probe of the domain (probeTlsTrustOnce, full verification).
 *   The on-disk record (envConfig.tls) is what the last deploy saw, so it
 *   stays 'pending' after the server's tls-retry cron lands the certificate:
 *   the live answer always wins. A trusted probe names the expiry and serial,
 *   never the key or the certificate body;
 * - on compose and compose-ha, only while the domain is untrusted, the
 *   tls-retry cron's own record on the role primary (backups/tls-retry.state
 *   and backups/tls-retry.count, carbon/backup/tls-retry.sh). It shows the
 *   retry count, "waiting for DNS", or that the retries gave up, with the
 *   command that re-arms them (a deploy clears the counter). k8s has no
 *   cron: cert-manager retries on its own backoff.
 *
 * Read-only: one TLS handshake (two when untrusted, the second only to name
 * what is served) and one `cat` of two small files. Never throws.
 */
import { existsSync } from 'node:fs';
import { resolvePrimary } from '../cli/resolve-primary.js';
import { c } from '../colors.js';
import { probeTlsTrustOnce } from '../deploy/tls-ready.js';
import { getSSHKeyPath, sshRun } from '../ssh.js';

/** The cron's retry ceiling (MAX_RESTARTS in carbon/backup/tls-retry.sh). */
export const TLS_RETRY_MAX = 48;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The two cron files as `STATE=<word>` and `COUNT=<n>` lines. Either may be
 * missing (a deploy removes both), which reads as nothing recorded.
 * @param {string} remoteDir
 */
export function tlsRetryReadSh(remoteDir) {
  return (
    `cd ${remoteDir} && ` +
    'echo "STATE=$(cat backups/tls-retry.state 2>/dev/null)"; ' +
    'echo "COUNT=$(cat backups/tls-retry.count 2>/dev/null)"'
  );
}

/**
 * @param {string} out tlsRetryReadSh output
 * @returns {{ state: string|null, count: number }}
 */
export function parseTlsRetryState(out) {
  const text = String(out ?? '');
  const state = /^STATE=(\S*)/m.exec(text)?.[1] || null;
  const countText = /^COUNT=(\S*)/m.exec(text)?.[1] ?? '';
  const count = /^\d+$/.test(countText) ? Number(countText) : 0;
  return { state, count };
}

/**
 * What the cron's record means for the row, or null when it adds nothing
 * (no record yet, or a state with nothing to tell the operator).
 * @param {{ state: string|null, count: number }} record
 * @param {string} envName
 */
function retryFacts({ state, count }, envName) {
  if (state === 'gave-up') {
    return { kind: 'gave-up', count, command: `vibecarbon deploy ${envName}` };
  }
  if (state === 'waiting-dns') return { kind: 'waiting-dns' };
  if (count > 0) return { kind: 'retrying', count };
  return null;
}

/** The default cron read: over SSH on the role primary, bounded. */
function readRetryOnPrimary(envName, envConfig, projectName) {
  return async () => {
    const primary = resolvePrimary(envConfig, { env: envName });
    if (!primary?.ip) throw new Error('no primary server recorded');
    const key = getSSHKeyPath(envName);
    if (!existsSync(key)) throw new Error('no ssh key for this environment');
    return sshRun(primary.ip, key, ['bash', '-lc', tlsRetryReadSh(`/opt/${projectName}`)], {
      timeout: PROBE_TIMEOUT_MS,
      transportRetry: false,
    });
  };
}

/**
 * @param {string} domain
 * @param {{ envName: string, envConfig: object, projectName: string }} env
 * @param {{ probe?: typeof probeTlsTrustOnce, readRetry?: () => Promise<string> }} [deps] test seams
 * @returns {Promise<
 *   { state: 'trusted', expires: string|null, validTo: string|null, serialNumber: string|null } |
 *   { state: 'pending'|'untrusted', reason: string,
 *     retry?: { kind: 'gave-up', count: number, command: string } | { kind: 'waiting-dns' } |
 *       { kind: 'retrying', count: number } | { kind: 'unknown', error: string } }
 * >}
 */
export async function checkTls(domain, { envName, envConfig, projectName }, deps = {}) {
  const probe = deps.probe ?? probeTlsTrustOnce;
  let live;
  try {
    live = await probe(domain);
  } catch (err) {
    live = { trusted: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (live.trusted) {
    const validTo = live.validTo ?? null;
    return {
      state: 'trusted',
      expires: validTo ? validTo.slice(0, 10) : null,
      validTo,
      serialNumber: live.serialNumber ?? null,
    };
  }

  const record = envConfig?.tls;
  const pending = record?.state === 'pending';
  const row = {
    state: pending ? 'pending' : 'untrusted',
    reason: (pending ? record.reason : live.reason) || live.reason || 'untrusted',
  };
  const isCompose = envConfig?.deployMode === 'compose' || envConfig?.deployMode === 'compose-ha';
  if (!isCompose) return row;

  const readRetry = deps.readRetry ?? readRetryOnPrimary(envName, envConfig, projectName);
  try {
    const facts = retryFacts(parseTlsRetryState(await readRetry()), envName);
    if (facts) row.retry = facts;
  } catch (err) {
    row.retry = { kind: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
  return row;
}

const HINT = 'issuance retries in the background';

/**
 * The row's lines: a `TLS` header, the verdict, and on an untrusted domain
 * what the retries are doing.
 * @param {Awaited<ReturnType<typeof checkTls>>} tls
 * @returns {string[]}
 */
export function formatTlsLines(tls) {
  const lines = [c.bold('TLS')];
  if (tls.state === 'trusted') {
    const expires = tls.expires ? `  ${c.dim(`expires ${tls.expires}`)}` : '';
    lines.push(`  ${c.success('●')} ${c.success('trusted')}${expires}`);
    return lines;
  }
  const paint = tls.state === 'pending' ? c.warning : c.error;
  lines.push(`  ${paint('●')} ${paint(tls.state)}  ${c.dim(`(${tls.reason})`)}`);
  const retry = tls.retry;
  if (retry?.kind === 'gave-up') {
    lines.push(
      `  gave up after ${retry.count} retries. Once the ACME error in the Traefik log is fixed, run:`,
    );
    lines.push(`    ${c.info(retry.command)}`);
  } else if (retry?.kind === 'retrying') {
    lines.push(`  ${c.dim(`${HINT}: retrying ${retry.count}/${TLS_RETRY_MAX}`)}`);
  } else if (retry?.kind === 'waiting-dns') {
    lines.push(`  ${c.dim(`${HINT}: waiting for DNS to point at this server`)}`);
  } else if (retry?.kind === 'unknown') {
    lines.push(`  ${c.dim(`${HINT} (retry state unknown: ${retry.error})`)}`);
  } else if (tls.state === 'pending') {
    lines.push(`  ${c.dim(HINT)}`);
  }
  return lines;
}
