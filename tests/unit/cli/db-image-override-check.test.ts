import * as p from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asksHelpOrVersion, checkDbImageOverride } from '../../../src/cli.js';
import { resolveDbImage, setDbImageWarningSink } from '../../../src/lib/images.js';

describe('checkDbImageOverride (cli.js, before any command runs)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDbImageWarningSink((msg) => process.stderr.write(`warning: ${msg}\n`));
  });

  it('a malformed VIBECARBON_DB_IMAGE: one error line, a fix hint, exit 1', () => {
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    checkDbImageOverride({ VIBECARBON_DB_IMAGE: 'ghcr.io/hyperformant/postgres-dev' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toEqual({ output: process.stderr });
    expect(error.mock.calls[0][0]).toBe(
      'VIBECARBON_DB_IMAGE must be a full image ref like ghcr.io/hyperformant/postgres-dev:<tag>, got "ghcr.io/hyperformant/postgres-dev"',
    );
    expect(info).toHaveBeenCalledWith(
      'fix the ref, or unset VIBECARBON_DB_IMAGE to use the release db image',
      { output: process.stderr },
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unset or valid: no exit, and the dev-image warning goes through clack to stderr', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    checkDbImageOverride({});
    checkDbImageOverride({ VIBECARBON_DB_IMAGE: 'ghcr.io/x/pg:clack-check' });
    expect(exit).not.toHaveBeenCalled();
    resolveDbImage({ env: { VIBECARBON_DB_IMAGE: 'ghcr.io/x/pg:clack-check' } });
    expect(warn).toHaveBeenCalledWith(
      'using dev db image ghcr.io/x/pg:clack-check; not for production',
      { output: process.stderr },
    );
  });
});

describe('asksHelpOrVersion (which runs skip the override check)', () => {
  it("a command's own -h or -v", () => {
    expect(asksHelpOrVersion(['-h'])).toBe(true);
    expect(asksHelpOrVersion(['prod', '-v'])).toBe(true);
    expect(asksHelpOrVersion(['prod', '-y'])).toBe(false);
  });

  it('flags after -- belong to the passed-through command, not this one', () => {
    expect(asksHelpOrVersion(['--', 'psql', '-v', 'ON_ERROR_STOP=1'])).toBe(false);
    expect(asksHelpOrVersion(['prod', '--', '-h'])).toBe(false);
    expect(asksHelpOrVersion(['-h', '--', 'psql'])).toBe(true);
  });
});
