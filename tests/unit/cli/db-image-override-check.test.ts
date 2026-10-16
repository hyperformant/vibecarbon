import * as p from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDbImageOverride } from '../../../src/cli.js';
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
    expect(error.mock.calls[0][0]).toBe(
      'VIBECARBON_DB_IMAGE must be a full image ref like ghcr.io/hyperformant/postgres-dev:<tag>, got "ghcr.io/hyperformant/postgres-dev"',
    );
    expect(info).toHaveBeenCalledWith(
      'fix the ref, or unset VIBECARBON_DB_IMAGE to use the release db image',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unset or valid: no exit, and the dev-image warning goes through clack', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    checkDbImageOverride({});
    checkDbImageOverride({ VIBECARBON_DB_IMAGE: 'ghcr.io/x/pg:clack-check' });
    expect(exit).not.toHaveBeenCalled();
    resolveDbImage({ env: { VIBECARBON_DB_IMAGE: 'ghcr.io/x/pg:clack-check' } });
    expect(warn).toHaveBeenCalledWith(
      'using dev db image ghcr.io/x/pg:clack-check; not for production',
    );
  });
});
