/**
 * The deploy log must hold everything written before a `process.exit()`.
 *
 * RCA (excitingai, 2026-10-16): two v0.49.0 deploys' logs end mid-spinner at
 * "Creating S3 bucket" with no failure line, about one second after the
 * spinner started. The step's catch prints `S3 setup failed: …` and calls
 * `process.exit(1)`; the tee wrote through an async `fs.WriteStream`, and
 * `process.exit` drops whatever that stream has not flushed yet. A failure
 * that exits therefore looked exactly like a hang in the one artifact the
 * operator sends us. The log is now written synchronously.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const LOGGER = resolve('src/lib/deploy-logger.js');
let home: string;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('withDeployLog', () => {
  it('keeps the last line written before process.exit()', () => {
    home = mkdtempSync(join(tmpdir(), 'vc-deploylog-'));
    const script = `
      const { withDeployLog } = await import(${JSON.stringify(LOGGER)});
      await withDeployLog('prod', async () => {
        for (let i = 0; i < 200; i++) process.stdout.write('frame ' + i + '\\n');
        process.stdout.write('S3 setup failed: the last line\\n');
        process.exit(1);
      });
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    const logsDir = join(home, '.vibecarbon', 'logs');
    const [file] = readdirSync(logsDir);
    const text = readFileSync(join(logsDir, file), 'utf8');
    expect(text).toContain('frame 199');
    expect(text).toContain('S3 setup failed: the last line');
  });
});
