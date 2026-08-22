/** Wiring guards for the seed-standby init container (spec 2026-07-16). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('seed-standby init container (values)', () => {
  const values = read('carbon/k8s/values/supabase.values.yaml');

  it('exists, runs the ConfigMap script (guarded), and mounts the RAW volume (no subPath)', () => {
    expect(values).toMatch(/- name: seed-standby/);
    // Guarded form: an optional ConfigMap with a missing map produces an empty
    // mounted dir, so the command must not fail hard on a bare `bash <script>`.
    expect(values).toContain(
      '[ -f /etc/vibecarbon/seed-standby.sh ] && exec bash /etc/vibecarbon/seed-standby.sh',
    );
    // raw-volume mount at /seed-volume with NO subPath on that mount
    expect(values).toMatch(/- name: postgres-volume\s+mountPath: \/seed-volume\s+(?!.*subPath)/);
  });

  it('injects the env contract: role, restore marker, password, relay endpoint', () => {
    for (const pattern of [
      /name: SEED_PRIMARY_HOST\s+value: "\{\{REPL_RELAY_HOST\}\}"/,
      /name: SEED_PRIMARY_PORT\s+value: "\{\{REPL_RELAY_PORT\}\}"/,
      /name: WALG_ROLE\s+value: "\{\{WALG_ROLE\}\}"/,
    ]) {
      expect(values).toMatch(pattern);
    }
    expect(values).toMatch(
      /name: REPL_PASSWORD\s+valueFrom:\s+secretKeyRef:\s+name: vibecarbon-secrets\s+key: REPL_PASSWORD\s+optional: true/,
    );
  });

  it('mounts the seed script ConfigMap optionally (missing map must not block the pod)', () => {
    expect(values).toMatch(/name: vibecarbon-seed-standby[\s\S]{0,120}optional: true/);
  });
});

describe('installSupabase renders relay placeholders and applies the ConfigMap', () => {
  const k3s = read('src/lib/deploy/k8s/k3s.js');
  it('renders {{REPL_RELAY_HOST}}/{{REPL_RELAY_PORT}}', () => {
    expect(k3s).toMatch(/\.replace\(\s*\/\\\{\\\{REPL_RELAY_HOST\\\}\\\}\/g,/);
    expect(k3s).toMatch(/\.replace\(\s*\/\\\{\\\{REPL_RELAY_PORT\\\}\\\}\/g,/);
  });
  it('applies the vibecarbon-seed-standby ConfigMap before helm', () => {
    expect(k3s).toContain('vibecarbon-seed-standby');
    expect(k3s).toContain('buildStandbySeedInitScript');
  });
});
