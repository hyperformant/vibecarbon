import { describe, expect, it } from 'vitest';
import { buildDbHostPortPatch } from '../../../src/lib/deploy/k8s/ha/index.js';
import { REPL_PORT } from '../../../src/lib/deploy/replication.js';

describe('buildDbHostPortPatch', () => {
  it('adds hostPort 5433 (REPL_PORT) to the postgres containerPort 5432', () => {
    const patch = buildDbHostPortPatch();
    const container = patch.spec.template.spec.containers[0];
    expect(container.name).toBe('supabase-db');
    const port = container.ports.find((p: { containerPort: number }) => p.containerPort === 5432);
    expect(port).toBeDefined();
    expect(port.hostPort).toBe(5433);
    expect(port.hostPort).toBe(REPL_PORT);
  });

  it('is a strategic-merge shape (spec.template.spec.containers)', () => {
    const patch = buildDbHostPortPatch();
    expect(Array.isArray(patch.spec.template.spec.containers)).toBe(true);
    // Only the container name + the single port entry — a minimal strategic
    // patch that updates the existing port in place, not a full container spec.
    expect(patch.spec.template.spec.containers).toHaveLength(1);
    expect(patch.spec.template.spec.containers[0].ports).toHaveLength(1);
  });
});
