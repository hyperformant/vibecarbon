import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard: `ports: []` DOES NOT clear an inherited port publication.
//
// Compose merges the `ports` sequence across `-f` files by CONCATENATION, so an
// empty list contributes nothing and every entry from the base file survives.
// Seven overlay sites relied on the opposite, each with a comment claiming it
// dropped the host port. The most consequential was the (since removed) API
// gateway: `docker compose -f docker-compose.yml -f docker-compose.prod.yml`
// (the exact pair deployCompose uses — src/lib/deploy/compose/index.js) still
// published it unauthenticated on host 8000/8443, bypassing Traefik and TLS
// entirely. Only the cloud firewall's 22/80/443 allowlist stopped external
// reach — and `vibecarbon scale` creates its replacement server with no
// firewall at all, so on a scaled host it was reachable.
//
// `!reset null` is the Compose tag that genuinely removes an inherited key.
// The prod overlay already used it for `build`, which is how we know the
// authors had the right tool and reached for the wrong one.
//
// Verified empirically against Compose v5.3.1 before this guard was written:
//   base(8000,8443) + `ports: []`         -> both publications survive
//   base(8000,8443) + `ports: !reset null` -> the ports key is gone
//
// This guard is a CALL-SITE SWEEP, not a pin on the seven known files: it
// discovers every compose file in the repo, so a new overlay written next month
// with `ports: []` fails here rather than silently publishing to the host.
// (docs/tests.md, class 1 — "where the operation has a greppable wire
// signature, write a repo-wide sweep; those catch new bypassing call sites".)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every docker-compose file we ship, from both template roots. */
function composeFiles(): string[] {
  const roots = [join(repoRoot, 'carbon'), join(repoRoot, 'services')];
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Root absent (e.g. a partial checkout) — other roots still sweep.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (/^docker-compose[\w.-]*\.ya?ml$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}

/** Overlay sites that deliberately drop an inherited publication. */
const RESET_SITES = [
  { file: 'services/observability/compose/docker-compose.prod.yml', service: 'grafana' },
  { file: 'services/observability/compose/docker-compose.prod.yml', service: 'prometheus' },
  { file: 'services/observability/compose/docker-compose.prod.yml', service: 'loki' },
  { file: 'services/n8n/compose/docker-compose.prod.yml', service: 'n8n' },
  { file: 'services/redis/compose/docker-compose.prod.yml', service: 'redis' },
  { file: 'services/metabase/compose/docker-compose.prod.yml', service: 'metabase' },
];

/**
 * Base publications each reset above is there to remove. If a base ever stops
 * publishing, the paired reset is dead weight and this table should shrink with
 * it — that keeps the guard from asserting something vacuous.
 *
 * grafana is deliberately absent: the observability base publishes prometheus
 * and loki but never grafana, so grafana's reset is defensive only.
 */
const LOAD_BEARING_BASE_PUBLICATIONS = [
  {
    file: 'services/observability/compose/docker-compose.yml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose ${VAR:-default} placeholders
    published: ['${DEV_PROMETHEUS_PORT:-9190}:9090', '${DEV_LOKI_PORT:-3100}:3100'],
  },
  { file: 'services/n8n/compose/docker-compose.yml', published: ['5678:5678'] },
  { file: 'services/redis/compose/docker-compose.yml', published: ['6379:6379'] },
  { file: 'services/metabase/compose/docker-compose.yml', published: ['3001:3000'] },
];

describe('compose overlays clear inherited port publications with !reset, never []', () => {
  it('no compose file uses `ports: []` (it concatenates, it does not clear)', () => {
    const offenders: string[] = [];
    for (const file of composeFiles()) {
      const content = readFileSync(file, 'utf-8');
      content.split('\n').forEach((line, i) => {
        // Matches `ports: []` and `ports:  [ ]`, with or without a trailing comment.
        if (/^\s*ports:\s*\[\s*\]\s*(#.*)?$/.test(line)) {
          offenders.push(`${relative(repoRoot, file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `\`ports: []\` does not remove an inherited publication — Compose concatenates the ` +
        `sequence across -f files, so the base file's ports survive into production. ` +
        `Use \`ports: !reset null\` instead. Offending sites:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every deliberate un-publish site uses `!reset null`', () => {
    for (const { file, service } of RESET_SITES) {
      const content = readFileSync(join(repoRoot, file), 'utf-8');
      // The service block runs to the next same-or-shallower-indent service key.
      const block = content.split(new RegExp(`^  ${service}:\\s*$`, 'm'))[1];
      expect(block, `${file} no longer defines a \`${service}\` service`).toBeDefined();
      const untilNextService = block.split(/\n {2}\w[\w-]*:\s*$/m)[0];
      expect(
        untilNextService,
        `${file} service \`${service}\` must clear its inherited ports with \`!reset null\``,
      ).toMatch(/ports:\s*!reset\s+null/);
    }
  });

  it('each reset still has a base publication to remove (guard is not vacuous)', () => {
    for (const { file, published } of LOAD_BEARING_BASE_PUBLICATIONS) {
      const content = readFileSync(join(repoRoot, file), 'utf-8');
      for (const mapping of published) {
        expect(
          content,
          `${file} no longer publishes ${mapping}; drop it from ` +
            'LOAD_BEARING_BASE_PUBLICATIONS (and re-check whether the paired reset is still needed)',
        ).toContain(mapping);
      }
    }
  });
});
