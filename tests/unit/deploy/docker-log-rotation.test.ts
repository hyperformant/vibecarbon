import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// Config guard: the shipped compose bootstrap must bound Docker's json-file
// logs at the DAEMON level. Without a global cap, every container on a
// single-VPS box grows its log file without limit until the root disk fills
// and the whole stack wedges (slow disk-fill outage). Setting log-opts in
// /etc/docker/daemon.json makes the cap the default for every container the
// deploy later starts — no per-service logging block required.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const cloudInitPath = join(repoRoot, 'carbon/cloud-init/docker-ce-setup.yaml');

type CloudConfig = {
  write_files?: Array<{ path?: string; content?: string; permissions?: string }>;
  runcmd?: Array<string | string[]>;
};

function loadCloudConfig(): CloudConfig {
  return loadYaml(readFileSync(cloudInitPath, 'utf-8')) as CloudConfig;
}

describe('compose cloud-init bounds Docker log growth', () => {
  it('writes /etc/docker/daemon.json with json-file log rotation caps', () => {
    const cfg = loadCloudConfig();
    const daemonWrite = (cfg.write_files ?? []).find((f) => f.path === '/etc/docker/daemon.json');
    expect(daemonWrite, 'cloud-init must write /etc/docker/daemon.json').toBeTruthy();

    const daemon = JSON.parse(daemonWrite?.content ?? '{}');
    expect(daemon['log-driver']).toBe('json-file');
    expect(daemon['log-opts']).toMatchObject({
      'max-size': '10m',
      'max-file': '3',
    });
  });

  it('restarts (or --now starts) docker after the config write so the cap applies', () => {
    // daemon.json only takes effect on a daemon (re)start. write_files runs
    // before runcmd, and the docker-ce app has usually already started docker,
    // so a plain `enable` would leave the daemon running with the OLD config.
    // Require an explicit restart, or `enable --now` on a not-yet-started
    // daemon, somewhere in runcmd.
    const cfg = loadCloudConfig();
    const runcmd = (cfg.runcmd ?? []).map((entry) =>
      Array.isArray(entry) ? entry.join(' ') : String(entry),
    );
    const appliesConfig = runcmd.some(
      (line) =>
        /systemctl.*restart.*docker/.test(line) || /systemctl.*enable.*--now.*docker/.test(line),
    );
    expect(
      appliesConfig,
      'runcmd must restart docker (or enable --now) so /etc/docker/daemon.json takes effect',
    ).toBe(true);
  });
});
