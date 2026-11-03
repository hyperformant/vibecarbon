/**
 * Unit tests for the TLS re-issue section of the e2e failure bundle
 * (buildTlsReissueDiagnostics in tests/e2e/utils/cluster-diagnostics.ts).
 *
 * Motivation: on DO k8s-ha runs cert-manager re-issued a certificate the
 * deploy had just restored from its snapshot (CertificateRequest
 * vibecarbon-tls-1, 2 of 2 runs), and the "Issuing ... because ..." event
 * had already fallen out of the 100-event namespace window. These sections
 * keep the evidence that answers "why did cert-manager issue?" in the bundle
 * no matter how noisy the namespace was.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTlsReissueDiagnostics,
  CERT_MANAGER_LOG_GREP_MAX_LINES,
  TLS_REISSUE_SECTION_MAX_CHARS,
} from '../../e2e/utils/cluster-diagnostics.js';

const KC = '/tmp/proj/.vibecarbon/kubeconfig-e3-primary';
const LABEL = 'kubeconfig-e3-primary';

const cmds = buildTlsReissueDiagnostics(KC, LABEL);
const script = (labelPart: string): string => {
  const c = cmds.find((x) => x.label.includes(labelPart));
  if (!c) throw new Error(`no section labelled ${labelPart}`);
  return c.argv.join(' ');
};

describe('buildTlsReissueDiagnostics', () => {
  it('labels every section with the kubeconfig and targets that kubeconfig', () => {
    expect(cmds.length).toBeGreaterThanOrEqual(4);
    for (const c of cmds) {
      expect(c.label.startsWith(`${LABEL}: `)).toBe(true);
      expect(c.argv.join(' ')).toContain(`--kubeconfig ${KC}`);
      expect(c.timeoutMs).toBeGreaterThan(0);
      expect(c.timeoutMs).toBeLessThanOrEqual(60_000);
      expect(c.maxChars).toBe(TLS_REISSUE_SECTION_MAX_CHARS);
    }
  });

  it('(a) greps the cert-manager controller log for its issuing reasons, bounded', () => {
    const s = script('cert-manager issuing log');
    expect(s).toContain('-n cert-manager logs deploy/cert-manager --since=2h');
    expect(s).toContain('grep -E "must be re-issued|re-issu|Issuing');
    expect(s).toContain(`head -${CERT_MANAGER_LOG_GREP_MAX_LINES}`);
    expect(CERT_MANAGER_LOG_GREP_MAX_LINES).toBeGreaterThan(0);
    expect(CERT_MANAGER_LOG_GREP_MAX_LINES).toBeLessThanOrEqual(200);
    // grep exits 1 when nothing matched: that is an answer, not a failure.
    expect(s).toMatch(/\|\| true/);
  });

  it('(b) reads the events of the Certificate and of each of its requests by name', () => {
    const s = script('events of Certificate/vibecarbon-tls');
    expect(s).toContain('--field-selector involvedObject.name=vibecarbon-tls');
    expect(s).toContain('get certificaterequests');
    expect(s).toContain('grep -E "^vibecarbon-tls-[0-9]+$"');
    expect(s).toContain('--field-selector "involvedObject.name=$r"');
  });

  it('(b) records the Certificate and its requests with creation times and revisions', () => {
    const s = script('certificate timeline');
    expect(s).toContain('certificate vibecarbon-tls');
    expect(s).toContain('.status.revision');
    expect(s).toContain('.metadata.creationTimestamp');
    expect(s).toContain('cert-manager\\.io/certificate-revision');
  });

  it('(c) reads Secret metadata and the tls.crt serial, never key material', () => {
    const s = script('Secret/vibecarbon-tls metadata');
    expect(s).toContain('.metadata.annotations');
    expect(s).toContain('.metadata.labels');
    expect(s).toContain('.metadata.managedFields[*]');
    expect(s).toContain('.manager');
    expect(s).toContain('.metadata.resourceVersion');
    expect(s).toContain('.metadata.creationTimestamp');
    expect(s).toContain('{.data.tls\\.crt}');
    expect(s).toContain('openssl x509 -noout -serial');
  });

  it('never prints a Secret whole or names its private key', () => {
    for (const c of cmds) {
      const s = c.argv.join(' ');
      expect(s).not.toContain('tls.key');
      expect(s).not.toContain('tls\\.key');
      expect(s).not.toMatch(/get secrets?\b[^|;]*-o (json|yaml)\b/);
      expect(s).not.toMatch(/describe secret/);
      expect(s).not.toMatch(/\{\.data\}/);
    }
  });

  it('(d) names the controller pod start times and the leader lease holder', () => {
    const s = script('cert-manager controller and leader lease');
    expect(s).toContain(
      '-n cert-manager get pods -l app.kubernetes.io/name=cert-manager,app.kubernetes.io/component=controller',
    );
    expect(s).toContain('.status.startTime');
    expect(s).toContain('get leases -A');
    expect(s).toContain('.spec.holderIdentity');
    expect(s).toContain('.spec.renewTime');
    expect(s).toContain('grep -E "NAMESPACE|cert-manager"');
    // The controller restarts the flags patch causes show as ReplicaSets.
    expect(s).toContain('-n cert-manager get replicasets');
  });

  it('bounds every kubectl call inside a script with timeout', () => {
    for (const c of cmds) {
      const s = c.argv.join(' ');
      const calls = s.match(/kubectl --kubeconfig/g) ?? [];
      const bounded = s.match(/timeout \d+ kubectl --kubeconfig/g) ?? [];
      expect(bounded.length).toBe(calls.length);
    }
  });
});
