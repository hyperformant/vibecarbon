import { describe, expect, it } from 'vitest';
import { BOOT_STAGE_LABELS, readBootStage } from '../../../src/lib/deploy/boot-timing.js';

describe('readBootStage', () => {
  it('reports the label for a real `<id> <epoch.fraction>` line', () => {
    const seen: string[] = [];
    const onLine = readBootStage((label: string) => seen.push(label));
    onLine('k 1762300000.123456789');
    expect(seen).toEqual([BOOT_STAGE_LABELS.k]);
  });

  it('keeps the highest epoch, so a reconnect replaying the log cannot walk the label back', () => {
    const seen: string[] = [];
    const onLine = readBootStage((label: string) => seen.push(label));
    onLine('p 100.5');
    onLine('a 110.5');
    onLine('p 100.5');
    onLine('a 110.5');
    onLine('n 120.5');
    expect(seen).toEqual([BOOT_STAGE_LABELS.p, BOOT_STAGE_LABELS.a, BOOT_STAGE_LABELS.n]);
  });

  it('renders on a label change only, never for the same label again', () => {
    const seen: string[] = [];
    const onLine = readBootStage((label: string) => seen.push(label));
    onLine('a 10');
    onLine('a 11');
    expect(seen).toEqual([BOOT_STAGE_LABELS.a]);
  });

  it('ignores lines that are not marks and ids with no label', () => {
    const seen: string[] = [];
    const onLine = readBootStage((label: string) => seen.push(label));
    onLine('Reading package lists...');
    onLine('e 10.0');
    onLine('b.begin 11.0');
    onLine('');
    expect(seen).toEqual([]);
  });

  it('has no label for the b.begin/b.end span ids, which are not a plain id', () => {
    expect(Object.keys(BOOT_STAGE_LABELS)).not.toContain('b');
  });
});
