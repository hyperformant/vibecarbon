/**
 * Compose leg of the dotenv oracle (spec 2026-09-20-dotenv-dialect-design.md,
 * "Enumerable invariants" 2). The same synthetic fixture the unit oracle runs
 * through Node, dotenv and dotenv-expand is written to a temp `.env` with
 * `formatDotenvLine` and read back by Docker Compose, the parser the deployed
 * server actually uses for `env_file:`. Every value must come back
 * byte-identical: a mismatch on any key is a hole in the writer's grammar,
 * not a value to drop.
 *
 * Two readings of the same file:
 *   1. `docker compose config --format json` — resolves the model without
 *      pulling anything. Its output is itself a Compose file, so the renderer
 *      escapes every literal `$` as `$$` (a bare `$` in that output would be
 *      re-interpolated on the next read). The test asserts that convention
 *      explicitly rather than normalising blindly: the raw output must
 *      contain no unpaired `$`, and un-escaping `$$` must give the source.
 *   2. `docker compose run` — the ground truth: the environment a container
 *      started from this file actually sees, printed NUL-delimited so the
 *      newline-bearing values survive. Needs the pinned busybox image (a
 *      few MB; this tier already pulls the whole Supabase stack).
 *
 * `network_mode: none` keeps `run` from creating a project network, so a host
 * whose address pools are exhausted (the smoke tests' failure mode) cannot
 * fail this oracle for an unrelated reason.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { ORACLE_VALUES } from '../../fixtures/dotenv-oracle-values.js';

// Skipped by default like the other docker tests; run explicitly via
// `DOCKER_INTEGRATION=true pnpm test:docker` (the script sets the variable).
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const IMAGE = 'busybox:1.36';
const KEYS = Object.keys(ORACLE_VALUES);

describeDocker('dotenv oracle: docker compose reads the writer identically', () => {
  let dir: string;
  // stderr is inherited so a failure (pull refused, daemon down) shows
  // docker's own reason in the vitest log instead of a bare "Command failed".
  const compose = (args: string[], timeout: number) =>
    execFileSync('docker', ['compose', '-f', 'compose.yml', ...args], {
      cwd: dir,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'compose-oracle-'));
    const text = `${KEYS.map((k) => formatDotenvLine(k, ORACLE_VALUES[k])).join('\n')}\n`;
    writeFileSync(join(dir, '.env'), text);
    writeFileSync(
      join(dir, 'compose.yml'),
      `services:\n  probe:\n    image: ${IMAGE}\n    network_mode: none\n    env_file:\n      - .env\n`,
    );
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("config: env_file values equal the source values once the renderer's $$ escape is undone", () => {
    const out = compose(['config', '--format', 'json'], 60_000);
    const env = JSON.parse(out).services.probe.environment as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      const rendered = env[key];
      // The renderer's convention, asserted: every `$` it prints is doubled.
      expect(rendered.replace(/\$\$/g, ''), `${key}: unpaired $ in config output`).not.toContain(
        '$',
      );
      const read = rendered.replace(/\$\$/g, '$');
      expect(read, `${key}: compose read ${JSON.stringify(read)}`).toBe(ORACLE_VALUES[key]);
    }
  });

  it('run: the container sees every source value byte for byte', () => {
    // printf reuses its format for each argument: one NUL-terminated string
    // per key, in KEYS order, empty values included.
    const script = `printf '%s\\0' ${KEYS.map((k) => `"$${k}"`).join(' ')}`;
    const out = compose(
      ['run', '--rm', '-T', '--no-deps', '--quiet-pull', 'probe', 'sh', '-c', script],
      180_000,
    );
    const parts = out.split('\0');
    expect(parts.pop(), 'trailing bytes after the last NUL').toBe('');
    expect(parts.length).toBe(KEYS.length);
    for (const [i, key] of KEYS.entries()) {
      expect(parts[i], `${key}: container saw ${JSON.stringify(parts[i])}`).toBe(
        ORACLE_VALUES[key],
      );
    }
  });
});
