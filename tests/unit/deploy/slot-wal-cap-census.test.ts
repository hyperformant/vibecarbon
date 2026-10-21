/**
 * Census: the replication slot's WAL is capped, the same way on both tiers
 * (HA-correctness Task 7, H5).
 *
 * A physical slot holds WAL on the primary until its standby confirms it. With
 * no cap, a standby that stays down for about a week fills the primary's 10Gi
 * volume and takes the serving database down with it. `max_slot_wal_keep_size`
 * bounds what the slot may hold (past it the slot goes `lost` and the standby
 * is reseeded by the next deploy), `wal_keep_size` keeps a floor for a standby
 * that briefly reconnects without its slot, and `max_wal_senders` leaves room
 * for the streaming standby plus a reseed's basebackup.
 *
 * The db argv is written twice (compose `command:`, the k8s StatefulSet
 * `args:`), so the census parses both and requires all three settings, with
 * equal values, in each.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SLOT_WAL_SETTINGS } from '../../../src/lib/deploy/replication-slot.js';

const ROOT = join(__dirname, '../../..');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

/** `-c key=value` pairs of a postgres argv, as a map. */
function argvSettings(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  argv.forEach((tok, i) => {
    if (tok !== '-c') return;
    const [key, ...rest] = String(argv[i + 1] ?? '').split('=');
    out[key] = rest.join('=');
  });
  return out;
}

/** What a db argv is missing or has different from the slot WAL settings. */
function slotWalProblems(settings: Record<string, string>): string[] {
  return Object.entries(SLOT_WAL_SETTINGS)
    .filter(([key, value]) => settings[key] !== value)
    .map(([key, value]) => `${key}: want ${value}, got ${settings[key] ?? 'nothing'}`);
}

function composeDbArgv(text = readFileSync(join(ROOT, 'carbon/docker-compose.yml'), 'utf-8')) {
  const [doc] = loadAll(text) as Doc[];
  return doc.services.db.command as string[];
}

function k8sDbArgv(
  text = readFileSync(join(ROOT, 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8'),
) {
  const sts = (loadAll(text) as Doc[]).find((d) => d?.kind === 'StatefulSet');
  const db = sts.spec.template.spec.containers.find((ct: Doc) => ct.name === 'db');
  return db.args as string[];
}

describe('census: the slot WAL cap is in both db argv lists, with equal values', () => {
  it('the settings are the reviewed values', () => {
    expect(SLOT_WAL_SETTINGS).toEqual({
      max_slot_wal_keep_size: '4GB',
      wal_keep_size: '512MB',
      max_wal_senders: '10',
    });
  });

  it('compose db command carries all three', () => {
    expect(slotWalProblems(argvSettings(composeDbArgv()))).toEqual([]);
  });

  it('k8s db StatefulSet args carry all three', () => {
    expect(slotWalProblems(argvSettings(k8sDbArgv()))).toEqual([]);
  });

  it('the two lists agree on every setting they both name', () => {
    const compose = argvSettings(composeDbArgv());
    const k8s = argvSettings(k8sDbArgv());
    for (const key of Object.keys(SLOT_WAL_SETTINGS)) expect(compose[key]).toBe(k8s[key]);
  });

  it('bites: a file that drops one setting is reported', () => {
    const text = readFileSync(join(ROOT, 'carbon/docker-compose.yml'), 'utf-8').replace(
      /^\s*- max_slot_wal_keep_size=4GB\n/m,
      '',
    );
    expect(slotWalProblems(argvSettings(composeDbArgv(text)))).toEqual([
      'max_slot_wal_keep_size: want 4GB, got nothing',
    ]);
  });
});
