import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Shared scrub for test-spawned git (GIT_DIR hook-leak class — see the
// module doc in _shared/git-env.ts; this file's local copy converged there
// after the 2026-07-30 incident showed a second hand-rolled copy drifting).
import { gitScrubbedEnv } from '../../_shared/git-env.js';
// `create` infers the package manager from npm_config_user_agent, which the
// runner sets — see the module doc. Without this the "default options" block
// below tests whatever manager launched vitest, not the customer default.
import { pmScrubbedEnv } from '../../_shared/pm-env.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

describe('create-vibecarbon E2E', () => {
  let tempDir: string;
  const projectName = 'test-e2e-project';

  beforeAll(() => {
    tempDir = createTempDir('vibecarbon-e2e-');
  });

  afterAll(() => {
    cleanupTempDir(tempDir);
  });

  describe('project creation with default options', () => {
    const projectDir = () => join(tempDir, projectName);

    beforeAll(() => {
      // Run create-vibecarbon with -y flag (non-interactive)
      execSync(
        `node ${join(process.cwd(), 'src/cli.js')} create ${projectName} -y -admin-email test@e2e.local -admin-password testpass123 -skip-lockfile`,
        {
          cwd: tempDir,
          encoding: 'utf-8',
          timeout: 60000,
          env: pmScrubbedEnv(),
        },
      );
    }, 60000);

    it('creates project directory', () => {
      expect(existsSync(projectDir())).toBe(true);
    });

    it('generates package.json', () => {
      expect(existsSync(join(projectDir(), 'package.json'))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(projectDir(), 'package.json'), 'utf-8'));
      // Package name is set from template - verify it exists
      expect(pkg.name).toBeDefined();
      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.dev).toBeDefined();
      expect(pkg.scripts.build).toBeDefined();
    });

    it('ships no packageManager pin — at the template or in the default project', () => {
      // Successor to the byte-identical pin guard from PR #213. That guard
      // existed because create.js overwrote the field with the CREATING
      // host's package-manager version, which un-pinned a template whose
      // lockfile and config were pinned somewhere else. The npm-based
      // template resolves that by having nothing to un-pin: npm ships with
      // Node, so the default project is corepack-free by construction.
      //
      // Both halves matter. A pin appearing at the SOURCE would push every
      // generated project through corepack — the extra install step the npm
      // default exists to remove. A pin appearing only in the OUTPUT would
      // mean create.js started inventing one again.
      const templatePkg = JSON.parse(
        readFileSync(join(process.cwd(), 'carbon', 'package.json'), 'utf-8'),
      );
      expect(templatePkg.packageManager).toBeUndefined();
      const pkg = JSON.parse(readFileSync(join(projectDir(), 'package.json'), 'utf-8'));
      expect(pkg.packageManager).toBeUndefined();
    });

    it('generates all required directories', () => {
      const requiredDirs = [
        'src/server/routes/api',
        'src/server/routes/v1',
        'src/server/lib',
        'src/client/components/auth',
        'src/client/components/ui',
        'src/client/pages',
        'src/client/lib',
        'src/shared',
        'supabase/migrations',
        'volumes/kong',
        'volumes/db',
      ];

      for (const dir of requiredDirs) {
        expect(existsSync(join(projectDir(), dir))).toBe(true);
      }
    });

    it('generates all required config files', () => {
      const requiredFiles = [
        'package.json',
        'tsconfig.json',
        'tsconfig.server.json',
        'vite.config.ts',
        'biome.json',
        'components.json',
        '.env.example',
        '.env.local',
        'Dockerfile',
        'docker-compose.yml',
        'docker-compose.prod.yml',
        'README.md',
      ];

      for (const file of requiredFiles) {
        expect(existsSync(join(projectDir(), file))).toBe(true);
      }
    });

    it('emits biome.json as a ROOT config (standalone project has no parent)', () => {
      // carbon/biome.json ships "root": false (nested under the monorepo root
      // config); a standalone scaffold has no parent, and Biome 2.x would then
      // ignore the config entirely and lint gitignored output. create must flip it.
      const biome = JSON.parse(readFileSync(join(projectDir(), 'biome.json'), 'utf-8'));
      expect(biome.root).toBe(true);
    });

    it('generates .env.local with secrets', () => {
      const envContent = readFileSync(join(projectDir(), '.env.local'), 'utf-8');
      expect(envContent).toContain('SUPABASE_ANON_KEY=');
      expect(envContent).toContain('SUPABASE_SERVICE_ROLE_KEY=');
      expect(envContent).toContain('JWT_SECRET=');
      expect(envContent).toContain('DB_PASSWORD=');
    });

    it('replaces all template placeholders', () => {
      // Check docker-compose.yml for placeholder replacement
      const dockerCompose = readFileSync(join(projectDir(), 'docker-compose.yml'), 'utf-8');
      expect(dockerCompose).not.toContain('{{PROJECT_NAME}}');
      expect(dockerCompose).not.toContain('{{DB_PASSWORD}}');
      expect(dockerCompose).not.toContain('{{JWT_SECRET}}');
      // Verify placeholder replacement happened (actual project name gets embedded)
      expect(dockerCompose.length).toBeGreaterThan(100);
    });

    it('keeps {{ADMIN_PASSWORD}} as a placeholder in k8s/values/supabase.values.yaml', () => {
      // installSupabase() in src/lib/deploy/k8s/k3s.js patches {{ADMIN_PASSWORD}}
      // at deploy time from .env.local. Substituting it at create-time bakes a
      // high-entropy password into a checked-in file and trips the preflight
      // secret-scan during `vibecarbon deploy` (regression from a brand-new
      // project). Non-secret placeholders like {{ADMIN_EMAIL}} and {{PROJECT_NAME}}
      // are still substituted normally.
      const valuesYaml = readFileSync(
        join(projectDir(), 'k8s/values/supabase.values.yaml'),
        'utf-8',
      );
      expect(valuesYaml).toContain('{{ADMIN_PASSWORD}}');
      expect(valuesYaml).not.toContain('{{ADMIN_EMAIL}}');
      expect(valuesYaml).not.toContain('{{PROJECT_NAME}}');
    });

    it('copies binary icon assets byte-identical to the template (no UTF-8 corruption)', () => {
      // copyTemplate() runs a UTF-8 read/replace/write over template files;
      // binary assets must bypass it (isBinaryFile) or PNGs arrive corrupted.
      const templatePublic = join(process.cwd(), 'carbon/src/client/public');
      const projectPublic = join(projectDir(), 'src/client/public');
      for (const asset of [
        'favicon.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'og-image.png',
      ]) {
        const generated = readFileSync(join(projectPublic, asset));
        expect(generated.equals(readFileSync(join(templatePublic, asset))), asset).toBe(true);
      }
      // PNG magic bytes — the corruption mode replaces these with U+FFFD sequences
      const png = readFileSync(join(projectPublic, 'icon-512.png'));
      expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    it('substitutes the display name into site.webmanifest', () => {
      const manifest = JSON.parse(
        readFileSync(join(projectDir(), 'src/client/public/site.webmanifest'), 'utf-8'),
      );
      expect(manifest.name).toBe('Test E2e Project');
      expect(manifest.short_name).toBe('Test E2e Project');
      expect(manifest.icons).toHaveLength(3);
    });

    it('substitutes the derived display name into the browser title', () => {
      const html = readFileSync(join(projectDir(), 'src/client/index.html'), 'utf-8');
      expect(html).toContain('<title>Test E2e Project</title>');
      expect(html).not.toContain('{{PROJECT_DISPLAY_NAME}}');
    });

    it('bakes the display name into the Logo fallback constant', () => {
      const logo = readFileSync(join(projectDir(), 'src/client/components/Logo.tsx'), 'utf-8');
      expect(logo).toContain("'Test E2e Project'");
      expect(logo).not.toContain('{{PROJECT_DISPLAY_NAME}}');
    });

    it('records the display name in .env.local for upgrade reconstruction', () => {
      const envLocal = readFileSync(join(projectDir(), '.env.local'), 'utf-8');
      expect(envLocal).toMatch(/^PROJECT_DISPLAY_NAME='Test E2e Project'$/m);
      expect(envLocal).toMatch(/^SMTP_SENDER_NAME='Test E2e Project'$/m);
    });

    it('links the mobile icon set from index.html', () => {
      const html = readFileSync(join(projectDir(), 'src/client/index.html'), 'utf-8');
      expect(html).toContain('rel="apple-touch-icon"');
      expect(html).toContain('rel="manifest"');
      expect(html).toContain('name="theme-color"');
    });

    it('generates valid TypeScript configuration', () => {
      const tsconfig = JSON.parse(readFileSync(join(projectDir(), 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('generates source files', () => {
      const sourceFiles = [
        'src/server/index.ts',
        'src/server/lib/env.ts',
        'src/server/lib/supabase.ts',
        'src/server/routes/health.ts',
        'src/client/App.tsx',
        'src/client/main.tsx',
        'src/client/lib/supabase.ts',
        'src/shared/types.ts',
      ];

      for (const file of sourceFiles) {
        expect(existsSync(join(projectDir(), file))).toBe(true);
      }
    });

    it('generates migration files', () => {
      expect(existsSync(join(projectDir(), 'supabase/migrations/00001_init.sql'))).toBe(true);
    });

    it('ships the test-seed scaffolding (tiered vitest setup + helpers)', () => {
      // The seed gives test-maintainer a fixed shape to mimic and the
      // user a day-1 safety net. If any of these go missing the agent's
      // output gets idiosyncratic in every new project.
      const requiredTestFiles = [
        'vitest.config.ts',
        'tsconfig.test.json',
        'TESTING.md',
        'tests/_helpers/app.ts',
        'tests/_helpers/env.ts',
        'tests/_helpers/factories.ts',
        'tests/_helpers/jwt.ts',
        'tests/_helpers/setup-rtl.ts',
        'tests/_helpers/setup-integration.ts',
        'tests/unit/shared/pricing.test.ts',
        'tests/unit/client/utils.test.ts',
        'tests/structural/i18n-parity.test.ts',
        'tests/component/ErrorBoundary.test.tsx',
        'tests/component/use-auth-settings.test.tsx',
        'tests/integration/server/routes/health.test.ts',
        'tests/integration/server/routes/contact.test.ts',
      ];

      for (const file of requiredTestFiles) {
        expect(existsSync(join(projectDir(), file)), `missing ${file}`).toBe(true);
      }
    });

    it('does not leave the original i18n-parity test in src/', () => {
      // Moved to tests/structural/. Leaving it in src/ would double-run
      // and confuse the structural-vs-unit pattern.
      expect(existsSync(join(projectDir(), 'src/client/locales/i18n-parity.test.ts'))).toBe(false);
    });

    it('wires test:* scripts in package.json', () => {
      const pkg = JSON.parse(readFileSync(join(projectDir(), 'package.json'), 'utf-8'));
      expect(pkg.scripts['test:unit']).toBe('vitest run --project unit');
      expect(pkg.scripts['test:component']).toBe('vitest run --project component');
      expect(pkg.scripts['test:integration']).toBe('vitest run --project integration');
      expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
      expect(pkg.scripts['test:prepush']).toContain('test:unit');
      expect(pkg.scripts['test:prepush']).toContain('test:component');
      expect(pkg.scripts['test:prepush']).toContain('test:integration');
    });

    it('declares the RTL + coverage devDependencies', () => {
      const pkg = JSON.parse(readFileSync(join(projectDir(), 'package.json'), 'utf-8'));
      const required = [
        '@testing-library/react',
        '@testing-library/jest-dom',
        '@testing-library/user-event',
        '@vitest/coverage-v8',
        'jsdom',
      ];
      for (const dep of required) {
        expect(pkg.devDependencies?.[dep], `missing devDep ${dep}`).toBeDefined();
      }
    });
  });

  describe('project creation initializes git by default', () => {
    const gitProject = 'test-e2e-git-hooks';
    const projectDir = () => join(tempDir, gitProject);

    beforeAll(() => {
      const result = spawnSync(
        'node',
        [
          join(process.cwd(), 'src/cli.js'),
          'create',
          gitProject,
          '-y',
          '-admin-email',
          'test@e2e.local',
          '-admin-password',
          'testpass123',
          '-skip-lockfile',
        ],
        { cwd: tempDir, encoding: 'utf-8', timeout: 60000 },
      );
      if (result.status !== 0) {
        throw new Error(`create failed: ${result.stderr || result.stdout}`);
      }
    }, 60000);

    it('creates a .git directory at the project root', () => {
      expect(existsSync(join(projectDir(), '.git'))).toBe(true);
    });

    it('installs an executable pre-commit hook (lint + secret scan)', () => {
      const hookPath = join(projectDir(), '.git/hooks/pre-commit');
      expect(existsSync(hookPath)).toBe(true);
      const content = readFileSync(hookPath, 'utf-8');
      expect(content).toContain('lint');
      expect(content).toContain('secret-scan');
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    });

    it('installs an executable pre-push hook that runs test:prepush', () => {
      const hookPath = join(projectDir(), '.git/hooks/pre-push');
      expect(existsSync(hookPath)).toBe(true);
      const content = readFileSync(hookPath, 'utf-8');
      expect(content).toContain('test:prepush');
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    });

    it('creates exactly one initial commit titled "Initial commit from vibecarbon"', () => {
      const count = execSync('git rev-list --count HEAD', {
        cwd: projectDir(),
        encoding: 'utf-8',
        env: gitScrubbedEnv(),
      }).trim();
      expect(count).toBe('1');

      const subject = execSync('git log -1 --format=%s', {
        cwd: projectDir(),
        encoding: 'utf-8',
        env: gitScrubbedEnv(),
      }).trim();
      expect(subject).toBe('Initial commit from vibecarbon');
    });

    it('leaves a clean working tree after the initial commit', () => {
      const status = execSync('git status --porcelain', {
        cwd: projectDir(),
        encoding: 'utf-8',
        env: gitScrubbedEnv(),
      }).trim();
      expect(status).toBe('');
    });

    it('does not track gitignored secret files in the initial commit', () => {
      const tracked = execSync('git ls-files', {
        cwd: projectDir(),
        encoding: 'utf-8',
        env: gitScrubbedEnv(),
      });
      // Real generated secrets live in .env / .env.local — both must stay untracked.
      expect(tracked).not.toContain('.env.local');
      expect(tracked.split('\n')).not.toContain('.env');
      // sanity: the commit DID include real template files (and the example env).
      expect(tracked).toContain('package.json');
      expect(tracked).toContain('.env.example');
    });

    it('gitignores `vibecarbon upgrade` backup/new files at root and nested paths', () => {
      // `vibecarbon upgrade` writes two kinds of review artifacts alongside a
      // replaced file (src/upgrade.js): `<file>.upgrade-backup` (the user's
      // pre-upgrade copy) and `<file>.upgrade-new` (the incoming template
      // content, left for manual review). A real upgraded project produced
      // these both at repo root and nested under template directories (e.g.
      // k8s/base) — all of them must be ignored so `git add -A` never sweeps
      // a pre-upgrade copy (which can hold credentials) into history.
      const relPaths = [
        'package.json.upgrade-backup',
        'package.json.upgrade-new',
        join('k8s', 'base', 'kustomization.yaml.upgrade-backup'),
        join('k8s', 'base', 'kustomization.yaml.upgrade-new'),
      ];
      mkdirSync(join(projectDir(), 'k8s', 'base'), { recursive: true });
      for (const relPath of relPaths) {
        writeFileSync(join(projectDir(), relPath), 'upgrade artifact\n');
      }
      try {
        for (const relPath of relPaths) {
          const result = spawnSync('git', ['check-ignore', relPath], {
            cwd: projectDir(),
            encoding: 'utf-8',
            env: gitScrubbedEnv(),
          });
          expect(result.status, `expected ${relPath} to be gitignored`).toBe(0);
          expect(result.stdout.trim()).toBe(relPath);
        }

        const tracked = execSync('git ls-files', {
          cwd: projectDir(),
          encoding: 'utf-8',
          env: gitScrubbedEnv(),
        });
        expect(tracked).not.toContain('.upgrade-backup');
        expect(tracked).not.toContain('.upgrade-new');
      } finally {
        for (const relPath of relPaths) {
          rmSync(join(projectDir(), relPath), { force: true });
        }
      }
    });
  });

  describe('initial commit succeeds with no git identity configured', () => {
    const noIdProject = 'test-e2e-no-git-id';
    const projectDir = () => join(tempDir, noIdProject);

    beforeAll(() => {
      // Strip any inherited identity so `git config user.*` is empty inside
      // the create subprocess — forces the fallback identity path.
      const env = { ...process.env };
      env.GIT_CONFIG_GLOBAL = '/dev/null';
      env.GIT_CONFIG_SYSTEM = '/dev/null';
      delete env.GIT_AUTHOR_NAME;
      delete env.GIT_AUTHOR_EMAIL;
      delete env.GIT_COMMITTER_NAME;
      delete env.GIT_COMMITTER_EMAIL;

      const result = spawnSync(
        'node',
        [
          join(process.cwd(), 'src/cli.js'),
          'create',
          noIdProject,
          '-y',
          '-admin-email',
          'test@e2e.local',
          '-admin-password',
          'testpass123',
          '-skip-lockfile',
        ],
        { cwd: tempDir, encoding: 'utf-8', timeout: 60000, env },
      );
      if (result.status !== 0) {
        throw new Error(`create failed: ${result.stderr || result.stdout}`);
      }
    }, 60000);

    it('still produces the initial commit, authored by the vibecarbon fallback', () => {
      const noIdEnv = {
        ...gitScrubbedEnv(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      };
      const count = execSync('git rev-list --count HEAD', {
        cwd: projectDir(),
        encoding: 'utf-8',
        env: noIdEnv,
      }).trim();
      expect(count).toBe('1');

      // Quote the format: the literal `<` / `>` would otherwise be parsed as
      // shell redirects by execSync's /bin/sh.
      const author = execSync('git log -1 "--format=%an <%ae>"', {
        cwd: projectDir(),
        encoding: 'utf-8',
        env: noIdEnv,
      }).trim();
      expect(author).toBe('vibecarbon <vibecarbon@users.noreply.github.com>');
    });
  });

  describe('package manager selection', () => {
    // These tests only assert the `packageManager` field — they don't
    // exercise the lockfile-gen step, so we pass `-skip-lockfile` to
    // sidestep `bun install` (bun has no `--lockfile-only` mode and a
    // full registry install dominated wall-time, occasionally blowing
    // past 240s under parallel-suite contention). Each test now runs
    // in a couple of seconds; 60s is a generous ceiling.
    const PM_CREATE_TIMEOUT = 60000;

    it(
      'creates project with -pm npm and pins nothing (npm ships with Node)',
      () => {
        const npmProject = 'test-e2e-npm';
        execSync(
          `node ${join(process.cwd(), 'src/cli.js')} create ${npmProject} -y -admin-email test@e2e.local -admin-password testpass123 -pm npm -skip-lockfile`,
          {
            cwd: tempDir,
            encoding: 'utf-8',
            timeout: PM_CREATE_TIMEOUT,
          },
        );

        const pkg = JSON.parse(readFileSync(join(tempDir, npmProject, 'package.json'), 'utf-8'));
        // A `packageManager` pin would route the project through corepack,
        // reintroducing the extra install step the npm default removes.
        expect(pkg.packageManager).toBeUndefined();
        expect(pkg.scripts.build).toBe('npm run build:client && npm run build:server');
      },
      PM_CREATE_TIMEOUT,
    );

    it(
      'creates project with -pm pnpm and sets correct packageManager field',
      () => {
        const pnpmProject = 'test-e2e-pnpm';
        execSync(
          `node ${join(process.cwd(), 'src/cli.js')} create ${pnpmProject} -y -admin-email test@e2e.local -admin-password testpass123 -pm pnpm -skip-lockfile`,
          {
            cwd: tempDir,
            encoding: 'utf-8',
            timeout: PM_CREATE_TIMEOUT,
          },
        );

        const pkg = JSON.parse(readFileSync(join(tempDir, pnpmProject, 'package.json'), 'utf-8'));
        // pnpm has to be installed, so it does get pinned — and the template's
        // `npm run` script chains are rewritten for it.
        expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/);
        expect(pkg.scripts.build).toBe('pnpm build:client && pnpm build:server');
      },
      PM_CREATE_TIMEOUT,
    );

    it(
      'creates project with -pm bun and sets correct packageManager field',
      () => {
        const bunProject = 'test-e2e-bun';
        execSync(
          `node ${join(process.cwd(), 'src/cli.js')} create ${bunProject} -y -admin-email test@e2e.local -admin-password testpass123 -pm bun -skip-lockfile`,
          {
            cwd: tempDir,
            encoding: 'utf-8',
            timeout: PM_CREATE_TIMEOUT,
          },
        );

        const pkg = JSON.parse(readFileSync(join(tempDir, bunProject, 'package.json'), 'utf-8'));
        // Uses bun if installed; falls back to npm in non-interactive mode,
        // and the npm path pins nothing.
        if (pkg.packageManager === undefined) {
          expect(pkg.scripts.build).toBe('npm run build:client && npm run build:server');
        } else {
          expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+/);
          expect(pkg.scripts.build).toBe('bun run build:client && bun run build:server');
        }
      },
      PM_CREATE_TIMEOUT,
    );
  });

  describe('CLI flags behavior', () => {
    it('generates all required security secrets in .env.local', () => {
      const secretsProject = 'test-e2e-secrets';
      execSync(
        `node ${join(process.cwd(), 'src/cli.js')} create ${secretsProject} -y -admin-email test@e2e.local -admin-password testpass123 -skip-lockfile`,
        {
          cwd: tempDir,
          encoding: 'utf-8',
          timeout: 60000,
        },
      );

      const envLocal = readFileSync(join(tempDir, secretsProject, '.env.local'), 'utf-8');

      // All required secrets should be present and non-empty.
      // User-supplied secrets (ADMIN_PASSWORD, REPL_PASSWORD) are POSIX-single-quoted
      // by escapeDotenv so hostile characters round-trip safely; machine-generated
      // secrets stay double-quoted — match either.
      expect(envLocal).toMatch(/SUPABASE_ANON_KEY="[^"]+"/);
      expect(envLocal).toMatch(/SUPABASE_SERVICE_ROLE_KEY="[^"]+"/);
      expect(envLocal).toMatch(/JWT_SECRET="[^"]+"/);
      expect(envLocal).toMatch(/DB_PASSWORD="[^"]+"/);
      expect(envLocal).toMatch(/ADMIN_PASSWORD=(?:"[^"]+"|'[^']+')/);

      // Secrets should be unique (not placeholders)
      const anonKeyMatch = envLocal.match(/SUPABASE_ANON_KEY="([^"]+)"/);
      const serviceKeyMatch = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/);
      expect(anonKeyMatch?.[1]).not.toBe(serviceKeyMatch?.[1]);
    }, 60000);

    it('-display-name overrides the derived display name', () => {
      const displayProject = 'test-e2e-display';
      execSync(
        `node ${join(process.cwd(), 'src/cli.js')} create ${displayProject} -y -admin-email test@e2e.local -admin-password testpass123 -skip-lockfile -display-name "Acme Cloud"`,
        {
          cwd: tempDir,
          encoding: 'utf-8',
          timeout: 60000,
        },
      );

      const html = readFileSync(join(tempDir, displayProject, 'src/client/index.html'), 'utf-8');
      expect(html).toContain('<title>Acme Cloud</title>');
      const envLocal = readFileSync(join(tempDir, displayProject, '.env.local'), 'utf-8');
      expect(envLocal).toMatch(/^PROJECT_DISPLAY_NAME='Acme Cloud'$/m);
      // Machine slug is untouched by the display name
      expect(envLocal).toMatch(/^PROJECT_NAME="test-e2e-display"$/m);
    }, 60000);
  });
});
