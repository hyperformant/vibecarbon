/**
 * Minimal Docker Engine API client for the admin Infrastructure pages.
 *
 * The server never shells out to the docker CLI for container discovery or
 * logs: the production app image ships no CLI, no compose files, and no
 * socket — only the read-only docker-socket-proxy is reachable over TCP
 * (docker-compose.prod.yml sets DOCKER_API_PROXY and grants CONTAINERS-only
 * GET access). In local dev the host's /var/run/docker.sock is used
 * directly. This mirrors the Kubernetes branch of the services-status
 * routes, which talks to the K8s API over HTTPS instead of exec'ing kubectl.
 */

import { existsSync } from 'node:fs';
import http from 'node:http';

const SOCKET_PATH = '/var/run/docker.sock';

interface DockerTarget {
  socketPath?: string;
  host?: string;
  port?: number;
}

/**
 * Where to reach the Docker Engine API, or null if nowhere.
 * DOCKER_API_PROXY (e.g. "http://docker-socket-proxy:2375") wins over the
 * local socket so a containerized deploy never depends on a socket mount.
 */
export function dockerApiTarget(): DockerTarget | null {
  const proxy = process.env.DOCKER_API_PROXY;
  if (proxy) {
    try {
      const url = new URL(proxy);
      return { host: url.hostname, port: Number(url.port) || 2375 };
    } catch {
      return null;
    }
  }
  if (existsSync(SOCKET_PATH)) return { socketPath: SOCKET_PATH };
  return null;
}

function dockerApiRequest(path: string, timeoutMs = 30000): Promise<Buffer> {
  const target = dockerApiTarget();
  if (!target) return Promise.reject(new Error('Docker API not reachable'));

  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 500) >= 400) {
          reject(
            new Error(`Docker API ${path} → ${res.statusCode}: ${body.toString().slice(0, 200)}`)
          );
        } else {
          resolve(body);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    req.end();
  });
}

export interface DockerContainer {
  id: string;
  name: string;
  service: string;
}

interface ContainerListEntry {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

/**
 * Map a /containers/json response to this project's containers. Containers
 * are matched by the `${PROJECT_NAME}-` name prefix (every service sets
 * container_name that way), which also keeps `my-app` from claiming
 * `my-app2-db`. The compose service label is authoritative for the service
 * name; the name-minus-prefix fallback covers containers started without
 * compose labels.
 */
export function mapContainerList(
  entries: ContainerListEntry[],
  project: string
): DockerContainer[] {
  return entries
    .map((entry) => {
      const name = (entry.Names?.[0] ?? '').replace(/^\//, '');
      const service =
        entry.Labels?.['com.docker.compose.service'] ?? name.slice(project.length + 1);
      return { id: entry.Id, name, service };
    })
    .filter((container) => container.name.startsWith(`${project}-`));
}

/** Running containers belonging to the given compose project. */
export async function listProjectContainers(project: string): Promise<DockerContainer[]> {
  const filters = encodeURIComponent(JSON.stringify({ name: [`${project}-`] }));
  const body = await dockerApiRequest(`/containers/json?filters=${filters}`);
  return mapContainerList(JSON.parse(body.toString('utf-8')), project);
}

/**
 * Strip the multiplexed-stream framing the Engine API uses for non-TTY
 * containers: frames of [type(1) 0x00 0x00 0x00 size(4, BE)] + payload.
 * TTY containers return the raw byte stream instead — detected by the first
 * frame header not matching (log text starts with a printable byte).
 */
export function demuxDockerLogs(buf: Buffer): string {
  if (buf.length === 0) return '';
  const type = buf[0];
  if ((type !== 0 && type !== 1 && type !== 2) || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
    return buf.toString('utf-8');
  }
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    parts.push(buf.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString('utf-8');
}

/** Timestamped log lines for one container. */
export async function fetchContainerLogs(
  id: string,
  opts: { tail: number; sinceSeconds: number }
): Promise<string[]> {
  const qs = new URLSearchParams({
    stdout: '1',
    stderr: '1',
    timestamps: '1',
    tail: String(opts.tail),
    since: String(Math.floor(Date.now() / 1000) - opts.sinceSeconds),
  });
  const raw = await dockerApiRequest(`/containers/${id}/logs?${qs}`);
  return demuxDockerLogs(raw)
    .split('\n')
    .filter((line) => line.trim());
}
