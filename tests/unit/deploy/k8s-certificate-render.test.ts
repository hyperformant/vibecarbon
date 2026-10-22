/**
 * The vibecarbon-tls Certificate is rendered by the deploy, before anything
 * is applied, with this deploy's names and issuer. It used to be applied with
 * the `app.example.com` placeholder and patched afterwards: a placeholder
 * Certificate is a spec mismatch that cert-manager acts on, and it would also
 * make a Secret restored from a snapshot look wrong for the Certificate.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { renderTlsCertificateManifest } from '../../../carbon/scripts/render-tls-certificate.mjs';
import { PROMOTE_ISSUER_ANNOTATION } from '../../../src/lib/deploy/k8s/acme-issuer-policy.js';
import { buildDbManifestValues, renderK8sBase } from '../../../src/lib/deploy/k8s/k3s.js';

const ROOT = join(__dirname, '../../..');
const BASE = join(ROOT, 'carbon/k8s/base');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

const TLS = {
  dnsNames: ['app.example.test', '*.app.example.test'],
  issuerName: 'letsencrypt-prod-hetzner',
  effectiveIssuer: 'letsencrypt-prod-hetzner',
};

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

const values = () => ({
  ...buildDbManifestValues({
    dbImageTag: 'ghcr.io/org/postgres:17-walg1',
    storageClass: 'provider-csi',
    dbPrivateIp: '10.0.1.2',
    walArchiveSha: 'abc',
  }),
  MASTER_PRIVATE_IP: '10.0.1.1',
});

describe('renderTlsCertificateManifest', () => {
  it('carries the names, the effective issuer, the promote annotation and prune: disabled', () => {
    const doc = load(renderTlsCertificateManifest(TLS)) as Doc;
    expect(doc.apiVersion).toBe('cert-manager.io/v1');
    expect(doc.kind).toBe('Certificate');
    expect(doc.metadata.name).toBe('vibecarbon-tls');
    expect(doc.metadata.namespace).toBe('vibecarbon');
    expect(doc.spec.secretName).toBe('vibecarbon-tls');
    expect(doc.spec.dnsNames).toEqual(TLS.dnsNames);
    expect(doc.spec.issuerRef).toEqual({ name: TLS.effectiveIssuer, kind: 'ClusterIssuer' });
    expect(doc.metadata.annotations[PROMOTE_ISSUER_ANNOTATION]).toBe(TLS.issuerName);
    expect(doc.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    expect(renderTlsCertificateManifest(TLS)).not.toContain('app.example.com');
  });

  it('a pilot standby references the self-signed issuer and keeps the real one in the annotation', () => {
    const doc = load(
      renderTlsCertificateManifest({ ...TLS, effectiveIssuer: 'vibecarbon-standby-selfsigned' }),
    ) as Doc;
    expect(doc.spec.issuerRef.name).toBe('vibecarbon-standby-selfsigned');
    expect(doc.metadata.annotations[PROMOTE_ISSUER_ANNOTATION]).toBe('letsencrypt-prod-hetzner');
  });

  it('refuses a missing name list or issuer', () => {
    expect(() => renderTlsCertificateManifest({ ...TLS, dnsNames: [] })).toThrow(/dnsNames/);
    expect(() => renderTlsCertificateManifest({ ...TLS, issuerName: '' })).toThrow(/issuer/);
    expect(() => renderTlsCertificateManifest({ ...TLS, effectiveIssuer: '' })).toThrow(/issuer/);
  });
});

describe('renderK8sBase renders the Certificate', () => {
  it('writes the rendered Certificate into the copy, and leaves no placeholder Certificate', () => {
    const out = renderK8sBase(BASE, values(), undefined, TLS);
    try {
      const cert = readFileSync(join(out, 'traefik', 'certificate.yaml'), 'utf-8');
      expect(cert).toBe(renderTlsCertificateManifest(TLS));
      // The only file of the rendered tree still naming the placeholder
      // domain is the vibecarbon-config SITE_URL, which the deploy patches
      // right after the apply (and Flux owns; a separate follow-up).
      const leftovers = walkFiles(out)
        .filter((f) => readFileSync(f, 'utf-8').includes('app.example.com'))
        .map((f) => relative(out, f));
      expect(leftovers).toEqual(['config/configmap.yaml']);
      expect(readFileSync(join(out, 'config', 'configmap.yaml'), 'utf-8')).toMatch(
        /SITE_URL: "https:\/\/app\.example\.com"/,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    // The source tree keeps its placeholder (never dirties the operator's git tree).
    expect(readFileSync(join(BASE, 'traefik', 'certificate.yaml'), 'utf-8')).toContain(
      'app.example.com',
    );
  });

  it('renders the Certificate into a base whose tree has no traefik directory yet', () => {
    const src = mkdtempSync(join(tmpdir(), 'vc-cert-base-'));
    try {
      mkdirSync(join(src, 'db'), { recursive: true });
      const sts = readFileSync(join(BASE, 'db', 'statefulset.yaml'), 'utf-8');
      writeFileSync(join(src, 'db', 'statefulset.yaml'), sts);
      const out = renderK8sBase(src, values(), undefined, TLS);
      try {
        const doc = load(readFileSync(join(out, 'traefik', 'certificate.yaml'), 'utf-8')) as Doc;
        expect(doc.spec.dnsNames).toEqual(TLS.dnsNames);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('throws without a tls argument', () => {
    expect(() => renderK8sBase(BASE, values(), undefined, undefined as never)).toThrow(
      /renderK8sBase: no TLS certificate/,
    );
    expect(() =>
      renderK8sBase(BASE, values(), undefined, { ...TLS, dnsNames: [] } as never),
    ).toThrow(/renderK8sBase: no TLS certificate/);
  });
});
