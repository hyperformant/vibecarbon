/**
 * `vibecarbon status` TLS row.
 *
 * The row probes the domain live, because the on-disk record
 * (envConfig.tls) is only what the last deploy saw: a deploy that finished
 * TLS pending keeps `state: 'pending'` on disk after the server's tls-retry
 * cron lands the certificate. On compose it also reads the cron's own
 * record (backups/tls-retry.state and .count on the primary), so a retry
 * that gave up says so and names the command that re-arms it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  checkTls,
  formatTlsLines,
  parseTlsRetryState,
  TLS_RETRY_MAX,
} from '../../../src/lib/status/tls-row.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const D = 'app.example.com';

const composeEnv = (tls?: object) => ({
  deployMode: 'compose',
  domain: D,
  servers: [{ id: 's1', name: 'prod', ip: '203.0.113.5' }],
  ...(tls && { tls }),
});
const pendingRecord = {
  state: 'pending',
  checkedAt: '2026-10-21T10:00:00.000Z',
  reason: 'self-signed certificate',
  ca: 'letsencrypt-prod',
};
const trustedProbe = vi.fn(async () => ({
  trusted: true as const,
  validTo: '2026-12-30T08:15:00.000Z',
  serialNumber: '04A1B2C3',
}));
const untrustedProbe = async () => ({
  trusted: false as const,
  reason: 'unable to verify the first certificate',
  served: { subject: 'TRAEFIK DEFAULT CERT', issuer: 'TRAEFIK DEFAULT CERT' },
});

async function row(envConfig: object, deps: object, envName = 'prod') {
  const tls = await checkTls(D, { envName, envConfig, projectName: 'demo' }, deps);
  return { tls, lines: formatTlsLines(tls).map(strip) };
}

describe('checkTls + formatTlsLines', () => {
  it('trusted renders the expiry date, and never reads the retry state', async () => {
    const readRetry = vi.fn();
    const { tls, lines } = await row(composeEnv(pendingRecord), {
      probe: trustedProbe,
      readRetry,
    });
    // The live probe wins over the stale on-disk 'pending'.
    expect(tls).toEqual({
      state: 'trusted',
      expires: '2026-12-30',
      validTo: '2026-12-30T08:15:00.000Z',
      serialNumber: '04A1B2C3',
    });
    expect(lines).toEqual(['TLS', '  ● trusted  expires 2026-12-30']);
    expect(readRetry).not.toHaveBeenCalled();
  });

  it('untrusted with a pending record renders pending, the stored reason and the hint', async () => {
    const { tls, lines } = await row(composeEnv(pendingRecord), {
      probe: untrustedProbe,
      readRetry: async () => '',
    });
    expect(tls.state).toBe('pending');
    expect(lines).toEqual([
      'TLS',
      '  ● pending  (self-signed certificate)',
      '  issuance retries in the background',
    ]);
  });

  it('untrusted and not pending renders untrusted with the live reason', async () => {
    const { lines } = await row(composeEnv({ ...pendingRecord, state: 'trusted' }), {
      probe: untrustedProbe,
      readRetry: async () => '',
    });
    expect(lines).toEqual(['TLS', '  ● untrusted  (unable to verify the first certificate)']);
  });

  it('a probe that throws reads as untrusted with its message', async () => {
    const { lines } = await row(composeEnv(), {
      probe: async () => {
        throw new Error('getaddrinfo ENOTFOUND app.example.com');
      },
      readRetry: async () => '',
    });
    expect(lines).toEqual(['TLS', '  ● untrusted  (getaddrinfo ENOTFOUND app.example.com)']);
  });

  it('shows the retry count while the cron restarts traefik', async () => {
    const { lines } = await row(composeEnv(pendingRecord), {
      probe: untrustedProbe,
      readRetry: async () => 'STATE=restart\nCOUNT=3',
    });
    expect(lines.at(-1)).toBe(`  issuance retries in the background: retrying 3/${TLS_RETRY_MAX}`);
  });

  it('shows waiting for DNS while the domain does not point at the server', async () => {
    const { lines } = await row(composeEnv(pendingRecord), {
      probe: untrustedProbe,
      readRetry: async () => 'STATE=waiting-dns\nCOUNT=',
    });
    expect(lines.at(-1)).toBe(
      '  issuance retries in the background: waiting for DNS to point at this server',
    );
  });

  it('gave up: says so and puts the re-arming command on its own line', async () => {
    const { tls, lines } = await row(
      composeEnv(pendingRecord),
      { probe: untrustedProbe, readRetry: async () => 'STATE=gave-up\nCOUNT=48' },
      'staging',
    );
    expect(tls.retry).toEqual({ kind: 'gave-up', count: 48, command: 'vibecarbon deploy staging' });
    expect(lines).toEqual([
      'TLS',
      '  ● pending  (self-signed certificate)',
      '  gave up after 48 retries. Once the ACME error in the Traefik log is fixed, run:',
      '    vibecarbon deploy staging',
    ]);
    // House style: no em dashes in user-facing copy.
    expect(lines.join('\n')).not.toContain('—');
  });

  it('an unreadable retry state is named, not silently dropped', async () => {
    const { lines } = await row(composeEnv(pendingRecord), {
      probe: untrustedProbe,
      readRetry: async () => {
        throw new Error('no ssh key for this environment');
      },
    });
    expect(lines.at(-1)).toBe(
      '  issuance retries in the background (retry state unknown: no ssh key for this environment)',
    );
  });

  it('k8s has no tls-retry cron (cert-manager retries): no SSH read', async () => {
    const readRetry = vi.fn();
    const { lines } = await row(
      { deployMode: 'kubernetes', domain: D, servers: [{ ip: '203.0.113.9' }], tls: pendingRecord },
      { probe: untrustedProbe, readRetry },
    );
    expect(readRetry).not.toHaveBeenCalled();
    expect(lines).toEqual([
      'TLS',
      '  ● pending  (self-signed certificate)',
      '  issuance retries in the background',
    ]);
  });

  it('the row carries no key or certificate material', async () => {
    const { tls } = await row(composeEnv(), { probe: trustedProbe, readRetry: async () => '' });
    expect(JSON.stringify(tls)).not.toMatch(/BEGIN|PRIVATE|tls\.key|certificate":/);
  });
});

describe('parseTlsRetryState', () => {
  it('reads the state word and the counter', () => {
    expect(parseTlsRetryState('STATE=restart\nCOUNT=7\n')).toEqual({ state: 'restart', count: 7 });
  });

  it('a fresh deploy (both files cleared) reads as nothing recorded', () => {
    expect(parseTlsRetryState('STATE=\nCOUNT=\n')).toEqual({ state: null, count: 0 });
  });

  it('a garbled counter counts as zero', () => {
    expect(parseTlsRetryState('STATE=young\nCOUNT=x1')).toEqual({ state: 'young', count: 0 });
  });
});

describe('lockstep with carbon/backup/tls-retry.sh', () => {
  const script = readFileSync(
    join(__dirname, '..', '..', '..', 'carbon', 'backup', 'tls-retry.sh'),
    'utf-8',
  );

  it('the retry ceiling matches the script', () => {
    expect(script).toContain(`MAX_RESTARTS=${TLS_RETRY_MAX}`);
  });

  it('the state words the row maps are the ones the script writes', () => {
    for (const word of ['restart', 'waiting-dns', 'gave-up']) {
      expect(script).toMatch(new RegExp(`(note ${word} |printf '%s\\\\n' ${word} )`));
    }
    expect(script).toContain('COUNT_FILE=backups/tls-retry.count');
    expect(script).toContain('STATE_FILE=backups/tls-retry.state');
  });
});
