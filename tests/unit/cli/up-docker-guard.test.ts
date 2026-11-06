import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertComposeFloor, assertDockerRunning } from '../../../src/up.js';

describe('assertDockerRunning', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits with code 1 when Docker is not reachable', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    assertDockerRunning({ probe: () => false });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does nothing when Docker is reachable', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    assertDockerRunning({ probe: () => true });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('assertComposeFloor: vibecarbon up checks the local Compose first', () => {
  afterEach(() => vi.restoreAllMocks());

  const silence = () => ({
    exit: vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never),
    error: vi.spyOn(p.log, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(p.log, 'warn').mockImplementation(() => {}),
  });

  it('refuses a Compose under the floor, saying what to do', () => {
    const { exit, error } = silence();
    assertComposeFloor({ read: () => '2.24.3\n' });
    expect(exit).toHaveBeenCalledWith(1);
    const text = String(error.mock.calls[0][0]);
    expect(text).toContain('Docker Compose 2.24.3 is too old');
    expect(text).toContain('2.24.4 or newer');
    expect(text).toContain('vibecarbon up');
  });

  it.each(['2.24.4', '5.6.1', 'v2.29.1-desktop.1'])('%s passes', (version) => {
    const { exit, warn } = silence();
    assertComposeFloor({ read: () => version });
    expect(exit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([[null], [''], ['podman-compose version 1.0.6']])(
    'a version it cannot read (%s) warns and carries on',
    (raw) => {
      const { exit, warn } = silence();
      assertComposeFloor({ read: () => raw });
      expect(exit).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(/Could not read the Docker Compose version/);
    },
  );

  it('runs before anything else reaches docker compose', () => {
    const text = readFileSync(join(process.cwd(), 'src/up.js'), 'utf8');
    const run = text.slice(text.indexOf('export async function run('));
    expect(run.indexOf('assertComposeFloor()')).toBeGreaterThan(
      run.indexOf('assertDockerRunning()'),
    );
    expect(run.indexOf('assertComposeFloor()')).toBeLessThan(
      run.indexOf('resolveComposeProjectName('),
    );
  });
});
