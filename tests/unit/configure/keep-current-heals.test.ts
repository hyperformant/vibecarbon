/**
 * Final review H1 (2026-09-21): `configure` must heal a pre-2026-09-20
 * `.env.local` BEFORE it reads the current values, or "press Enter to keep
 * current" hands the truncated read back to `setEnvVar`, which writes it over
 * the recoverable `'pa'\''ss'` line — the `'` half of the secret is gone.
 *
 * Drives the REAL smtp feature (resend preset) end to end with @clack mocked:
 * overwrite=yes, Enter on the password, fixture values for the rest. Real
 * project.js, real dotenv module, real files in a temp dir. Fixture values only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: vi.fn(() => ({ projectName: 'test-project' })),
}));
vi.mock('../../../src/lib/config.js', () => ({
  loadProjectConfig: vi.fn(() => null),
  saveProjectConfig: vi.fn(),
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: vi.fn() }));
vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

import * as configure from '../../../src/configure.js';

const LEGACY_LOCAL = "SMTP_HOST=smtp.resend.com\nSMTP_PASS='pa'\\''ss'\n";

describe('configure keep-current on a legacy-quoted .env.local', () => {
  let cwd: string;
  let previousCwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vc-keep-current-'));
    writeFileSync(join(cwd, '.env'), 'SMTP_HOST=smtp.resend.com\n');
    writeFileSync(join(cwd, '.env.local'), LEGACY_LOCAL);
    previousCwd = process.cwd();
    process.chdir(cwd);
    clackMock.confirm.mockReset().mockResolvedValue(true); // overwrite the configured feature
    clackMock.password.mockReset().mockResolvedValue(''); // Enter: keep the current password
    clackMock.text.mockReset();
    clackMock.text.mockResolvedValueOnce('admin@example.com').mockResolvedValueOnce('Acme');
    clackMock.log.info.mockReset();
  });
  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('Enter on the existing password writes the decoded value back, not the truncated read', async () => {
    await configure.run(['email', 'resend']);

    const local = readFileSync(join(cwd, '.env.local'), 'utf-8');
    expect(parseDotenv(local).SMTP_PASS).toBe("pa'ss");
    expect(local).toContain('SMTP_PASS="pa\'ss"');
    expect(local).not.toContain("'\\''");
    // The non-localOnly write lands in .env too, decoded.
    expect(parseDotenv(readFileSync(join(cwd, '.env'), 'utf-8')).SMTP_PASS).toBe("pa'ss");
    // The prompt itself was offered the decoded value (the "keep current" branch).
    expect(clackMock.password.mock.calls[0][0].message).toContain('keep current');
  });

  it('tells the operator which keys were re-encoded, by name only', async () => {
    await configure.run(['email', 'resend']);
    const lines = clackMock.log.info.mock.calls.map((c) => String(c[0]));
    const healLine = lines.find((l) => l.startsWith('Re-encoded '));
    expect(healLine).toBe('Re-encoded 1 legacy-quoted value in .env/.env.local: SMTP_PASS');
    expect(lines.join('\n')).not.toContain("pa'ss");
  });
});
