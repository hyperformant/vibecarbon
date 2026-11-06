/**
 * Template lockstep preflight (k8s-ha churn redesign, Task B9).
 *
 * This CLI moves the wal-g role through a role file read by the template's
 * scripts (walg-env.sh, the k8s ConfigMap's db-guard.sh, the compose role
 * bind). A project whose scaffold predates that file would run this CLI
 * against scripts that read a WALG_ROLE env var nothing sets any more: the
 * CLI writes a role file nobody reads. Deploy refuses that project before
 * anything is provisioned and names `vibecarbon upgrade`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DB_GUARD_PROTOCOL_MARKER } from '../../../src/lib/deploy/db-workload.js';
import { assertScaffoldSupportsRoleFile } from '../../../src/lib/deploy/preflight.js';
import { WALG_ROLE_PARSE_SH } from '../../../src/lib/deploy/walg-role.js';
import { copyTemplate } from '../helpers/copy-template.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh copy of the shipped scaffold. */
function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-scaffold-'));
  dirs.push(dir);
  copyTemplate(dir);
  return dir;
}
function edit(path: string, fn: (s: string) => string) {
  const before = readFileSync(path, 'utf-8');
  const after = fn(before);
  expect(after).not.toBe(before);
  writeFileSync(path, after);
}

const CM = 'k8s/base/backup/configmap-walg.yaml';
const STS = 'k8s/base/db/statefulset.yaml';
/** The db container's command line in the shipped StatefulSet. */
const DB_COMMAND_LINE = '          command: ["sh", "/usr/local/bin/db-guard.sh"]';
const indent4 = (s: string) =>
  s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');

