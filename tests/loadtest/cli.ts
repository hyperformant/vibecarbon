#!/usr/bin/env tsx

/**
 * Vibecarbon Performance Test Launcher
 *
 * Interactive CLI that discovers deployed environments from .vibecarbon.json,
 * prompts for selection, auto-fetches auth tokens, runs the performance test
 * suite against each target, and produces a side-by-side comparison.
 *
 * Usage:
 *   pnpm test:loadtest                              # from your vibecarbon project root
 *   pnpm test:loadtest --project-dir /path/to/app  # point at a different project
 *   pnpm test:loadtest --duration 30 --connections 20
 *
 * Skip the discovery flow by setting PERF_BASE_URL directly (backwards-compat):
 *   PERF_BASE_URL=http://localhost:8000 pnpm test:loadtest
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, confirm, intro, isCancel, log, multiselect, outro, spinner } from '@clack/prompts';
import { compare } from './compare.js';

// ── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, 'results');

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnvConfig {
  status?: string;
  region?: string;
  secondaryRegion?: string;
  serverType?: string;
  domain?: string | null;
  servers?: Array<{ name: string; ip: string; region: string }>;
  deployedAt?: string;
  ha?: { enabled?: boolean };
  services?: Record<string, boolean>;
}

interface VibecarbonConfig {
  projectName?: string;
  environments?: Record<string, EnvConfig>;
}

interface RunTarget {
  id: string; // used as PERF_LABEL base
  label: string; // display name
  baseUrl: string;
  envVars: Record<string, string>;
}

interface RunRecord {
  target: RunTarget;
  files: string[]; // result JSON paths written during this run
}

// ── Argument parsing ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const projectDir = resolve(getArg('--project-dir') ?? getArg('-p') ?? process.cwd());
const durationArg = getArg('--duration') ?? getArg('-d');
const connectionsArg = getArg('--connections') ?? getArg('-c');

// ── Config helpers ────────────────────────────────────────────────────────────

function loadVibecarbonConfig(): VibecarbonConfig | null {
  const p = join(projectDir, '.vibecarbon.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as VibecarbonConfig;
  } catch {
    return null;
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    // Match KEY="value" or KEY=value
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?([^"'\n]*)["']?/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadProjectEnv(): Record<string, string> {
  const base = parseEnvFile(join(projectDir, '.env'));
  const local = parseEnvFile(join(projectDir, '.env.local'));
  return { ...base, ...local }; // .env.local wins
}

// ── Token fetching ────────────────────────────────────────────────────────────

async function fetchJwt(
  baseUrl: string,
  email: string,
  password: string,
  anonKey: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

// ── URL resolution ────────────────────────────────────────────────────────────

function resolveBaseUrl(env: EnvConfig): string | null {
  if (env.domain) return `https://${env.domain}`;
  const ip = env.servers?.[0]?.ip;
  if (ip) return `http://${ip}`;
  return null;
}

function envLabel(name: string, env: EnvConfig): string {
  const parts = [name];
  if (env.serverType) parts.push(env.serverType);
  if (env.region) parts.push(env.region);
  if (env.ha?.enabled) parts.push('ha');
  return parts.join('-');
}

function relativeDate(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

// ── Result file tracking ──────────────────────────────────────────────────────

function listResultFiles(): Set<string> {
  if (!existsSync(RESULTS_DIR)) return new Set();
  return new Set(readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')));
}

function newResultFiles(before: Set<string>): string[] {
  const after = listResultFiles();
  return [...after].filter((f) => !before.has(f)).map((f) => join(RESULTS_DIR, f));
}

// ── vitest runner ─────────────────────────────────────────────────────────────

function runVitest(extraEnv: Record<string, string>): number {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...extraEnv,
    FORCE_COLOR: '1',
  };
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'loadtest'], {
    env,
    stdio: 'inherit',
    cwd: resolve(__dirname, '../..'), // repo root
  });
  return result.status ?? 1;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Backwards compat: if PERF_BASE_URL already set, just run vitest ──────
  if (process.env.PERF_BASE_URL) {
    log.info(`Using PERF_BASE_URL=${process.env.PERF_BASE_URL}`);
    const code = runVitest({});
    process.exit(code);
  }

  intro('Vibecarbon Performance Tests');

  // ── Load project config ───────────────────────────────────────────────────
  const config = loadVibecarbonConfig();
  const projectEnv = loadProjectEnv();

  const duration = durationArg ?? process.env.PERF_DURATION ?? '10';
  const connections = connectionsArg ?? process.env.PERF_CONNECTIONS ?? '10';

  // ── Build list of available targets ──────────────────────────────────────
  type TargetOption = { value: string; label: string; hint: string; config?: EnvConfig };
  const options: TargetOption[] = [];

  // Deployed environments from .vibecarbon.json
  if (config?.environments) {
    for (const [name, env] of Object.entries(config.environments)) {
      if (env.status !== 'deployed') continue;
      const baseUrl = resolveBaseUrl(env);
      if (!baseUrl) continue;

      const badges = [
        env.serverType,
        env.region,
        env.ha?.enabled ? 'HA' : null,
        env.secondaryRegion ? `+ ${env.secondaryRegion}` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const services = Object.entries(env.services ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');

      const hint = [
        baseUrl,
        badges,
        services ? `[${services}]` : null,
        relativeDate(env.deployedAt),
      ]
        .filter(Boolean)
        .join('  ');

      options.push({ value: name, label: name, hint, config: env });
    }
  }

  // Local Docker option — if docker-compose.yml exists in project dir
  const localUrl = 'http://localhost:8000';
  if (existsSync(join(projectDir, 'docker-compose.yml'))) {
    options.push({
      value: '__local__',
      label: 'Local Docker',
      hint: `${localUrl}  (docker-compose)`,
    });
  }

  if (options.length === 0) {
    log.error('No targets found.');
    log.info(
      config
        ? 'No environments with status "deployed" found in .vibecarbon.json.\n  Run: vibecarbon deploy -e <env>'
        : `No .vibecarbon.json found in ${projectDir}.\n  Run from your project root or use --project-dir <path>`,
    );
    cancel('');
    process.exit(1);
  }

  // ── Environment selection ─────────────────────────────────────────────────
  let selectedIds: string[];

  if (options.length === 1) {
    selectedIds = [options[0].value];
    log.step(`Testing: ${options[0].label}  ${options[0].hint}`);
  } else {
    const selection = await multiselect({
      message: 'Select environments to test  (space = toggle, enter = confirm)',
      options: options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
      required: true,
    });
    if (isCancel(selection)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    selectedIds = selection as string[];
  }

  log.info(`Duration: ${duration}s per scenario · Connections: ${connections} concurrent`);
  log.info('');

  // ── Credential lookup ─────────────────────────────────────────────────────
  const anonKey = projectEnv.SUPABASE_ANON_KEY ?? projectEnv.VITE_SUPABASE_ANON_KEY ?? '';
  const adminEmail = projectEnv.ADMIN_EMAIL ?? '';
  const adminPassword = projectEnv.ADMIN_PASSWORD ?? '';

  // ── Run each target ───────────────────────────────────────────────────────
  const runs: RunRecord[] = [];

  for (const id of selectedIds) {
    // biome-ignore lint/style/noNonNullAssertion: selectedIds are filtered from options, always defined
    const opt = options.find((o) => o.value === id)!;
    // biome-ignore lint/style/noNonNullAssertion: opt.config exists for non-local envs; resolveBaseUrl returns non-null for valid configs
    const baseUrl = id === '__local__' ? localUrl : resolveBaseUrl(opt.config!)!;
    // biome-ignore lint/style/noNonNullAssertion: opt.config exists for non-local envs
    const label = id === '__local__' ? 'local' : envLabel(id, opt.config!);

    console.log('');
    log.step(`▶  ${opt.label}  (${baseUrl})`);

    // Fetch tokens
    const s = spinner();
    s.start('Fetching auth tokens…');

    let authToken = '';
    let adminToken = '';

    if (anonKey && adminEmail && adminPassword) {
      // Admin user is valid for both user-scoped and admin endpoints
      const token = await fetchJwt(baseUrl, adminEmail, adminPassword, anonKey);
      if (token) {
        authToken = token;
        adminToken = token;
        s.stop('Auth tokens obtained ✓');
      } else {
        s.stop('Could not fetch tokens — running public tests only');
      }
    } else {
      s.stop('No credentials in .env.local — running public tests only');
    }

    // Snapshot results dir before the run
    const beforeFiles = listResultFiles();

    // Build env for vitest
    const vitestEnv: Record<string, string> = {
      PERF_BASE_URL: baseUrl,
      PERF_LABEL: label,
      PERF_DURATION: duration,
      PERF_CONNECTIONS: connections,
    };
    if (authToken) vitestEnv.PERF_AUTH_TOKEN = authToken;
    if (adminToken) vitestEnv.PERF_ADMIN_TOKEN = adminToken;

    // Run vitest (streams output to terminal)
    const exitCode = runVitest(vitestEnv);

    // Collect newly written result files
    const written = newResultFiles(beforeFiles);
    runs.push({ target: { id, label, baseUrl, envVars: vitestEnv }, files: written });

    if (exitCode !== 0) {
      log.warn(`One or more tests for "${opt.label}" failed (see above).`);
    }
  }

  // ── Comparison ────────────────────────────────────────────────────────────
  if (runs.length >= 2) {
    console.log('');
    const shouldCompare = await confirm({
      message: `Show side-by-side comparison across ${runs.length} environments?`,
      initialValue: true,
    });

    if (!isCancel(shouldCompare) && shouldCompare) {
      const [baseline, ...candidates] = runs;

      for (const candidate of candidates) {
        // Match files by group suffix: -public.json, -authenticated.json, -admin.json
        for (const suffix of ['-public.json', '-authenticated.json', '-admin.json']) {
          const bFile = baseline.files.find((f) => f.endsWith(suffix));
          const cFile = candidate.files.find((f) => f.endsWith(suffix));
          if (!bFile || !cFile) continue;

          const group = suffix.slice(1, -5); // e.g. "public"
          console.log(
            `\n── ${baseline.target.label}  vs  ${candidate.target.label}  (${group}) ──`,
          );
          compare(bFile, cFile);
        }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  if (runs.length > 0) {
    const allFiles = runs.flatMap((r) => r.files);
    if (allFiles.length > 0) {
      log.info(
        `Results saved to tests/loadtest/results/ (${allFiles.length} file${allFiles.length > 1 ? 's' : ''})`,
      );
    }
  }

  outro('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
