import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enterJsonMode,
  exitJsonMode,
  wantsJson,
  writeJson,
} from '../../../../src/lib/cli/json-mode.js';

describe('json-mode', () => {
  afterEach(() => {
    exitJsonMode();
    vi.restoreAllMocks();
  });

  it('wantsJson needs the spec flag and -json in argv', () => {
    const spec = { flags: [{ name: 'json' }] };
    expect(wantsJson(spec, ['-json'])).toBe(true);
    expect(wantsJson(spec, [])).toBe(false);
    expect(wantsJson({ flags: [] }, ['-json'])).toBe(false);
  });

  it('routes stdout writes to stderr, but writeJson reaches real stdout', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    enterJsonMode();
    process.stdout.write('notice\n');
    writeJson({ a: 1 });
    expect(err).toHaveBeenCalledWith('notice\n', undefined, undefined);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledWith('{\n  "a": 1\n}\n');
  });
});
