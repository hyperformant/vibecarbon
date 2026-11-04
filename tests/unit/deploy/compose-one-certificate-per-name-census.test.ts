/**
 * FAMILY CENSUS: one certificate per name on compose.
 *
 * The k8s member of this class (the observability add-on's grafana-tls for
 * the app domain, see one-certificate-per-name-census.test.ts) let Traefik
 * serve either of two certificates for one name. On compose the same shape
 * is a router with its own `tls.certresolver`: Traefik's ACME resolver then
 * orders a certificate for that router's Host() on top of the default store
 * certificate (renderTraefikDefaultCert in src/lib/deploy/bundle.js), which
 * already covers every enabled add-on subdomain (its names are explicit, so
 * HTTP-01 can validate each). Two certificates for grafana.${DOMAIN}, and
 * a second ACME order per add-on on every fresh server.
 *
 * The rule: the app's apex router is the only router with a resolver (the
 * apex is deliberately outside the default store certificate, see the comment
 * on that router). Every other HTTPS router is `tls=true` and takes the
 * default store certificate by SNI.
 *
 * Walks every compose file under carbon/ and services/<name>/compose/; nothing
 * is listed by hand.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const composeFiles = [
  ...readdirSync(join(ROOT, 'carbon'))
    .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
    .map((f) => join('carbon', f)),
  ...readdirSync(join(ROOT, 'services'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'services', e.name, 'compose')))
    .flatMap((e) =>
      readdirSync(join(ROOT, 'services', e.name, 'compose'))
        .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
        .map((f) => join('services', e.name, 'compose', f)),
    ),
];

type Router = { file: string; service: string; name: string; labels: Map<string, string> };

// Template placeholders ({{PROJECT_NAME}}) are not valid unquoted YAML, and
// Compose's merge tags (`!reset`, `!override`) are not YAML core.
const readYamlText = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\{\{[^}]*\}\}/g, 'x')
    .replace(/!(reset|override)\b/g, '');

function routers(): Router[] {
  const out: Router[] = [];
  for (const file of composeFiles) {
    const doc = load(readYamlText(join(ROOT, file))) as {
      services?: Record<string, { labels?: string[] | Record<string, string> }>;
    };
    for (const [service, def] of Object.entries(doc?.services ?? {})) {
      const raw = def?.labels ?? [];
      const pairs: [string, string][] = Array.isArray(raw)
        ? raw.map((l) => {
            const at = String(l).indexOf('=');
            return [String(l).slice(0, at), String(l).slice(at + 1)];
          })
        : Object.entries(raw);
      const byRouter = new Map<string, Map<string, string>>();
      for (const [k, v] of pairs) {
        const m = /^traefik\.http\.routers\.([^.]+)\.(.+)$/.exec(k);
        if (!m) continue;
        if (!byRouter.has(m[1])) byRouter.set(m[1], new Map());
        byRouter.get(m[1])?.set(m[2], v);
      }
      for (const [name, labels] of byRouter) out.push({ file, service, name, labels });
    }
  }
  return out;
}

const all = routers();

describe('one certificate per name (compose)', () => {
  it('walks the base and the add-on compose files', () => {
    expect(composeFiles).toContain('carbon/docker-compose.prod.yml');
    expect(composeFiles.some((f) => f.startsWith('services/observability/'))).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });

  it("only the app's apex router orders its own certificate", () => {
    const withResolver = all
      .filter((r) => r.labels.has('tls.certresolver'))
      .map((r) => `${r.file}: ${r.service}/${r.name}`);
    expect(withResolver).toEqual(['carbon/docker-compose.prod.yml: app/app']);
  });

  it('every other HTTPS router takes the default store certificate (tls=true)', () => {
    const offenders = all
      .filter((r) => r.labels.get('entrypoints') === 'websecure')
      .filter((r) => r.labels.get('tls') !== 'true')
      .map((r) => `${r.file}: ${r.service}/${r.name}`);
    expect(offenders).toEqual([]);
  });
});
