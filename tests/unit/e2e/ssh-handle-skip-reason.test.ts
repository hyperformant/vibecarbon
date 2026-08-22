/**
 * A skip must say WHICH precondition was missing.
 *
 * `config_secret_propagation`, `config_oauth_gotrue_propagation` and the wal-g
 * backup pair all skipped on the k8s tier at verify-deploy with the single
 * message "no serverIp/sshKeyPath". That wording cannot distinguish an absent
 * node IP from an absent key file, so a fix aimed at one of them (backfilling
 * serverIps, 75b259c6) shipped, ran on live infra, and changed nothing — with
 * no way to tell from the output which half was still wrong.
 *
 * The checks self-skipping is correct behaviour; the diagnostic being
 * unactionable is what cost the cycle.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../e2e/${rel}`, import.meta.url)), 'utf8');

const SITES = ['checks/config-canary.ts', 'checks/backup-evidence.ts'];

describe('ssh-handle skip reasons', () => {
  it('no check still emits the ambiguous combined wording', () => {
    for (const f of SITES) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${f}: still reports the un-actionable combined reason`).not.toMatch(
        /skipped: 'no serverIp\/sshKeyPath'/,
      );
    }
  });

  it('each site distinguishes the three cases', () => {
    for (const f of SITES) {
      const code = read(f);
      expect(code, `${f}: missing the IP-only case`).toMatch(/no serverIp \(sshKeyPath present\)/);
      expect(code, `${f}: missing the key-only case`).toMatch(/no sshKeyPath \(serverIp present\)/);
      expect(code, `${f}: missing the neither case`).toMatch(/no serverIp and no sshKeyPath/);
    }
  });

  it('still skips rather than failing — a check with no way in is not a failure', () => {
    // The point is legibility, not converting these to failures. A genuinely
    // absent handle (compose scenarios with no SSH surface) must stay a skip.
    for (const f of SITES) {
      expect(read(f)).toMatch(/status: 'skip'|skip\(/);
    }
  });
});
