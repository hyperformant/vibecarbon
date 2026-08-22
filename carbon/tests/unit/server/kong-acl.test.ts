import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The server's user-context Supabase clients authenticate to Kong with the
// ANON key (see supabase-client.test.ts — fail-safe RLS design). Kong's ACL
// must therefore admit the anon consumer on every route those clients hit,
// or every authenticated user-context query fails 403 before reaching
// PostgREST. Row security is enforced by RLS from the Authorization JWT, not
// by Kong's consumer ACL.

interface KongPlugin {
  name: string;
  config?: { allow?: string[] };
}

interface KongService {
  name: string;
  routes?: unknown[];
  plugins?: KongPlugin[];
}

const kongConfig = parse(
  readFileSync(join(__dirname, '../../../volumes/kong/kong.yml'), 'utf-8')
) as { services: KongService[]; acls: { consumer: string; group: string }[] };

function aclAllowList(serviceName: string): string[] {
  const service = kongConfig.services.find((s) => s.name === serviceName);
  expect(service, `service ${serviceName} exists in kong.yml`).toBeDefined();
  const acl = service?.plugins?.find((p) => p.name === 'acl');
  expect(acl?.config?.allow, `service ${serviceName} has an ACL allow list`).toBeDefined();
  return acl?.config?.allow ?? [];
}

describe('kong.yml ACLs', () => {
  it('maps the anon consumer to the anon group', () => {
    expect(kongConfig.acls).toContainEqual({ consumer: 'anon', group: 'anon' });
  });

  it('SECURITY/AVAILABILITY: rest-v1 admits the anon consumer (user-context clients use the anon apikey)', () => {
    const allow = aclAllowList('rest-v1');
    expect(allow).toContain('anon');
    expect(allow).toContain('admin');
  });

  it('auth-v1 admits the anon consumer (login/signup happen pre-auth)', () => {
    const allow = aclAllowList('auth-v1');
    expect(allow).toContain('anon');
  });
});
