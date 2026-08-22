import { describe, expect, it } from 'vitest';
import { parsePerfLines } from '../../../tests/e2e/metrics/reporter.js';

describe('parsePerfLines', () => {
  it('returns an empty array when no [perf] lines are present', () => {
    expect(parsePerfLines('hello\nworld\n')).toEqual([]);
  });

  it('extracts one entry per [perf] line and sorts descending', () => {
    const input =
      '[perf] compose.deploy.buildImage 123456ms\n' +
      'other noise\n' +
      '[perf] compose.deploy.setupFiles 42000ms\n' +
      '[perf] compose.deploy.cloudInitReady 2100ms\n';
    const timings = parsePerfLines(input);
    expect(timings).toEqual([
      { name: 'compose.deploy.buildImage', ms: 123456 },
      { name: 'compose.deploy.setupFiles', ms: 42000 },
      { name: 'compose.deploy.cloudInitReady', ms: 2100 },
    ]);
  });

  it('captures the optional trailing note (e.g. "(failed)")', () => {
    const timings = parsePerfLines('[perf] compose.deploy.buildImage 17000ms (failed)\n');
    expect(timings).toEqual([{ name: 'compose.deploy.buildImage', ms: 17000, note: '(failed)' }]);
  });

  it('ignores malformed [perf] lines', () => {
    const input = '[perf] no-duration\n[perf]\n[perf] a-name not-a-number\n';
    expect(parsePerfLines(input)).toEqual([]);
  });
});
