import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RCA 2026-07-17: two vibecarbon dev stacks on one machine (my-app + swim2)
 * cross-contaminated — each project's traefik watches the whole docker
 * socket, adopted BOTH projects' identically-labeled services as backends of
 * one load balancer, and round-robined onto cross-network (unreachable) IPs
 * → intermittent Gateway Timeouts on every stack. The docker provider must
 * be constrained to the stack's own compose project.
 */
describe('compose template: traefik discovery is project-scoped', () => {
  it('constrains the docker provider to this compose project', () => {
    const compose = readFileSync(join(process.cwd(), 'carbon/docker-compose.yml'), 'utf-8');
    expect(compose).toMatch(
      /--providers\.docker\.constraints=Label\(`com\.docker\.compose\.project`,`\$\{PROJECT_NAME\}`\)/,
    );
  });
});
