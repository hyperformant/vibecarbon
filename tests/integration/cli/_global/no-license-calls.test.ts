import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { destroyRealProject, realProject, runCliAsync } from '../../_harness/index.js';

// Deploying Kubernetes or an HA mode asks for nothing: no key, no activation,
// no call to a license API. The CLI runs against a real HTTP server standing
// in for vibecarbon.com, and the test reads what that server was asked.
//
// Provider credentials are blanked in every child. The deploy is expected to
// stop at the first missing credential (`-y` cannot prompt for one), and a
// developer's live token must not be able to carry it into provisioning.
const SCRUBBED = [
  'HETZNER_API_TOKEN',
  'HCLOUD_TOKEN',
  'HETZNER_ACCESS_KEY',
  'HETZNER_SECRET_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'CLOUDFLARE_API_TOKEN',
  'DIGITALOCEAN_TOKEN',
  'LINODE_TOKEN',
  'VULTR_API_KEY',
  'SCW_ACCESS_KEY',
  'SCW_SECRET_KEY',
  'SCW_DEFAULT_PROJECT_ID',
  'PULUMI_ACCESS_TOKEN',
  'SSH_AUTH_SOCK',
];

describe('deploy never asks for a license', () => {
  let server: Server;
  let apiBase: string;
  let requested: string[] = [];
  let project: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requested.push(`${req.method} ${req.url}`);
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  beforeEach(() => {
    requested = [];
    project = realProject({ envs: ['prod'] });
  });

  afterEach(() => {
    destroyRealProject(project);
  });

  it.each(['k8s', 'k8s-ha', 'compose-ha'])(
    '-mode %s gets past mode resolution with no key and no license call',
    async (mode) => {
      const r = await runCliAsync('deploy', ['prod', '-provider', 'hetzner', '-mode', mode, '-y'], {
        cwd: project,
        apiBase,
        timeoutMs: 30_000,
        env: Object.fromEntries(SCRUBBED.map((name) => [name, ''])),
      });
      const output = `${r.stdout}\n${r.stderr}`;

      // It stopped for a missing credential, which is only reachable after
      // the mode was resolved. A license refusal would have stopped it first.
      expect(r.exitCode, output).not.toBe(0);
      expect(output).not.toMatch(/license|subscription|activate|Graphene|Fullerene/i);
      expect(output, 'expected to reach the credential step').toContain(
        'Cannot prompt for the Hetzner API token',
      );

      // Telemetry may call this server; nothing may ask about a license.
      expect(requested.filter((line) => line.includes('/license'))).toEqual([]);
    },
  );
});
