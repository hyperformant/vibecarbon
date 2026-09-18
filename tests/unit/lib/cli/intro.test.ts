import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.mock('@clack/prompts', () => ({
  intro: (m: string) => calls.push(`intro:${m}`),
}));
vi.mock('../../../../src/lib/colors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/colors.js')>();
  return { ...actual, printBanner: () => calls.push('banner') };
});
vi.mock('../../../../src/lib/telemetry/update-check.js', () => ({
  printUpdateNotice: vi.fn(() => {
    calls.push('notice');
    return true;
  }),
}));

import { introCommand } from '../../../../src/lib/cli/intro.js';
import { printUpdateNotice } from '../../../../src/lib/telemetry/update-check.js';

describe('introCommand', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.mocked(printUpdateNotice).mockClear();
  });

  it('prints banner, then the update notice, then the intro line', () => {
    introCommand('status');
    expect(calls).toEqual([
      'banner',
      'notice',
      expect.stringMatching(/^intro:.*vibecarbon status/),
    ]);
  });

  it('asks for no leading blank line — the banner already ends with one', () => {
    introCommand('status');
    expect(printUpdateNotice).toHaveBeenCalledWith();
  });
});
