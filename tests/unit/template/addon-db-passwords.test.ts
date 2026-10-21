/**
 * Each add-on that logs in to the database (Metabase, n8n) has its own
 * password, never the superuser's.
 *
 * The db accepts password logins from the whole compose network for any
 * role (pg_hba scram-sha-256), and the app itself logs in as `postgres` over
 * that network. So while an add-on's role shared POSTGRES_PASSWORD, anyone
 * holding the add-on's credential (an RCE in its container, which carries it
 * in env) could log in as `postgres` with it: superuser, COPY ... TO PROGRAM,
 * the backup bucket's keys. Now `vibecarbon add` generates
 * METABASE_DB_PASSWORD / N8N_DB_PASSWORD (manifest `generate`), `vibecarbon
 * upgrade` heals a project that lacks one, the init script sets it with
 * psql's :'pw' quoting, and compose and k8s hand only that value to the
 * add-on.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPerEnvSecrets } from '../../../src/lib/deploy/k8s/gitops-deploy.js';
import { SECRET_KEYS } from '../../../src/lib/deploy/k8s/k3s.js';
import { formatDotenvLine, parseDotenv } from '../../../src/lib/dotenv.js';
import { ensureAddonSecrets } from '../../../src/upgrade.js';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ADDONS = [
  { name: 'metabase', key: 'METABASE_DB_PASSWORD' },
  { name: 'n8n', key: 'N8N_DB_PASSWORD' },
] as const;

/** What an add-on ships: compose (add-on and template copies), k8s, scripts. */
function shippedFiles(name: string): string[] {
  return [
    `services/${name}/compose/docker-compose.yml`,
    `services/${name}/compose/docker-compose.prod.yml`,
    `services/${name}/compose/docker-compose.override.yml`,
    `carbon/docker-compose.${name}.yml`,
    `carbon/docker-compose.${name}.prod.yml`,
    `services/${name}/k8s/deployment.yaml`,
    ...(name === 'metabase' ? ['services/metabase/scripts/setup.sh'] : []),
    `services/${name}/db/init.sh`,
  ];
}

