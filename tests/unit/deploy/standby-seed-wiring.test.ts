/** Wiring guards for the seed-standby init container (spec 2026-07-16). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('seed-standby init container (db StatefulSet)', () => {
  const sts = read('carbon/k8s/base/db/statefulset.yaml');

  it('exists, runs the ConfigMap script (guarded), and mounts the RAW volume (no subPath)', () => {
    expect(sts).toMatch(/- name: seed-standby/);
    // Guarded form: an optional ConfigMap with a missing map produces an empty
    // mounted dir, so the command must not fail hard on a bare `bash <script>`.
    expect(sts).toContain(
      '[ -f /etc/vibecarbon/seed-standby.sh ] && exec bash /etc/vibecarbon/seed-standby.sh',
    );
    // raw-volume mount at /seed-volume with NO subPath on that mount
    expect(sts).toMatch(/- name: data\s+mountPath: \/seed-volume\s+(?!.*subPath)/);
  });

  it('injects the env contract: role, restore marker, password, relay endpoint', () => {
    for (const pattern of [
      /name: SEED_PRIMARY_HOST\s+value: "\{\{REPL_RELAY_HOST\}\}"/,
      /name: SEED_PRIMARY_PORT\s+value: "\{\{REPL_RELAY_PORT\}\}"/,
      /name: WALG_ROLE\s+value: "\{\{WALG_ROLE\}\}"/,
    ]) {
      expect(sts).toMatch(pattern);
    }
    expect(sts).toMatch(
      /name: REPL_PASSWORD\s+valueFrom:\s+secretKeyRef:\s+name: vibecarbon-secrets\s+key: REPL_PASSWORD\s+optional: true/,
    );
  });

  it('mounts the seed script ConfigMap optionally (missing map must not block the pod)', () => {
    expect(sts).toMatch(/name: vibecarbon-seed-standby[\s\S]{0,120}optional: true/);
  });
});

describe('the deploy renders the relay placeholders and applies the ConfigMap first', () => {
  const k3s = read('src/lib/deploy/k8s/k3s.js');
  it('renders {{REPL_RELAY_HOST}}/{{REPL_RELAY_PORT}}', () => {
    expect(k3s).toMatch(/REPL_RELAY_HOST: dbPrivateIp,/);
    expect(k3s).toMatch(/REPL_RELAY_PORT: String\(REPL_GATEWAY_PORT\),/);
  });
  it('applies the vibecarbon-seed-standby ConfigMap before k8s/base creates the StatefulSet', () => {
    expect(k3s).toContain('vibecarbon-seed-standby');
    expect(k3s).toContain('buildStandbySeedInitScript');
    const body = k3s.slice(k3s.indexOf('export async function applyK3sManifests('));
    expect(body.indexOf('applyDbSeedConfigMap({ env })')).toBeGreaterThan(-1);
    expect(body.indexOf('applyDbSeedConfigMap({ env })')).toBeLessThan(
      body.indexOf("runKubectlWithRetry(['apply', '-k', baseDir]"),
    );
  });
});
