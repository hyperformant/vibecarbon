import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeRunningServices,
  parseComposePs,
  publishedPorts,
} from '../../../../src/lib/status/compose-ps.js';

/** Records the args it was called with and returns the given stdout. */
function fakeExecFile(stdout: string) {
  const calls: Array<[string, string[], Record<string, unknown>]> = [];
  const fn = (cmd: string, args: string[], options: Record<string, unknown>) => {
    calls.push([cmd, args, options]);
    return stdout;
  };
  return { fn, calls };
}

describe('composeRunningServices', () => {
  it('parses a JSON-array shape (older Compose v2), keeping only running services', () => {
    const stdout = JSON.stringify([
      { Service: 'web', State: 'running' },
      { Service: 'worker', State: 'exited' },
    ]);
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: ['web'] });
  });

  it('parses NDJSON shape (Compose v2.21+), keeping only running services', () => {
    const stdout = [
      JSON.stringify({ Service: 'web', State: 'running' }),
      JSON.stringify({ Service: 'worker', State: 'exited' }),
    ].join('\n');
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: ['web'] });
  });

  it('falls back to Name when Service is absent', () => {
    const stdout = JSON.stringify({ Name: 'proj-web-1', State: 'running' });
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: ['proj-web-1'] });
  });

  it('treats empty output as available with no running services', () => {
    const { fn } = fakeExecFile('');
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: [] });
  });

  it('treats output that is only whitespace as empty', () => {
    const { fn } = fakeExecFile('  \n  ');
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: [] });
  });

  it('reports unavailable when execFile throws (docker missing, daemon down, timeout)', () => {
    const fn = () => {
      throw new Error('spawn docker ENOENT');
    };
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: false, running: [] });
  });

  it('skips a malformed line among valid NDJSON lines', () => {
    const stdout = [
      JSON.stringify({ Service: 'web', State: 'running' }),
      'not json at all',
      JSON.stringify({ Service: 'db', State: 'running' }),
    ].join('\n');
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: ['web', 'db'] });
  });

  it('preserves listing order', () => {
    const stdout = [
      JSON.stringify({ Service: 'db', State: 'running' }),
      JSON.stringify({ Service: 'web', State: 'running' }),
    ].join('\n');
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result.running).toEqual(['db', 'web']);
  });

  it('calls execFile with the exact docker compose ps command, cwd, timeout and stdio', () => {
    const { fn, calls } = fakeExecFile('');
    composeRunningServices('/my/project', { execFile: fn });
    expect(calls).toHaveLength(1);
    const [cmd, args, options] = calls[0];
    expect(cmd).toBe('docker');
    expect(args).toEqual(['compose', 'ps', '--format', 'json']);
    expect(options).toMatchObject({
      cwd: '/my/project',
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('lets timeoutMs override the timeout passed to execFile', () => {
    const { fn, calls } = fakeExecFile('');
    composeRunningServices('/my/project', { execFile: fn, timeoutMs: 1500 });
    expect(calls[0][2]).toMatchObject({ timeout: 1500 });
  });

  it('reports unavailable when the array-shape output is truncated (invalid JSON)', () => {
    const { fn } = fakeExecFile('[{"Service":"db","State":"running"}');
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: false, running: [] });
  });

  it('drops a running row that has neither Service nor Name', () => {
    const stdout = [
      JSON.stringify({ State: 'running' }),
      JSON.stringify({ Service: 'web', State: 'running' }),
    ].join('\n');
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: ['web'] });
  });

  it('skips a null NDJSON line and keeps the valid running service', () => {
    const stdout = ['null', JSON.stringify({ Service: 'web', State: 'running' })].join('\n');
    const { fn } = fakeExecFile(stdout);
    const result = composeRunningServices('/proj', { execFile: fn });
    expect(result).toEqual({ available: true, running: ['web'] });
  });
});

// What real Compose binaries printed against a stub daemon holding two
// containers (2026-11-05): 2.20.3 prints one array, 2.21.0 one object per line.
const publishers = (port: number) => [
  { URL: '0.0.0.0', TargetPort: 80, PublishedPort: port, Protocol: 'tcp' },
];
const row = (service: string, port: number) => ({
  Name: `vctest-floors-${service}-1`,
  Service: service,
  State: 'running',
  Publishers: publishers(port),
});
const ARRAY_SHAPE = JSON.stringify([row('a', 8081), row('b', 8082)]);
const LINES_SHAPE = `${JSON.stringify(row('a', 8081))}\n${JSON.stringify(row('b', 8082))}\n`;

describe('parseComposePs: both shapes of `compose ps --format json`', () => {
  it.each([
    ['the array from Compose before 2.21', ARRAY_SHAPE],
    ['the JSON Lines from 2.21 on', LINES_SHAPE],
  ])('reads %s', (_name, output) => {
    expect(parseComposePs(output)?.map((e) => e.Service)).toEqual(['a', 'b']);
  });

  it.each([
    ['no output', ''],
    ['an empty array', '[]'],
    ['blank lines', '\n\n'],
    ['nothing at all', undefined],
  ])('%s means no containers', (_name, output) => {
    expect(parseComposePs(output as string)).toEqual([]);
  });

  it('a broken array is unreadable, not empty', () => {
    expect(parseComposePs('[{"Service":"a"')).toBeNull();
  });

  it('skips a stray line and anything that is not an object', () => {
    expect(parseComposePs('warning: something\n{"Service":"a"}\nnull\n7\n')).toEqual([
      { Service: 'a' },
    ]);
  });

  it('`up` reads the published ports from either shape', () => {
    expect([...publishedPorts(parseComposePs(ARRAY_SHAPE))]).toEqual([8081, 8082]);
    expect([...publishedPorts(parseComposePs(LINES_SHAPE))]).toEqual([8081, 8082]);
    expect([...publishedPorts(null)]).toEqual([]);
  });
});

describe('every `compose ps --format json` caller shares the one parser', () => {
  it.each(['src/up.js', 'src/upgrade.js', 'src/lib/status/compose-ps.js'])('%s', (file) => {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    expect(text).toContain("'compose', 'ps', '--format', 'json'");
    expect(text).toContain('parseComposePs(');
  });
});
