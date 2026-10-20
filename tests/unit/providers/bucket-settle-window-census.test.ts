/**
 * R6: every S3 provider class declares its own `bucketSettleWindowMs`, the
 * base class declares none (so a missing declaration fails here instead of
 * inheriting a silent default), and only probe evidence makes a window
 * non-zero. A walk, not a hand list: a new S3 provider is covered for free.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

/** Provider id -> where the evidence for its non-zero window lives. */
const SETTLE_WINDOW_EVIDENCE: Record<string, string> = {
  // The brief named the memory file; its name holds a retired service word
  // the terminology census refuses, so it is cited by topic instead.
  hetzner:
    '2026-10-20 probes (cors-probe.txt, cors-settle.txt), memory: the Hetzner new-bucket window',
};

const providersDir = join(import.meta.dirname, '../../../src/lib/providers');

type S3Class = { name: string; bucketSettleWindowMs?: unknown };

async function s3ClassesFromFiles(): Promise<S3Class[]> {
  const classes: S3Class[] = [];
  for (const file of readdirSync(providersDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(providersDir, file), 'utf-8');
    const names = [...src.matchAll(/class\s+(\w+)\s+extends\s+S3CompatibleProvider\b/g)].map(
      (m) => m[1],
    );
    if (names.length === 0) continue;
    const mod = await import(join(providersDir, file));
    for (const name of names) classes.push(mod[name]);
  }
  return classes;
}

async function s3ClassesFromRegistry(): Promise<Array<{ id: string; Class: S3Class }>> {
  return Promise.all(
    Object.entries(PROVIDERS).map(async ([id, P]) => ({
      id,
      Class: (await (
        P as unknown as { getObjectStorageProviderClass(): Promise<S3Class> }
      ).getObjectStorageProviderClass()) as S3Class,
    })),
  );
}

function declaresWindow(Class: S3Class): boolean {
  if (!Object.hasOwn(Class, 'bucketSettleWindowMs')) return false;
  const v = Class.bucketSettleWindowMs;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

describe('bucketSettleWindowMs census', () => {
  it('(a) every S3 provider class declares its own non-negative integer window', async () => {
    const fromFiles = await s3ClassesFromFiles();
    expect(fromFiles.length).toBeGreaterThanOrEqual(5);
    const fromRegistry = await s3ClassesFromRegistry();
    const missing = [
      ...fromFiles.filter((C) => !declaresWindow(C)).map((C) => C.name),
      ...fromRegistry.filter(({ Class }) => !declaresWindow(Class)).map(({ id }) => id),
    ];
    expect(missing, 'missing or invalid static bucketSettleWindowMs').toEqual([]);
  });

  it('(b) the base class declares no window, so there is no implicit default', () => {
    expect(Object.hasOwn(S3CompatibleProvider, 'bucketSettleWindowMs')).toBe(false);
  });

  it('(c) a non-zero window has probe evidence', async () => {
    const unexplained = (await s3ClassesFromRegistry())
      .filter(({ Class }) => Class.bucketSettleWindowMs !== 0)
      .filter(({ id }) => !SETTLE_WINDOW_EVIDENCE[id])
      .map(({ id, Class }) => `${id}=${String(Class.bucketSettleWindowMs)}`);
    expect(unexplained, 'a settle window needs probe evidence').toEqual([]);
  });
});
