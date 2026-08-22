/**
 * LEAKED-VOLUME LEDGER — `~/.vibecarbon/leaked-volumes.json`
 *
 * The handoff between destroy (layer 1/2) and the standing sweep (layer 3).
 *
 * A destroy can know EXACTLY which provider volumes a cluster owned (captured
 * from its PersistentVolumes — see lib/csi-volumes.js) and still fail to delete
 * them: the volume is still detaching when the budget runs out, the provider
 * API 403s mid-teardown (2026-07-31), the process is SIGKILLed by an e2e step
 * timeout. That knowledge used to die with the process, and the sweep that runs
 * minutes later has no way to re-derive it: CSI volumes are named
 * `pvc-<uuid>` with no project prefix and (with the pinned driver versions) no
 * labels, so the sweep's only recourse is the blunt "delete every unattached
 * pvc-* volume, but ONLY when the whole project has zero servers" heuristic —
 * which defers forever during a back-to-back e2e matrix.
 *
 * Writing the captured ids here turns that into an identity the sweep can act
 * on with no heuristic at all: these are volumes a destroy PROVED belonged to a
 * cluster it tore down. The sweep deletes them by id regardless of what else is
 * running, then prunes the entry.
 *
 * Deliberately NOT written here: heuristic matches (a `pvc-*` name in the right
 * region). Those are exactly the case where we might be looking at a live
 * parallel cluster's volume, and an id-based delete would strip away the
 * zero-servers guard that makes them safe. They stay in the destroy report.
 *
 * Every function is best-effort and never throws: this is teardown-path
 * bookkeeping, and a corrupt/unwritable ledger must not fail a destroy that
 * otherwise succeeded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Same `~/.vibecarbon` convention (and 0700 mode) as the project registry. */
export function defaultLedgerPath(configDir = join(homedir(), '.vibecarbon')) {
  return join(configDir, 'leaked-volumes.json');
}

/** Stable identity for an entry — provider ids are only unique per provider. */
function entryKey(entry) {
  return `${entry.provider ?? 'unknown'}:${entry.id}`;
}

/**
 * @param {string} [ledgerPath]
 * @returns {{ volumes: Array<object> }} Always a usable shape, even for a
 *   missing or corrupt file.
 */
export function readVolumeLedger(ledgerPath = defaultLedgerPath()) {
  try {
    if (!existsSync(ledgerPath)) return { volumes: [] };
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    return { volumes: Array.isArray(parsed?.volumes) ? parsed.volumes : [] };
  } catch {
    // A hand-edited or truncated ledger must not wedge destroy or the sweep.
    return { volumes: [] };
  }
}

function writeLedger(ledgerPath, volumes) {
  try {
    const dir = dirname(ledgerPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(ledgerPath, `${JSON.stringify({ volumes }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Record volumes a destroy identified as its own but could NOT confirm deleted.
 * Upserts by provider+id, refreshing `recordedAt` so a repeated destroy keeps
 * the entry current rather than duplicating it.
 *
 * @param {Array<{ provider: string, id: string|number, name?: string, region?: string|null, project?: string, environment?: string, createdAt?: string|null }>} entries
 * @param {string} [ledgerPath]
 * @returns {{ written: number, path: string }}
 */
export function recordLeakedVolumes(entries, ledgerPath = defaultLedgerPath()) {
  const incoming = (entries ?? []).filter((e) => e && e.id !== undefined && e.id !== null);
  if (incoming.length === 0) return { written: 0, path: ledgerPath };

  const existing = readVolumeLedger(ledgerPath).volumes;
  const byKey = new Map(existing.map((e) => [entryKey(e), e]));
  const recordedAt = new Date().toISOString();
  for (const entry of incoming) {
    const normalized = {
      provider: entry.provider ?? 'unknown',
      id: String(entry.id),
      name: entry.name ?? null,
      region: entry.region ?? null,
      project: entry.project ?? null,
      environment: entry.environment ?? null,
      createdAt: entry.createdAt ?? null,
      recordedAt,
    };
    byKey.set(entryKey(normalized), normalized);
  }

  const volumes = [...byKey.values()];
  const ok = writeLedger(ledgerPath, volumes);
  return { written: ok ? incoming.length : 0, path: ledgerPath };
}

/**
 * Drop entries whose volumes are confirmed gone (deleted, or absent from a
 * listing we could actually read). Ids are compared as strings, since Hetzner
 * volume ids arrive as numbers over the wire and as strings from a PV's
 * `volumeHandle`.
 *
 * @param {Array<{ provider?: string, id: string|number }>} resolved
 * @param {string} [ledgerPath]
 * @returns {{ remaining: number }}
 */
export function pruneVolumeLedger(resolved, ledgerPath = defaultLedgerPath()) {
  const keys = new Set(
    (resolved ?? [])
      .filter((e) => e && e.id !== undefined && e.id !== null)
      .map((e) => entryKey({ provider: e.provider ?? 'unknown', id: String(e.id) })),
  );
  const volumes = readVolumeLedger(ledgerPath).volumes.filter(
    (e) => !keys.has(entryKey({ provider: e.provider ?? 'unknown', id: String(e.id) })),
  );
  writeLedger(ledgerPath, volumes);
  return { remaining: volumes.length };
}

/**
 * Entries for one provider, ids normalized to strings.
 * @param {string} provider
 * @param {string} [ledgerPath]
 */
export function ledgerEntriesFor(provider, ledgerPath = defaultLedgerPath()) {
  return readVolumeLedger(ledgerPath)
    .volumes.filter((e) => (e?.provider ?? 'unknown') === provider)
    .map((e) => ({ ...e, id: String(e.id) }));
}
