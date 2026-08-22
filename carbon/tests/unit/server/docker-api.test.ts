import { afterEach, describe, expect, it, vi } from 'vitest';
import { demuxDockerLogs, dockerApiTarget, mapContainerList } from '@server/lib/docker-api';

// The admin Infrastructure pages fetch container lists and logs through the
// Docker Engine API — never the docker CLI, which the production app image
// doesn't ship (regression: /admin/logs failed with a bare "Command failed:
// docker compose logs …" on every compose deploy).

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dockerApiTarget', () => {
  it('prefers DOCKER_API_PROXY over the local socket', () => {
    vi.stubEnv('DOCKER_API_PROXY', 'http://docker-socket-proxy:2375');
    expect(dockerApiTarget()).toEqual({ host: 'docker-socket-proxy', port: 2375 });
  });

  it('defaults the proxy port to 2375', () => {
    vi.stubEnv('DOCKER_API_PROXY', 'http://docker-socket-proxy');
    expect(dockerApiTarget()).toEqual({ host: 'docker-socket-proxy', port: 2375 });
  });

  it('returns null for a malformed proxy URL instead of throwing', () => {
    vi.stubEnv('DOCKER_API_PROXY', 'not a url');
    expect(dockerApiTarget()).toBeNull();
  });
});

describe('mapContainerList', () => {
  const entries = [
    {
      Id: 'aaa',
      Names: ['/my-app-db'],
      Labels: { 'com.docker.compose.service': 'db' },
    },
    {
      Id: 'bbb',
      Names: ['/my-app-kong'],
      Labels: { 'com.docker.compose.service': 'kong' },
    },
    // The docker `name` filter matches substrings, so a sibling project with
    // a shared prefix leaks through the API query — the exact-prefix filter
    // here must drop it.
    {
      Id: 'ccc',
      Names: ['/my-app2-db'],
      Labels: { 'com.docker.compose.service': 'db' },
    },
    // No compose labels: service falls back to name minus the project prefix.
    { Id: 'ddd', Names: ['/my-app-imgproxy'], Labels: {} },
  ];

  it('keeps only exact-prefix matches and resolves service names', () => {
    expect(mapContainerList(entries, 'my-app')).toEqual([
      { id: 'aaa', name: 'my-app-db', service: 'db' },
      { id: 'bbb', name: 'my-app-kong', service: 'kong' },
      { id: 'ddd', name: 'my-app-imgproxy', service: 'imgproxy' },
    ]);
  });

  it('handles dashed project names (the old CLI parser stripped only the first segment)', () => {
    const dashed = [
      { Id: 'eee', Names: ['/my-app-db'], Labels: { 'com.docker.compose.service': 'db' } },
    ];
    expect(mapContainerList(dashed, 'my-app')[0].service).toBe('db');
  });
});

function frame(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('demuxDockerLogs', () => {
  it('reassembles multiplexed stdout/stderr frames in order', () => {
    const buf = Buffer.concat([
      frame(1, '2026-07-17T10:00:00Z hello\n'),
      frame(2, '2026-07-17T10:00:01Z oops\n'),
      frame(1, '2026-07-17T10:00:02Z world\n'),
    ]);
    expect(demuxDockerLogs(buf)).toBe(
      '2026-07-17T10:00:00Z hello\n2026-07-17T10:00:01Z oops\n2026-07-17T10:00:02Z world\n'
    );
  });

  it('passes through raw (TTY) streams untouched', () => {
    const raw = Buffer.from('2026-07-17T10:00:00Z plain tty line\n', 'utf-8');
    expect(demuxDockerLogs(raw)).toBe('2026-07-17T10:00:00Z plain tty line\n');
  });

  it('returns empty string for an empty body', () => {
    expect(demuxDockerLogs(Buffer.alloc(0))).toBe('');
  });

  it('tolerates a truncated final frame', () => {
    const truncated = Buffer.concat([frame(1, 'complete\n'), frame(1, 'partial')]).subarray(0, 20);
    expect(demuxDockerLogs(truncated)).toContain('complete\n');
  });
});
