import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Helm-install / cert-manager admission census.
 *
 * HISTORY: this file used to test `runHelmWithWebhookRetry` — the caBundle
 * warm-up ladder wrapped around cert-manager-admitted chart installs
 * (2026-08-10 e3 incident). That helper is DELETED (band-aid removal,
 * 2026-08-16): `awaitCertManagerAdmission` now PROVES the admission pipeline
 * serves before anything traverses it, so a webhook failure downstream is a
 * regression that must fail loudly, not be retried.
 *
 * What survives is the census, with its guard rule inverted: every
 * `helm upgrade --install` in the deploy tree must be classified (does the
 * chart create cert-manager-admitted resources — Certificate/Issuer?), and
 * every ADMITTED chart must sit DOWNSTREAM of the admission probe in
 * applyK3sManifests, so the e3 race cannot recur as a silent reordering.
 */

const ROOT = process.cwd();
const DEPLOY_DIR = join(ROOT, 'src', 'lib', 'deploy');

function findJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findJsFiles(p));
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

interface HelmInstallSite {
  file: string;
  line: number;
  /** Surrounding source (±12 lines) used to match a registry row's probe. */
  window: string;
}

function collectHelmInstallSites(): HelmInstallSite[] {
  const sites: HelmInstallSite[] = [];
  for (const file of findJsFiles(DEPLOY_DIR)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (!/'upgrade',\s*$/.test(line) && !/'upgrade',\s*'--install'/.test(line)) return;
      // Only count real helm argv shapes: the previous or same line names helm.
      const near = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
      if (!/'helm'|helmArgs|runHelm/i.test(near)) return;
      sites.push({
        file: relative(ROOT, file),
        line: i + 1,
        window: lines.slice(Math.max(0, i - 12), i + 13).join('\n'),
      });
    });
  }
  return sites;
}

interface ChartRow {
  probe: string;
  chart: string;
  certManagerAdmitted: boolean;
  notes: string;
}

const CHART_REGISTRY: ChartRow[] = [
  {
    // Installed into the cert-manager namespace on a cold cluster.
    probe: "'cert-manager'",
    chart: 'cert-manager-webhook-hetzner (third-party DNS-01 webhook)',
    certManagerAdmitted: true,
    notes:
      'Ships its own Issuer + Certificate for the APIService serving cert; both are admitted by ' +
      "cert-manager's ValidatingWebhookConfiguration. The admission probe upstream is what makes " +
      'a bare install safe.',
  },
  {
    probe: 'SUPABASE_HELM_CHART',
    chart: 'supabase community chart',
    certManagerAdmitted: false,
    notes:
      'carbon/k8s/values/supabase.values.yaml (+ .standby) declare ZERO cert-manager / Certificate / ' +
      'Issuer / tls / acme resources — the chart creates nothing that traverses cert-manager’s ' +
      'validating webhook; TLS is handled by the separately-applied cert-manager-resources kustomization + traefik.',
  },
];

const sites = collectHelmInstallSites();

describe('helm-install cert-manager admission census', () => {
  it('detects the imperative helm upgrade --install population (not vacuously green)', () => {
    // Two sites exist today (supabase + DNS-01 webhook). If a refactor drops
    // this to zero the sweep has gone blind — fix the detector, not the floor.
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it('every detected helm install matches exactly one registry row (new installs must be classified)', () => {
    for (const site of sites) {
      const matches = CHART_REGISTRY.filter((r) => site.window.includes(r.probe));
      expect(
        matches.map((m) => m.chart),
        `helm upgrade --install at ${site.file}:${site.line} matched ${matches.length} registry ` +
          'rows (want exactly 1). Add/adjust a CHART_REGISTRY row: decide whether the chart creates ' +
          'cert-manager-admitted resources (Certificate/Issuer/ClusterIssuer). If so it MUST run ' +
          'after awaitCertManagerAdmission.',
      ).toHaveLength(1);
    }
  });

  it('every cert-manager-ADMITTED chart install runs AFTER the admission probe', () => {
    // Inverted 2026-08-16 (band-aid removal): the guard is the CONDITION, not
    // a retry. Every chart whose resources traverse the admission pipeline
    // must sit downstream of the probe in applyK3sManifests source order.
    const admitted = sites.filter((s) => {
      const row = CHART_REGISTRY.find((r) => s.window.includes(r.probe));
      return row?.certManagerAdmitted;
    });
    expect(admitted.length).toBeGreaterThanOrEqual(1);

    const k3sSrc = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const probeCallIdx = k3sSrc.indexOf('awaitCertManagerAdmission({ env })');
    expect(probeCallIdx, 'the admission probe must be wired in k3s.js').toBeGreaterThan(-1);
    const probeLine = k3sSrc.slice(0, probeCallIdx).split('\n').length;

    for (const site of admitted) {
      expect(site.file).toBe('src/lib/deploy/k8s/k3s.js');
      expect(
        site.line,
        `${site.file}:${site.line}: cert-manager-admitted chart installed BEFORE the admission ` +
          'probe — its Issuer/Certificate would race the unproven webhook pipeline (the 2026-08-10 ' +
          'e3 incident, reintroduced by reordering)',
      ).toBeGreaterThan(probeLine);
    }
  });

  it('every EXEMPT chart install documents why (notes are load-bearing)', () => {
    for (const row of CHART_REGISTRY.filter((r) => !r.certManagerAdmitted)) {
      expect(
        row.notes.length >= 40,
        `${row.chart}: an exemption without a real justification is how the next admitted chart ` +
          'slips through unclassified',
      ).toBe(true);
    }
  });
});
