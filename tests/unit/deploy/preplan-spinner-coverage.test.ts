import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the dead-silence window right after the credential
 * lines ("✓ Using S3 credentials …").
 *
 * Between those lines and the first plan output, the orchestrator awaits
 * ensureOperatorIpAccess (an external IP-echo HTTP round-trip plus a Hetzner
 * firewall patch) and shouldSkipWithVerify('s3-setup') (three S3 bucket HEAD
 * probes). On a slow uplink that is seconds of dead air with no spinner —
 * the terminal just sits on a bare cursor and the deploy looks hung. This is
 * a source-level guard (the pre-plan flow has no unit harness — it's only
 * exercised in e2e, which doesn't look at TTY output).
 */
describe('deploy pre-plan phase keeps a spinner over its network waits', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url)),
    'utf8',
  );

  it('starts a spinner before awaiting ensureOperatorIpAccess', () => {
    const start = src.indexOf('accessSpinner.start(');
    const call = src.indexOf('await ensureOperatorIpAccess(');
    expect(start).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(start).toBeLessThan(call);
  });

  it('routes operator-ip onMessage through progressLog, not p.log.info (raw writes shred an active spinner)', () => {
    expect(src).toMatch(/onMessage:\s*\(msg\)\s*=>\s*progressLog\(msg\)/);
    expect(src).not.toMatch(/onMessage:\s*\(msg\)\s*=>\s*p\.log\.info\(msg\)/);
  });

  it('stops the operator-ip spinner on the failure path too (a thrown error mid-spinner corrupts the error output)', () => {
    expect(src).toMatch(/accessSpinner\.stop\([^)]*,\s*1\)/);
  });

  it('covers the s3-setup bucket verification probes with a spinner', () => {
    const start = src.indexOf("s3Spinner.start('Verifying S3 buckets')");
    const verify = src.indexOf("shouldSkipWithVerify('s3-setup'");
    expect(start).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(-1);
    expect(start).toBeLessThan(verify);
  });
});

/**
 * Regression guard for CONCURRENT spinner overlap (deploy output garble like
 * `Creating DNS records...◒ Provisioni◇` and `Pointing → IP◒ Creating DNS`).
 *
 * setupSimple() starts its OWN internal clack spinner unless the caller passes
 * `onProgress` (`const s = onProgress ? null : spinner()`). Two call paths must
 * suppress it or a second animation loop fights the foreground spinner over the
 * one TTY line:
 *   1. the background DNS warm-up (runs concurrently with "Provisioning VPS"),
 *   2. the compose-dns-update effect (already owns a "Pointing → IP" spinner).
 * The k8s floating-IP update is sequential/foreground and correctly keeps its
 * internal spinner — do NOT require onProgress there.
 */
describe('deploy DNS writes never run a second spinner concurrently', () => {
  const orch = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url)),
    'utf8',
  );
  const effects = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/effects/index.js', import.meta.url)),
    'utf8',
  );

  it('the background DNS warm-up suppresses setupSimple’s internal spinner', () => {
    // The 0.0.0.0 warm-up write must pass onProgress so no spinner animates
    // under the concurrent "Provisioning VPS" spinner.
    expect(orch).toMatch(
      /updateDnsIp\(dnsToken, dnsZoneId, domain, '0\.0\.0\.0', \{\s*onProgress:/,
    );
  });

  it('the compose-dns-update effect routes DNS progress to its own spinner', () => {
    // It already owns dnsSpinner ("Pointing → IP") — setupSimple must not start
    // a second one; its progress beat updates the existing spinner's message.
    expect(effects).toMatch(/updateDnsIp\(dnsToken, dnsZoneId, domain, serverIp, \{\s*onProgress:/);
  });

  it('setupSimple honors onProgress by skipping its internal spinner (EVERY registered backend)', async () => {
    // Registry walk (was a two-file hand-list — seam-audit hazard H17): a new
    // DNS backend that starts its own spinner under onProgress would garble
    // the caller-owned line, and a hand-list would never see it.
    const { DNS_PROVIDERS } = await import('../../../src/lib/dns-provider.js');
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      const rel = `../../../src/lib/${row.modulePath.replace(/^\.\//, '')}`;
      const provider = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(provider, id).toMatch(/const s = (?:options\.)?onProgress \? null : spinner\(\)/);
    }
  });
});
