/**
 * Tests for src/autoscaler/config.js — carbon-autoscaler config contract.
 *
 * Config is the JSON document the deploy pipeline mounts from the
 * `carbon-autoscaler-config` k8s Secret (key `config.json`). loadConfig()
 * must validate the WHOLE document up front and throw one Error naming
 * every problem (not just the first) — a single typo in a multi-nodeGroup
 * config shouldn't require a fix-rerun-fix-rerun loop to discover all
 * the mistakes.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { ConfigWatcher, loadConfig } from '../../../src/autoscaler/config.js';

function validConfig() {
  return {
    provider: 'testprov',
    providerIdPrefix: 'testprov://',
    clusterName: 'acme-prod',
    nodeGroups: {
      'worker-pool': {
        minSize: 0,
        maxSize: 4,
        serverType: 'cx23',
        region: 'nbg1',
        image: 'ubuntu-24.04',
        cloudInit: '#cloud-config\nruncmd: []\n',
        serverLabels: {
          'cluster-autoscaler/node': 'worker-pool',
          'managed-by': 'vibecarbon',
          environment: 'prod',
          cluster: 'acme-prod',
        },
        nodeLabels: {},
        taints: [],
        podsPerNode: 110,
      },
    },
    sshKeyName: 'acme-prod-nbg1-key',
    firewallName: 'acme-prod-firewall',
    networkName: 'acme-prod-network',
  };
}

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-autoscaler-config-test-'));
  configPath = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(config: unknown) {
  writeFileSync(configPath, JSON.stringify(config));
}

describe('loadConfig — valid document', () => {
  it('parses a valid fixture and round-trips its fields', () => {
    write(validConfig());
    const config = loadConfig(configPath);
    expect(config.provider).toBe('testprov');
    expect(config.providerIdPrefix).toBe('testprov://');
    expect(config.clusterName).toBe('acme-prod');
    expect(config.sshKeyName).toBe('acme-prod-nbg1-key');
    expect(config.firewallName).toBe('acme-prod-firewall');
    expect(config.networkName).toBe('acme-prod-network');
    expect(config.nodeGroups['worker-pool'].maxSize).toBe(4);
    expect(config.nodeGroups['worker-pool'].serverType).toBe('cx23');
    expect(config.nodeGroups['worker-pool'].podsPerNode).toBe(110);
    expect(config.nodeGroups['worker-pool'].serverLabels['cluster-autoscaler/node']).toBe(
      'worker-pool',
    );
  });

  it('tolerates unknown top-level keys (forward-compat)', () => {
    write({ ...validConfig(), someFutureField: 'ignored' });
    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('tolerates unknown per-group keys (forward-compat)', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].someFutureGroupField = 'ignored';
    write(config);
    expect(() => loadConfig(configPath)).not.toThrow();
  });
});

describe('loadConfig — top-level field validation', () => {
  it.each([
    'provider',
    'providerIdPrefix',
    'clusterName',
    'sshKeyName',
    'firewallName',
    'networkName',
  ])('throws naming "%s" when missing', (field) => {
    const config = validConfig();
    delete config[field];
    write(config);
    expect(() => loadConfig(configPath)).toThrow(new RegExp(field));
  });

  it.each([
    'provider',
    'providerIdPrefix',
    'clusterName',
    'sshKeyName',
    'firewallName',
    'networkName',
  ])('throws naming "%s" when empty string', (field) => {
    const config = validConfig();
    config[field] = '';
    write(config);
    expect(() => loadConfig(configPath)).toThrow(new RegExp(field));
  });

  it('throws naming "nodeGroups" when missing', () => {
    const config = validConfig();
    delete config.nodeGroups;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/nodeGroups/);
  });

  it('throws naming "nodeGroups" when empty object', () => {
    const config = validConfig();
    config.nodeGroups = {};
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/nodeGroups/);
  });
});

describe('loadConfig — per-group field validation', () => {
  it('throws the exact "static floor + CA-on-top" message when minSize is not 0', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].minSize = 1;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/static floor \+ CA-on-top: minSize must be 0/);
  });

  it('throws naming "minSize" and the group name when minSize is not 0', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].minSize = 1;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/worker-pool.*minSize|minSize.*worker-pool/s);
  });

  it('throws naming "maxSize" when negative', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].maxSize = -1;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/worker-pool.*maxSize|maxSize.*worker-pool/s);
  });

  it('throws naming "maxSize" when not an integer', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].maxSize = 2.5;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/maxSize/);
  });

  it.each(['serverType', 'region', 'image', 'cloudInit'])(
    'throws naming "%s" when missing',
    (field) => {
      const config = validConfig();
      delete config.nodeGroups['worker-pool'][field];
      write(config);
      expect(() => loadConfig(configPath)).toThrow(new RegExp(field));
    },
  );

  it.each(['serverType', 'region', 'image', 'cloudInit'])(
    'throws naming "%s" when empty string',
    (field) => {
      const config = validConfig();
      config.nodeGroups['worker-pool'][field] = '';
      write(config);
      expect(() => loadConfig(configPath)).toThrow(new RegExp(field));
    },
  );

  it('throws naming "serverLabels" when missing', () => {
    const config = validConfig();
    delete config.nodeGroups['worker-pool'].serverLabels;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/serverLabels/);
  });

  it('throws naming "serverLabels" when missing the "cluster-autoscaler/node" key', () => {
    const config = validConfig();
    delete config.nodeGroups['worker-pool'].serverLabels['cluster-autoscaler/node'];
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/serverLabels/);
    expect(() => loadConfig(configPath)).toThrow(/cluster-autoscaler\/node/);
  });

  it('throws when "cluster-autoscaler/node" label does not equal the group name', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].serverLabels['cluster-autoscaler/node'] = 'wrong-name';
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/cluster-autoscaler\/node/);
  });

  it('throws naming "nodeLabels" when not an object', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].nodeLabels = 'nope';
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/nodeLabels/);
  });

  it('accepts an empty "nodeLabels" object', () => {
    write(validConfig());
    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('throws naming "taints" when not an array', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].taints = 'nope';
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/taints/);
  });

  it('throws naming "podsPerNode" when missing', () => {
    const config = validConfig();
    delete config.nodeGroups['worker-pool'].podsPerNode;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/podsPerNode/);
  });

  it('throws naming "podsPerNode" when zero or negative', () => {
    const config = validConfig();
    config.nodeGroups['worker-pool'].podsPerNode = 0;
    write(config);
    expect(() => loadConfig(configPath)).toThrow(/podsPerNode/);
  });
});

describe('loadConfig — multi-error aggregation', () => {
  it('lists every problem in a single throw, not just the first', () => {
    const config = validConfig();
    delete config.provider;
    delete config.clusterName;
    config.nodeGroups['worker-pool'].minSize = 1;
    config.nodeGroups['worker-pool'].maxSize = -1;
    write(config);

    let caught: Error | undefined;
    try {
      loadConfig(configPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const message = caught?.message;
    expect(message).toMatch(/provider/);
    expect(message).toMatch(/clusterName/);
    expect(message).toMatch(/minSize/);
    expect(message).toMatch(/maxSize/);
  });
});

describe('loadConfig — malformed JSON', () => {
  it('throws a descriptive error, not a raw JSON.parse crash', () => {
    writeFileSync(configPath, '{ this is not json');
    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('ConfigWatcher', () => {
  it('currentSync() returns the config loaded at construction', () => {
    write(validConfig());
    const watcher = new ConfigWatcher(configPath);
    expect(watcher.currentSync().clusterName).toBe('acme-prod');
  });

  it('reloadIfChanged() reports changed:false when the mtime has not moved', async () => {
    write(validConfig());
    const watcher = new ConfigWatcher(configPath);
    const result = await watcher.reloadIfChanged();
    expect(result.changed).toBe(false);
  });

  it('reloadIfChanged() reports changed:true with the new config after a rewrite', async () => {
    write(validConfig());
    const watcher = new ConfigWatcher(configPath);
    const before = await watcher.reloadIfChanged();
    expect(before.changed).toBe(false);

    const updated = validConfig();
    updated.clusterName = 'acme-staging';
    write(updated);
    // Force a distinct mtime — same-second rewrites can otherwise collide
    // on filesystems with coarse mtime resolution.
    const future = new Date(Date.now() + 5000);
    utimesSync(configPath, future, future);

    const after = await watcher.reloadIfChanged();
    expect(after.changed).toBe(true);
    expect(after.config.clusterName).toBe('acme-staging');
    expect(watcher.currentSync().clusterName).toBe('acme-staging');
  });

  it('malformed JSON on reload throws, but currentSync() still returns the previous good config', async () => {
    write(validConfig());
    const watcher = new ConfigWatcher(configPath);
    expect(watcher.currentSync().clusterName).toBe('acme-prod');

    writeFileSync(configPath, '{ not valid json');
    const future = new Date(Date.now() + 5000);
    utimesSync(configPath, future, future);

    await expect(watcher.reloadIfChanged()).rejects.toThrow();
    expect(watcher.currentSync().clusterName).toBe('acme-prod');
  });

  it('an invalid config on reload throws, but currentSync() still returns the previous good config', async () => {
    write(validConfig());
    const watcher = new ConfigWatcher(configPath);

    const broken = validConfig();
    broken.nodeGroups['worker-pool'].minSize = 1;
    write(broken);
    const future = new Date(Date.now() + 5000);
    utimesSync(configPath, future, future);

    await expect(watcher.reloadIfChanged()).rejects.toThrow(/minSize/);
    expect(watcher.currentSync().clusterName).toBe('acme-prod');
  });
});
