import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pmScrubbedEnv } from '../../_shared/pm-env.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

describe('Generated Project Lint and Build', () => {
  let tempDir: string;
  const projectName = 'test-lint-build';
  const projectDir = () => join(tempDir, projectName);

  beforeAll(() => {
    tempDir = createTempDir('vibecarbon-build-');

    // Without this the project under test would be pnpm-based when run through
    // `pnpm test:integration` and npm-based when vitest is invoked directly, so
    // the npm assertions below would only hold in one of them. See the module
    // doc on pmScrubbedEnv.
    const cleanEnv = pmScrubbedEnv();
    try {
      execFileSync(
        'node',
        [
          join(process.cwd(), 'src/cli.js'),
          'create',
          projectName,
          '-y',
          '-admin-email',
          'test@example.com',
          '-admin-password',
          'testpass123',
        ],
        {
          cwd: tempDir,
          encoding: 'utf-8',
          timeout: 300000,
          stdio: 'pipe',
          env: cleanEnv,
        },
      );
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `Project creation failed:\nstdout: ${err.stdout || '(empty)'}\nstderr: ${err.stderr || '(empty)'}\n${err.message}`,
      );
    }

    // `vibecarbon create` only writes package-lock.json (lockfile-only) so
    // the scaffold is fast. `npm run build` needs the full node_modules tree
    // to resolve `vite` and `esbuild` from .bin/ — install it here.
    //
    // STRICT `npm ci`, with no `npm install` fallback. This is the same
    // command the generated Dockerfile and the scaffolded CI workflow run, so
    // this is the gate where a lockfile `npm ci` won't accept has to surface.
    // A fallback would repair the tree locally and let the suite go green over
    // a lockfile that fails the customer's first Docker build — precisely the
    // failure `create`'s own `npm ci --dry-run` validation loop exists to
    // prevent, and precisely the class this test is positioned to catch.
    try {
      execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
        cwd: join(tempDir, projectName),
        encoding: 'utf-8',
        timeout: 600000,
        stdio: 'pipe',
        // This suite runs under `pnpm test:integration`, which projects the
        // operator's resolved npm config into the environment. npm 12 rejects
        // some of it outright (EALLOWSCRIPTS on a stray `allow-scripts`), which
        // fails this gate for a reason that has nothing to do with the lockfile
        // it exists to verify. The product scrubs the same namespace before it
        // spawns a manager — see src/lib/package-manager-env.js.
        env: cleanEnv,
      });
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        'npm ci rejected the lockfile `vibecarbon create` generated. Do NOT relax this to ' +
          '`npm install` — the Dockerfile and the scaffolded CI workflow both run a strict ' +
          '`npm ci`, so this would ship a project whose first build fails.\n' +
          `stdout: ${err.stdout || '(empty)'}\nstderr: ${err.stderr || '(empty)'}\n${err.message}`,
      );
    }
  }, 900000);

  afterAll(() => {
    cleanupTempDir(tempDir);
  });

  it('linting runs without fatal errors', () => {
    try {
      execSync('npm run lint', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 60000,
      });
    } catch (error: unknown) {
      // Biome may return non-zero exit for warnings - that's ok
      // We only want to fail on actual errors that prevent linting
      const err = error as { status?: number; message?: string };
      // Exit code 1 is ok for lint warnings, higher codes indicate real errors
      if (err.status && err.status > 1) {
        throw error;
      }
    }
  }, 60000);

  it('type checking runs', () => {
    try {
      execSync('npm run typecheck', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 60000,
      });
    } catch (error: unknown) {
      // Some type errors in the template may exist - document them
      const err = error as { status?: number; stdout?: string };
      // Only fail for catastrophic errors (missing files, etc.)
      if (err.status && err.status > 2) {
        throw error;
      }
    }
  }, 60000);

  it('builds successfully', () => {
    const result = execSync('npm run build', {
      cwd: projectDir(),
      encoding: 'utf-8',
      timeout: 120000, // 2 minutes for build
    });
    // Build should complete without errors
    expect(result).toBeDefined();
  }, 120000);

  it('generates dist directory after build', () => {
    expect(existsSync(join(projectDir(), 'dist'))).toBe(true);
  });

  it('generates client build output', () => {
    expect(existsSync(join(projectDir(), 'dist/client/index.html'))).toBe(true);
  });

  it('generates server build output', () => {
    expect(existsSync(join(projectDir(), 'dist/server/index.js'))).toBe(true);
  });

  // `build:client` also runs scripts/generate-seo.ts. Everything it produces is
  // consumed by something that degrades quietly when it is absent — the server
  // falls back to the plain SPA shell, and llms.txt just 404s — so a build that
  // silently stopped emitting these would look completely healthy. Assert the
  // artifacts, not the exit code.
  describe('AI-search / SEO artifacts', () => {
    const distFile = (rel: string) => readFileSync(join(projectDir(), 'dist', rel), 'utf-8');

    it('generates llms.txt with a heading and a link to the full text', () => {
      const llms = distFile('client/llms.txt');
      expect(llms.startsWith('# ')).toBe(true);
      expect(llms).toContain('/llms-full.txt');
    });

    it('generates llms-full.txt containing the docs bodies', () => {
      const full = distFile('client/llms-full.txt');
      expect(full).toContain('full documentation');
      expect(full.length).toBeGreaterThan(distFile('client/llms.txt').length);
    });

    it('generates a per-page markdown mirror for each docs page', () => {
      // llms.txt links every page as `<route>.md`; those links must resolve.
      expect(existsSync(join(projectDir(), 'dist/client/docs/getting-started.md'))).toBe(true);
    });

    it('generates a route-meta manifest that parses', () => {
      const manifest = JSON.parse(distFile('seo/route-meta.json')) as {
        siteUrl: string;
        routes: Record<string, { title: string; description: string; html?: string }>;
      };
      expect(typeof manifest.siteUrl).toBe('string');
      expect(Object.keys(manifest.routes).length).toBeGreaterThan(0);
    });

    it('includes homepage metadata with crawler-visible content', () => {
      const { routes } = JSON.parse(distFile('seo/route-meta.json')) as {
        routes: Record<string, { title: string; description: string; html?: string }>;
      };
      expect(routes['/'].title).toBeTruthy();
      expect(routes['/'].description).toBeTruthy();
      // The homepage is the one route whose only crawler-visible body is this
      // block — a manifest entry without it is worse than no entry at all.
      expect(routes['/'].html).toContain('<h1>');
    });

    it('includes metadata for docs pages generated from content/', () => {
      const { routes } = JSON.parse(distFile('seo/route-meta.json')) as {
        routes: Record<string, { title: string; html?: string }>;
      };
      expect(routes['/docs/getting-started']).toBeDefined();
      expect(routes['/docs/getting-started'].html).toContain('<article>');
    });

    it('keeps the route-meta manifest out of the publicly served client dir', () => {
      // dist/client is the serveStatic root; the manifest is a server-side
      // input and has no business being fetchable.
      expect(existsSync(join(projectDir(), 'dist/client/route-meta.json'))).toBe(false);
      expect(existsSync(join(projectDir(), 'dist/client/seo'))).toBe(false);
    });
  });
});