describe('add-on database passwords', () => {
  for (const { name, key } of ADDONS) {
    describe(name, () => {
      it(`vibecarbon add generates ${key}`, () => {
        const manifest = JSON.parse(read(`services/${name}/manifest.json`));
        expect(manifest.envVars[key]).toEqual({ generate: 'password', length: 32 });
      });

      it('no shipped file hands the add-on the superuser password', () => {
        for (const file of shippedFiles(name)) {
          const text = read(file);
          expect(text, file).not.toMatch(/\bPOSTGRES_PASSWORD\b/);
          expect(text, file).not.toMatch(/key: DB_PASSWORD\b|\$\{DB_PASSWORD\b|"\$DB_PASSWORD"/);
        }
      });

      it(`compose hands ${key} to the add-on and to the db's init script`, () => {
        for (const file of [
          `services/${name}/compose/docker-compose.yml`,
          `carbon/docker-compose.${name}.yml`,
        ]) {
          const text = read(file);
          // The db service extension (the init script reads it in the db container).
          expect(text, file).toMatch(
            new RegExp(`\\n {2}db:\\n[\\s\\S]*?${key}[:=] ?"?\\$\\{${key}:\\?`),
          );
          expect(
            text.match(new RegExp(`\\$\\{${key}:\\?`, 'g'))?.length ?? 0,
            file,
          ).toBeGreaterThan(1);
        }
      });

      it(`k8s reads ${key} from vibecarbon-infra-secrets`, () => {
        expect(read(`services/${name}/k8s/deployment.yaml`)).toMatch(
          new RegExp(`secretKeyRef:\\s+name: vibecarbon-infra-secrets\\s+key: ${key}`),
        );
      });

      it('the init script refuses an empty password and sets it with :pw quoting, off the error and slow-statement logs, never on argv', () => {
        for (const file of [`services/${name}/db/init.sh`, `carbon/volumes/db/${name}-init.sh`]) {
          const script = read(file);
          expect(script, file).toContain(`: "\${${key}:?`);
          // The password is read inside the SQL, never passed on psql's argv.
          expect(script, file).not.toMatch(/-v pw=/);
          expect(script, file).toContain(`\\getenv pw ${key}\n`);
          expect(script, file).toMatch(
            new RegExp(
              `SET log_min_error_statement = panic;\\nSET log_min_duration_statement = -1;\\n\\\\getenv pw ${key}\\nALTER ROLE ${name} WITH PASSWORD :'pw';`,
            ),
          );
        }
      });

      it(`${key} reaches the k8s Secret and the GitOps environment secrets`, () => {
        expect(SECRET_KEYS).toContain(key);
        expect(buildPerEnvSecrets({ [key]: 'p'.repeat(32) })[key]).toBe('p'.repeat(32));
      });

      it(`.env.example documents ${key}`, () => {
        expect(parseDotenv(read('carbon/.env.example'))[key]).toBeTruthy();
      });
    });
  }

  describe('vibecarbon upgrade heals a project that has the add-on but not its password', () => {
    const project = (services: string[], lines: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'vc-addon-pw-'));
      const svcs = Object.fromEntries(services.map((s) => [s, { version: '1.0.0' }]));
      writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ services: svcs }));
      writeFileSync(join(dir, '.env.local'), `PROJECT_NAME=demo\n${lines}`);
      writeFileSync(join(dir, '.env'), `PROJECT_NAME=demo\n${lines}`);
      return dir;
    };
    const env = (dir: string, file: string) => parseDotenv(readFileSync(join(dir, file), 'utf-8'));

    it('generates the missing password into both env files, for installed add-ons only', () => {
      const dir = project(['metabase'], '');
      expect(ensureAddonSecrets(dir)).toEqual([
        { key: 'METABASE_DB_PASSWORD', status: 'generated' },
      ]);
      const local = env(dir, '.env.local').METABASE_DB_PASSWORD;
      expect(local).toHaveLength(32);
      expect(env(dir, '.env').METABASE_DB_PASSWORD).toBe(local);
      expect(env(dir, '.env.local').N8N_DB_PASSWORD).toBeUndefined();
    });

    it('n8n also gets one N8N_ENCRYPTION_KEY, so a promoted standby can read credentials', () => {
      const manifest = JSON.parse(read('services/n8n/manifest.json'));
      expect(manifest.envVars.N8N_ENCRYPTION_KEY).toEqual({ generate: 'password', length: 48 });
      const dir = project(['n8n'], '');
      expect(ensureAddonSecrets(dir)).toEqual([
        { key: 'N8N_DB_PASSWORD', status: 'generated' },
        { key: 'N8N_ENCRYPTION_KEY', status: 'generated' },
      ]);
      expect(env(dir, '.env.local').N8N_ENCRYPTION_KEY).toHaveLength(48);
      expect(env(dir, '.env').N8N_ENCRYPTION_KEY).toBe(env(dir, '.env.local').N8N_ENCRYPTION_KEY);
      for (const f of [
        'services/n8n/compose/docker-compose.yml',
        'carbon/docker-compose.n8n.yml',
      ]) {
        expect(read(f), f).toContain('N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY:?');
        expect(read(f), f).not.toContain('n8n_dev_encryption_key');
      }
      expect(read('services/n8n/k8s/deployment.yaml')).toMatch(
        /name: N8N_ENCRYPTION_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: vibecarbon-infra-secrets\n\s+key: N8N_ENCRYPTION_KEY/,
      );
    });

    it('never rotates one that is set, and copies it to the file that lacks it', () => {
      const dir = project(['n8n'], '');
      writeFileSync(
        join(dir, '.env.local'),
        `PROJECT_NAME=demo\n${formatDotenvLine('N8N_DB_PASSWORD', 'k'.repeat(32))}\n${formatDotenvLine('N8N_ENCRYPTION_KEY', 'e'.repeat(48))}\n`,
      );
      expect(ensureAddonSecrets(dir)).toEqual([
        { key: 'N8N_DB_PASSWORD', status: 'copied' },
        { key: 'N8N_ENCRYPTION_KEY', status: 'copied' },
      ]);
      expect(env(dir, '.env').N8N_DB_PASSWORD).toBe('k'.repeat(32));
      expect(env(dir, '.env').N8N_ENCRYPTION_KEY).toBe('e'.repeat(48));
      expect(ensureAddonSecrets(dir)).toEqual([]);
    });

    it('writes nothing under -dry, and nothing without a project manifest', () => {
      const dir = project(['metabase'], '');
      expect(ensureAddonSecrets(dir, { dryRun: true })).toEqual([
        { key: 'METABASE_DB_PASSWORD', status: 'generated' },
      ]);
      expect(env(dir, '.env.local').METABASE_DB_PASSWORD).toBeUndefined();
      const bare = mkdtempSync(join(tmpdir(), 'vc-addon-pw-'));
      mkdirSync(join(bare, 'x'));
      expect(ensureAddonSecrets(bare)).toEqual([]);
    });
  });
});

describe('observability_ro password', () => {
  it('is read with \\getenv, off argv and both statement logs', () => {
    const script = read('services/observability/db/init.sh');
    expect(script).not.toMatch(/-v pw=/);
    expect(script).toContain(
      "SET log_min_error_statement = panic;\nSET log_min_duration_statement = -1;\n\\getenv pw OBSERVABILITY_DB_PASSWORD\nALTER ROLE observability_ro WITH PASSWORD :'pw';",
    );
  });
});
