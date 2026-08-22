/**
 * Deploy-failure detail extraction shared by the e2e deploy + restore steps.
 *
 * Live RCA (k8s restore FAIL, 2026-07-08 matrix run bae68dfa): the restore
 * step's extraction preferred the `(failed)` perf-marker line over the CLI's
 * `Error:` line, so the thrown message carried only
 * "[perf] deploy.k3s.full 868122ms (failed)" — zero classifiable signal —
 * and classify-failure tagged a textbook infra failure ("k3s binary did not
 * appear … Connection timed out") as [unknown], which E2E_RETRY_FLAKES does
 * not retry.
 */
import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../../e2e/utils/classify-failure.js';
import { extractDeployFailureDetail } from '../../e2e/utils/extract-failure-detail.js';

describe('extractDeployFailureDetail', () => {
  it('prefers the last structured FAIL: line over everything else', () => {
    const stdout = [
      'noise',
      'FAIL: first reason',
      'Error: some later error',
      '[perf] deploy.k3s.full 100ms (failed)',
      'FAIL: real reason',
    ].join('\n');
    expect(extractDeployFailureDetail(stdout, '')).toContain('FAIL: real reason');
  });

  it('falls back to the Error: line and keeps the (failed) perf marker as context', () => {
    const stdout = [
      '[perf] deploy.k3s.sideload.app 614476ms (failed)',
      '[perf] deploy.k3s.full 868122ms (failed)',
      'Deploy log saved under /home/x/.vibecarbon/logs/',
      'Error: [step:deploy-cluster] k3s binary did not appear on root@188.245.40.255 within 600s. Last SSH error: Command failed: ssh -i /k root@188.245.40.255 command -v k3s',
      'ssh: connect to host 188.245.40.255 port 22: Connection timed out',
    ].join('\n');
    const detail = extractDeployFailureDetail(stdout, '');
    expect(detail).toContain('k3s binary did not appear');
    expect(detail).toContain('[perf] deploy.k3s.full 868122ms (failed)');
  });

  it('regression 2026-07-08: the extracted detail classifies as infra, not unknown', () => {
    const stdout = [
      '[perf] deploy.k3s.full 868122ms (failed)',
      'Error: [step:deploy-cluster] k3s binary did not appear on root@188.245.40.255 within 600s. Last SSH error: Command failed: ssh',
      'ssh: connect to host 188.245.40.255 port 22: Connection timed out',
    ].join('\n');
    const detail = extractDeployFailureDetail(stdout, '');
    const { category } = classifyFailure({
      errorMessage: `Re-deploy before restore exited with code 1: ${detail.slice(-1000)}`,
    });
    expect(category).toBe('infra');
  });

  it('falls back to the (failed) perf line when there is no FAIL:/Error: line', () => {
    const stdout = 'lots of noise\n[perf] deploy.iac.upStack 407000ms (failed)\ntrailing noise';
    expect(extractDeployFailureDetail(stdout, '')).toBe(
      '[perf] deploy.iac.upStack 407000ms (failed)',
    );
  });

  it('falls back to the raw stdout tail, then stderr, when nothing structured matches', () => {
    expect(extractDeployFailureDetail('plain stdout tail', 'plain stderr')).toBe(
      'plain stdout tail',
    );
    expect(extractDeployFailureDetail('', 'plain stderr')).toBe('plain stderr');
  });

  it('finds structured lines in stderr too and strips ANSI color codes', () => {
    const stderr = '\x1b[31mFAIL: tls issuance timed out\x1b[0m';
    expect(extractDeployFailureDetail('', stderr)).toContain('FAIL: tls issuance timed out');
    expect(extractDeployFailureDetail('', stderr)).not.toContain('\x1b');
  });

  // 2026-08-09, round-B d3: cli.js's central handler printed only the bare
  // step wrapper (`Error: [step:deploy-cluster] code: -2`), which outranked
  // the Pulumi diagnostic that carried the actual signal (`error: expected
  // non-nil error with nil state …` — lowercase, so the Error: tier never
  // saw it). classify-failure got the wrapper, tagged [unknown], and a
  // classified infra shape read as unexplained for two rounds.
  it('digs past a bare [step:] code wrapper to the last informative Pulumi diagnostic', () => {
    const stdout = [
      ' +  digitalocean:index:ReservedIp ingress creating (1s) error: expected non-nil error with nil state during Create of urn:pulumi:d3::vibecarbon::digitalocean:index/reservedIp:ReservedIp::ingress',
      'Diagnostics:',
      '  digitalocean:index:ReservedIp (ingress):',
      '    error: expected non-nil error with nil state during Create of urn:pulumi:d3::vibecarbon::digitalocean:index/reservedIp:ReservedIp::ingress',
      '  pulumi:pulumi:Stack (vibecarbon-d3):',
      '    error: update failed',
      'Error: [step:deploy-cluster] code: -2',
      '[perf] deploy.k3s.full 39022ms (failed)',
    ].join('\n');
    const detail = extractDeployFailureDetail(stdout, '');
    expect(detail).toContain('expected non-nil error with nil state');
    expect(detail).toContain('Error: [step:deploy-cluster] code: -2');
    // Pulumi's generic footer must never be the chosen diagnostic.
    expect(detail).not.toMatch(/^error: update failed/);
  });

  it('keeps an INFORMATIVE Error: line as-is (no wrapper digging)', () => {
    const stdout = [
      'Error: [step:deploy-cluster] applyK3sManifests: kubectl apply failed: dial tcp 1.2.3.4:6443: i/o timeout',
      '[perf] deploy.k3s.full 100ms (failed)',
    ].join('\n');
    expect(extractDeployFailureDetail(stdout, '')).toContain('i/o timeout');
  });
});
