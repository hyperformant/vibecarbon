/**
 * Census: every compose-side node-role write goes through `composeRoleEnv`.
 *
 * `WALG_ROLE` is written into `/opt/<project>/.env` at deploy
 * (haMergeWalgRole) and re-written at failover (restoreComposeWalgRole /
 * demoteComposeWalgRole). `composeRoleEnv` in walg-role.js is the one place
 * that key is spelled, and it refuses a role it does not know, so a caller
 * cannot arm wal-g archiving on a node whose role it guessed. This census
 * keeps it that way: no code line in either compose-side file may spell the
 * `WALG_ROLE` object key itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeRoleEnv, WALG_ROLE_ENV } from '../../../src/lib/deploy/walg-role.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** Every file that writes a compose node's `.env` role at deploy or failover. */
const COMPOSE_ROLE_WRITERS = [
  'src/lib/deploy/effects/compose-ha.js',
  'src/lib/deploy/compose/ha.js',
];

/**
 * A CODE line that spells the WALG_ROLE object key: `WALG_ROLE:` or
 * `[WALG_ROLE_ENV]:`. Comments and docblocks describe the variable
 * (`WALG_ROLE=standby`, the `${WALG_ROLE:-primary}` compose interpolation
 * quoted in a docblock) but do not write it, so they are skipped first.
 */
const ROLE_KEY_WRITE = /(?:\bWALG_ROLE\s*:|\[\s*WALG_ROLE_ENV\s*\]\s*:)/;
function isRoleKeyWrite(line: string): boolean {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
  return ROLE_KEY_WRITE.test(line);
}

describe('composeRoleEnv', () => {
  it('names the knob the compose template reads', () => {
    expect(WALG_ROLE_ENV).toBe('WALG_ROLE');
  });

  it('primary: write-guard on', () => {
    expect(composeRoleEnv('primary')).toEqual({ WALG_ROLE: 'primary' });
  });

  it('standby: write-guard off', () => {
    expect(composeRoleEnv('standby')).toEqual({ WALG_ROLE: 'standby' });
  });

  it('emits STRINGS, because mergeRemoteDotenv writes a dotenv file', () => {
    for (const role of ['primary', 'standby'] as const) {
      for (const v of Object.values(composeRoleEnv(role))) expect(typeof v).toBe('string');
    }
  });

  it('refuses an unknown role rather than guessing a write-guard value', () => {
    // A silent default here is a split-brain in waiting: `undefined` → primary
    // would arm wal-g archiving on a node whose role the caller did not know.
    // @ts-expect-error — the whole point is the runtime guard
    expect(() => composeRoleEnv('replica')).toThrow(/unknown role/);
    // @ts-expect-error — same
    expect(() => composeRoleEnv(undefined)).toThrow(/unknown role/);
  });
});

describe('census: compose-side role writes only happen through composeRoleEnv', () => {
  it('sanity: the matcher sees a literal role write', () => {
    // Mutation anchors: if the regex rots, these fail before the sweep can
    // vacuously pass on an empty offender list.
    expect(isRoleKeyWrite("      WALG_ROLE: 'primary',")).toBe(true);
    expect(isRoleKeyWrite("      [WALG_ROLE_ENV]: 'standby',")).toBe(true);
    expect(isRoleKeyWrite(' * still `WALG_ROLE=primary` — so without this it')).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a quoted compose interpolation from a docblock, not a JS placeholder
    expect(isRoleKeyWrite(' * (`WALG_ROLE: ${WALG_ROLE:-primary}` in docker-compose.yml)')).toBe(
      false,
    );
    // Code that merely READS the value is not a write either.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample line under test IS a template literal, quoted as data
    expect(isRoleKeyWrite('    log(`[walg-role] ${WALG_ROLE_ENV}=primary`);')).toBe(false);
  });

  for (const file of COMPOSE_ROLE_WRITERS) {
    it(`${file} never spells the WALG_ROLE object key itself`, () => {
      const src = readFileSync(join(REPO, file), 'utf-8');
      const offenders: string[] = [];
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isRoleKeyWrite(lines[i])) offenders.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
      expect(
        offenders,
        `Every compose-side role write must be \`composeRoleEnv(role)\`, the one place the ` +
          `role is validated before it reaches a node's write-guard.`,
      ).toEqual([]);
    });

    it(`${file} does route its role writes through composeRoleEnv`, () => {
      // The inverse guard: a file that stopped writing roles at all would
      // pass the sweep above while the standby lost its write-guard.
      const src = readFileSync(join(REPO, file), 'utf-8');
      expect(src).toMatch(/composeRoleEnv\('primary'\)/);
      expect(src).toMatch(/composeRoleEnv\('standby'\)/);
    });
  }
});
