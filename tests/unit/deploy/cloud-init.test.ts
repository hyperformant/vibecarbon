import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSetupServerError,
  loadCloudInitScript,
} from '../../../src/lib/deploy/compose/index.js';

describe('compose cloud-init user_data', () => {
  const cloudInitPath = join(process.cwd(), 'carbon', 'cloud-init', 'docker-ce-setup.yaml');

  it('ships the cloud-init YAML in carbon/cloud-init/', () => {
    // Must be packaged with the CLI so every `vibecarbon deploy` has it.
    expect(existsSync(cloudInitPath)).toBe(true);
  });

  it('loadCloudInitScript returns a valid cloud-config YAML', () => {
    const contents = loadCloudInitScript();
    // cloud-init identifies a YAML cloud-config by the exact first line below.
    expect(contents.startsWith('#cloud-config')).toBe(true);
  });

  it('cloud-init installs ufw + unattended-upgrades at boot (so setupServer skips apt-get)', () => {
    const contents = readFileSync(cloudInitPath, 'utf-8');
    expect(contents).toMatch(/^\s*-\s+ufw\b/m);
    expect(contents).toMatch(/^\s*-\s+unattended-upgrades\b/m);
  });

  it('cloud-init touches /var/lib/vibecarbon/ready as the marker file setupServer polls', () => {
    const contents = readFileSync(cloudInitPath, 'utf-8');
    expect(contents).toContain('/var/lib/vibecarbon/ready');
  });

  it('cloud-init opens only the Traefik-facing ports (22, 80, 443) in ufw', () => {
    const contents = readFileSync(cloudInitPath, 'utf-8');
    expect(contents).toMatch(/ufw, allow, '22\/tcp'/);
    expect(contents).toMatch(/ufw, allow, '80\/tcp'/);
    expect(contents).toMatch(/ufw, allow, '443\/tcp'/);
    // Negative: nothing else should be allowed by default.
    const openPorts = [...contents.matchAll(/ufw, allow, '(\d+)\/tcp'/g)].map((m) => m[1]);
    expect(new Set(openPorts)).toEqual(new Set(['22', '80', '443']));
  });

  it('stays under the 32KB Hetzner user_data cap with generous headroom', () => {
    const contents = loadCloudInitScript();
    expect(Buffer.byteLength(contents, 'utf-8')).toBeLessThan(16 * 1024);
  });
});

describe('setupServer failure message (SSH connectivity vs cloud-init stall)', () => {
  it('blames SSH connectivity — not cloud-init — when SSH never connected', () => {
    // everConnected=false: every probe failed to establish SSH, so cloud-init
    // readiness was never observed. Blaming cloud-init sends the operator to the
    // wrong place (this is the exact cell-modem / port-22-block case).
    const err = buildSetupServerError('5.78.41.67', false, '');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ssh|connect|unreachable|network|port 22/i);
    expect(err.message).not.toMatch(/cloud-init never reached/i);
    // Names the host so the operator knows which box.
    expect(err.message).toContain('5.78.41.67');
  });

  it('blames cloud-init and includes the log tail when SSH connected but the marker never appeared', () => {
    const tail = 'Cloud-init v. 24.1 running... some failure detail';
    const err = buildSetupServerError('5.78.41.67', true, tail);
    expect(err.message).toMatch(/cloud-init never reached the ready marker/i);
    expect(err.message).toContain(tail);
  });

  it('defaults to 180s in both messages when no timeoutMs is passed (Hetzner-compatible default)', () => {
    expect(buildSetupServerError('5.78.41.67', false, '').message).toContain('within 180s');
    expect(buildSetupServerError('5.78.41.67', true, '').message).toContain('within 180s');
  });

  it("renders the actual budget used — a provider-specific timeoutMs (e.g. DigitalOcean's 600s), not a hardcoded 180s", () => {
    const sshMsg = buildSetupServerError('203.0.113.9', false, '', 600_000);
    expect(sshMsg.message).toContain('within 600s');
    expect(sshMsg.message).not.toContain('180s');

    const cloudInitMsg = buildSetupServerError('203.0.113.9', true, 'tail', 600_000);
    expect(cloudInitMsg.message).toContain('within 600s');
    expect(cloudInitMsg.message).not.toContain('180s');
  });
});
