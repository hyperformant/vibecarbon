import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateEnvLocal, PLACEHOLDERS, TEMPLATE_DIR } from '../../../src/create.js';
import { getFilePolicy } from '../../../src/lib/upgrade-policy.js';

const baseVariables = {
  PROJECT_NAME: 'my-cool-app',
  PROJECT_DISPLAY_NAME: 'My Cool App',
  DB_PASSWORD: 'db-pass',
  JWT_SECRET: 'jwt-secret',
  ANON_KEY: 'anon-key',
  SERVICE_ROLE_KEY: 'service-role-key',
  REALTIME_SECRET: 'realtime-secret',
  LOGFLARE_API_KEY: 'logflare-key',
  VAULT_ENC_KEY: 'vault-enc-key',
  PG_META_CRYPTO_KEY: 'pg-meta-key',
  DB_ENC_KEY: 'db-enc-key',
  REPL_PASSWORD: 'repl-pass',
  SITE_URL: 'http://localhost:5173',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'admin-pass',
  ADMIN_PASSWORD_HASH: '',
};

describe('PROJECT_DISPLAY_NAME placeholder', () => {
  it('is registered for creation-time substitution', () => {
    expect(PLACEHOLDERS.PROJECT_DISPLAY_NAME).toBe('{{PROJECT_DISPLAY_NAME}}');
  });
});

describe('generateEnvLocal display name', () => {
  it('records PROJECT_DISPLAY_NAME so upgrade can reconstruct it', () => {
    const env = generateEnvLocal('my-cool-app', baseVariables);
    expect(env).toMatch(/^PROJECT_DISPLAY_NAME='My Cool App'$/m);
  });

  it('uses the display name, not the slug, as the SMTP sender name', () => {
    const env = generateEnvLocal('my-cool-app', baseVariables);
    expect(env).toMatch(/^SMTP_SENDER_NAME='My Cool App'$/m);
    expect(env).not.toMatch(/SMTP_SENDER_NAME="my-cool-app"/);
  });
});

describe('upgrade-managed files never carry {{PROJECT_DISPLAY_NAME}}', () => {
  // Upgrade re-substitutes placeholders into safe/merge files using values
  // reconstructed from the project's .env.local. Legacy projects have no
  // PROJECT_DISPLAY_NAME recorded there, so the value comes from the
  // titleize fallback (resolveDisplayName) — fine for display, but nothing
  // end-to-end exercises delivering this placeholder through upgrade today.
  // If you add {{PROJECT_DISPLAY_NAME}} to an upgrade-managed template file,
  // this test forces you to add that end-to-end legacy-upgrade coverage.
  it('no safe/merge template file contains the placeholder', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(full);
          continue;
        }
        const rel = relative(TEMPLATE_DIR, full);
        if (getFilePolicy(rel) === 'never') continue;
        let content: string;
        try {
          content = readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        if (content.includes('{{PROJECT_DISPLAY_NAME}}')) offenders.push(rel);
      }
    };
    walk(TEMPLATE_DIR);
    expect(offenders).toEqual([]);
  });
});
