/**
 * Shared spy helper: run `fn` and prove no private key material reached any
 * operator-visible sink. Used by every TLS restore test (compose deploy,
 * compose-ha failover, scale, k8s, k8s-ha promotion).
 *
 * Sinks captured: every `p.log.*` method of @clack/prompts, `console.*`,
 * `process.stdout.write` and `process.stderr.write`. `progressLog` is covered
 * through them: outside an animated TTY spinner (always the case under
 * vitest) it writes with console.error, and an animated spinner's message
 * line is drawn with process.stdout.write.
 *
 * The forbidden strings are `BEGIN`, `PRIVATE KEY`, and, for every private
 * key in the fixture (a Traefik acme.json `key` field or a Secret's
 * `tls.key`), its base64 text and the first line of its PEM body.
 */
import * as p from '@clack/prompts';
import { expect, vi } from 'vitest';

const LOG_METHODS = ['info', 'warn', 'warning', 'error', 'success', 'message', 'step'] as const;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Every private key in an acme.json or Secret JSON fixture, as base64 text. */
function keyFields(fixture: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'key' || k === 'tls.key') && typeof v === 'string' && v) out.push(v);
      else walk(v);
    }
  };
  walk(JSON.parse(fixture));
  return out;
}

/** The strings that must never appear in operator output for this fixture. */
export function forbiddenStrings(fixture: string): string[] {
  const forbidden = ['BEGIN', 'PRIVATE KEY'];
  for (const b64 of keyFields(fixture)) {
    forbidden.push(b64);
    const pemBody = Buffer.from(b64, 'base64')
      .toString('utf8')
      .split('\n')
      .find((line) => line && !line.startsWith('-----'));
    if (pemBody) forbidden.push(pemBody);
  }
  return forbidden;
}

/**
 * Run `fn` with every sink captured, assert none of the captured strings
 * carries key material, and return fn's result plus what was captured (so a
 * test can also prove the capture saw the expected info line).
 */
export async function expectNoKeyLeak<T>(
  fixture: string,
  fn: () => Promise<T>,
): Promise<{ result: T; captured: string[] }> {
  const forbidden = forbiddenStrings(fixture);
  expect(forbidden.length, 'fixture has no private key to look for').toBeGreaterThan(2);
  const captured: string[] = [];
  const record = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  const spies: Array<{ mockRestore: () => void }> = [];
  const log = p.log as unknown as Record<string, (...a: unknown[]) => void>;
  for (const m of LOG_METHODS) {
    if (typeof log[m] === 'function') spies.push(vi.spyOn(log, m).mockImplementation(record));
  }
  const con = console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const m of CONSOLE_METHODS) spies.push(vi.spyOn(con, m).mockImplementation(record));
  const write = (chunk: unknown) => {
    record(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  spies.push(vi.spyOn(process.stdout, 'write').mockImplementation(write as never));
  spies.push(vi.spyOn(process.stderr, 'write').mockImplementation(write as never));
  let result: T;
  try {
    result = await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  for (const line of captured) {
    for (const bad of forbidden) {
      expect(line.includes(bad), 'key material reached operator output').toBe(false);
    }
  }
  return { result, captured };
}
