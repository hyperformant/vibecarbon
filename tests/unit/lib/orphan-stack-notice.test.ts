import { describe, expect, it, vi } from 'vitest';
import { formatOrphanNotice, warnAboutOrphanStacks } from '../../../src/lib/orphan-stack-notice.js';

const HINTS = [
  'if you moved a project, run `vibecarbon up` in its new folder to pick it back up',
  'otherwise `vibecarbon down -orphans` removes them',
];
const yippy = { project: 'yippy', workingDir: '/home/me/repos/yippy' };
const carbon = { project: 'carbon', workingDir: '/home/me/repos/vibecarbon/carbon' };

describe('formatOrphanNotice', () => {
  it('returns null when there are no orphans', () => {
    expect(formatOrphanNotice([], { home: '/home/me' })).toBeNull();
  });

  it('describes one stack', () => {
    expect(formatOrphanNotice([yippy], { home: '/home/me' })).toEqual([
      'found a local stack whose project folder is gone: yippy (~/repos/yippy)',
      ...HINTS,
    ]);
  });

  it('describes several stacks', () => {
    expect(formatOrphanNotice([yippy, carbon], { home: '/home/me' })).toEqual([
      'found 2 local stacks whose project folders are gone: yippy (~/repos/yippy), carbon (~/repos/vibecarbon/carbon)',
      ...HINTS,
    ]);
  });

  it('abbreviates only paths under home', () => {
    const lines = formatOrphanNotice([{ project: 'x', workingDir: '/srv/x' }, yippy], {
      home: '/home/me',
    });
    expect(lines?.[0]).toContain('x (/srv/x), yippy (~/repos/yippy)');
  });
});

describe('warnAboutOrphanStacks', () => {
  const find = (stacks: unknown[]) => stacks as never;

  it('warns once then prints the hints', () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    warnAboutOrphanStacks({ list: () => [yippy], find, log });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^found a local stack whose project folder is gone: yippy/,
    );
    expect(log.info.mock.calls.map((c) => c[0])).toEqual(HINTS);
  });

  it('skips excluded project names', () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    warnAboutOrphanStacks({ exclude: ['yippy'], list: () => [yippy, carbon], find, log });
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^found a local stack whose project folder is gone: carbon/,
    );
    expect(log.warn.mock.calls[0][0]).not.toContain('yippy');
  });

  it('logs nothing when every orphan is excluded', () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    warnAboutOrphanStacks({ exclude: ['yippy'], list: () => [yippy], find, log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs nothing and does not throw when list throws', () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    expect(() =>
      warnAboutOrphanStacks({
        list: () => {
          throw new Error('docker down');
        },
        find,
        log,
      }),
    ).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});