describe('assertScaffoldSupportsRoleFile', () => {
  it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const)(
    '%s: the current scaffold passes; an old walg-env.sh refuses',
    (tier) => {
      const dir = scaffold();
      expect(() => assertScaffoldSupportsRoleFile(dir, tier)).not.toThrow();
      const env = join(dir, 'volumes/db/walg-env.sh');
      writeFileSync(env, readFileSync(env, 'utf-8').replace(WALG_ROLE_PARSE_SH, ''));
      expect(() => assertScaffoldSupportsRoleFile(dir, tier)).toThrow(/vibecarbon upgrade/);
    },
  );

  it.each(['k8s', 'k8s-ha'] as const)(
    '%s: a db-guard.sh key without the reseed protocol marker line refuses',
    (tier) => {
      const dir = scaffold();
      edit(join(dir, CM), (s) =>
        s.replace(`    ${DB_GUARD_PROTOCOL_MARKER}\n`, '    # vc-reseed-protocol: 0\n'),
      );
      expect(() => assertScaffoldSupportsRoleFile(dir, tier)).toThrow(/vibecarbon upgrade/);
    },
  );

  it('k8s: the marker only inside another line, or only in walg-env.sh, does not count', () => {
    const dir = scaffold();
    edit(join(dir, CM), (s) =>
      s
        .replace(`    ${DB_GUARD_PROTOCOL_MARKER}\n`, `    echo '${DB_GUARD_PROTOCOL_MARKER}'\n`)
        .replace('  walg-env.sh: |\n', `  walg-env.sh: |\n    ${DB_GUARD_PROTOCOL_MARKER}\n`),
    );
    expect(() => assertScaffoldSupportsRoleFile(dir, 'k8s-ha')).toThrow(/vibecarbon upgrade/);
  });

  it.each([
    [
      'the image entrypoint',
      (s: string) => s.replace(DB_COMMAND_LINE, '          command: ["docker-entrypoint.sh"]'),
    ],
    ['no command at all', (s: string) => s.replace(`${DB_COMMAND_LINE}\n`, '')],
    [
      'db-guard.sh only on another container',
      (s: string) =>
        s
          .replace(`${DB_COMMAND_LINE}\n`, '')
          .replace(
            '        - name: walg-restore\n',
            `        - name: walg-restore\n${DB_COMMAND_LINE}\n`,
          ),
    ],
  ])('k8s-ha: a db container whose command is %s refuses', (_name, fn) => {
    const dir = scaffold();
    edit(join(dir, STS), fn);
    expect(() => assertScaffoldSupportsRoleFile(dir, 'k8s-ha')).toThrow(/vibecarbon upgrade/);
    expect(() => assertScaffoldSupportsRoleFile(dir, 'compose-ha')).not.toThrow();
  });

  it('k8s: the db command as a block list passes like the flow list', () => {
    const dir = scaffold();
    edit(join(dir, STS), (s) =>
      s.replace(
        DB_COMMAND_LINE,
        '          command:\n            - sh\n            - "/usr/local/bin/db-guard.sh"',
      ),
    );
    expect(() => assertScaffoldSupportsRoleFile(dir, 'k8s')).not.toThrow();
  });

  it('k8s: a ConfigMap without db-guard.sh refuses', () => {
    const dir = scaffold();
    const cm = join(dir, CM);
    writeFileSync(cm, readFileSync(cm, 'utf-8').replace(/\n {2}db-guard\.sh: \|[\s\S]*$/, '\n'));
    expect(() => assertScaffoldSupportsRoleFile(dir, 'k8s-ha')).toThrow(/vibecarbon upgrade/);
  });

  it.each(['k8s', 'k8s-ha'] as const)(
    '%s: a ConfigMap whose walg-env.sh lacks the role parser refuses',
    (tier) => {
      const dir = scaffold();
      edit(join(dir, CM), (s) => s.replace(indent4(WALG_ROLE_PARSE_SH), ''));
      expect(() => assertScaffoldSupportsRoleFile(dir, tier)).toThrow(/vibecarbon upgrade/);
    },
  );

  it('k8s: the parser only in a comment or another key does not count', () => {
    // The parser must live in the walg-env.sh key; db-guard.sh carrying it
    // does not make the ConfigMap's walg-env.sh read the role file.
    const dir = scaffold();
    edit(join(dir, CM), (s) =>
      s
        .replace(indent4(WALG_ROLE_PARSE_SH), '')
        .replace('  db-guard.sh: |\n', `  db-guard.sh: |\n${indent4(WALG_ROLE_PARSE_SH)}\n`),
    );
    expect(() => assertScaffoldSupportsRoleFile(dir, 'k8s-ha')).toThrow(/vibecarbon upgrade/);
  });

  it.each(['compose', 'compose-ha'] as const)(
    '%s: a docker-compose.prod.yml without the role bind refuses',
    (tier) => {
      const dir = scaffold();
      edit(join(dir, 'docker-compose.prod.yml'), (s) => s.replaceAll('.vibecarbon-role', '.gone'));
      expect(() => assertScaffoldSupportsRoleFile(dir, tier)).toThrow(/vibecarbon upgrade/);
    },
  );

  it('compose tiers do not read the k8s ConfigMap; k8s tiers do not read the compose file', () => {
    const dir = scaffold();
    rmSync(join(dir, CM));
    expect(() => assertScaffoldSupportsRoleFile(dir, 'compose-ha')).not.toThrow();
    const dir2 = scaffold();
    rmSync(join(dir2, 'docker-compose.prod.yml'));
    expect(() => assertScaffoldSupportsRoleFile(dir2, 'k8s-ha')).not.toThrow();
  });

  it.each([
    ['compose', 'volumes/db/walg-env.sh'],
    ['compose-ha', 'docker-compose.prod.yml'],
    ['k8s', CM],
    ['k8s-ha', 'volumes/db/walg-env.sh'],
  ] as const)('%s: a missing or unreadable %s refuses (fail-closed)', (tier, rel) => {
    const dir = scaffold();
    rmSync(join(dir, rel));
    expect(() => assertScaffoldSupportsRoleFile(dir, tier)).toThrow(/vibecarbon upgrade/);
  });

  it('the refusal is one line that names the fix and carries no em dash', () => {
    const dir = scaffold();
    rmSync(join(dir, 'volumes/db/walg-env.sh'));
    let msg = '';
    try {
      assertScaffoldSupportsRoleFile(dir, 'k8s-ha');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      "This project's scaffold predates the wal-g role file. Run `vibecarbon upgrade`, then deploy again.",
    );
    expect(msg).not.toContain('\n');
    expect(msg).not.toMatch(/—/);
  });

  it.each(['compose-ha', 'k8s-ha'] as const)(
    '%s: a CRLF checkout of the current scaffold passes (upgrade cannot fix line endings)',
    (tier) => {
      const dir = scaffold();
      for (const rel of ['volumes/db/walg-env.sh', 'docker-compose.prod.yml', CM]) {
        edit(join(dir, rel), (s) => s.replace(/\n/g, '\r\n'));
      }
      expect(() => assertScaffoldSupportsRoleFile(dir, tier)).not.toThrow();
    },
  );

  it('an unknown tier throws rather than passing', () => {
    expect(() => assertScaffoldSupportsRoleFile(scaffold(), 'kubernetes' as never)).toThrow(/tier/);
  });
});
