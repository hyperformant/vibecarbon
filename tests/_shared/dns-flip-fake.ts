/**
 * Fakes for the failover DNS flip (flipAndVerifyDns, src/lib/deploy/
 * failover-guard.js), shaped like the real backends: a write answers, by
 * name, with the record its response says the name now holds
 * (upsertApexAndWildcard), and the record list shows each record with its id
 * (readARecords). The flip judges the records it wrote by the first and reads
 * the second only for records the write did not name.
 */

export interface FlipRecord {
  id: string;
  value: string;
}

/** The id the fakes give the record at a name: one for the apex, one for the wildcard. */
function flipRecordId(name: string): string {
  return name.startsWith('*.') ? 'wildcard' : 'apex';
}

/** What upsertApexAndWildcard returns for a write of both records at `ip`. */
export function writtenFlip(domain: string, ip: string): Record<string, FlipRecord[]> {
  return {
    [domain]: [{ id: flipRecordId(domain), value: ip }],
    [`*.${domain}`]: [{ id: flipRecordId(`*.${domain}`), value: ip }],
  };
}

/** The record list at a name holding only the flip's own record at `ip` (empty when null). */
export function listedFlip(name: string, ip: string | null): FlipRecord[] {
  return ip ? [{ id: flipRecordId(name), value: ip }] : [];
}
